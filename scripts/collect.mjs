// Collects FirstEnergy + Cleveland Public Power outage data and maintains a
// single shared data/state.json that the dashboard reads, so every visitor sees
// the same trends regardless of whether their browser was ever open.
// Triggered ~every 15 min. The storm history is reset ONLY on demand (run the
// workflow with reset=true, which sets RESET — archives the current storm and
// starts fresh). There is no automatic time-based reset.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const KB = "https://kubra.io";
const INSTANCE = "6c715f0e-bbec-465f-98cc-0b81623744be";
const VIEW     = "db9c3f02-0a06-4672-a357-0f676eb75bfa";
const NEO = new Set("CUYAHOGA LAKE GEAUGA ASHTABULA LORAIN MEDINA SUMMIT PORTAGE STARK WAYNE TRUMBULL MAHONING COLUMBIANA".split(" "));
const CPP_WEBMAP = "88719296c67e4874b0bdd2abd91658b2";
const CPP_FS0 = "https://services3.arcgis.com/dty2kHktVXHrqO8i/arcgis/rest/services/CPPFeederAreas_BufferXMBuff100v3/FeatureServer/0";

const STATE_PATH = "data/state.json";
const CAP_TOTAL = 1500, CAP_COUNTY = 1000, CAP_CITY = 96, MAX_CITIES = 300;
const RESET = /^(1|true|yes|on)$/i.test(process.env.RESET || "");   // manual reset flag

const centroid = b => (b && b.length === 4) ? [(b[1]+b[3])/2, (b[0]+b[2])/2] : null;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Look like a browser and retry — FirstEnergy's CDN (KUBRA) intermittently 403s
// requests from datacenter IPs / non-browser clients.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
async function jget(url, extraHeaders = {}){
  const headers = { "User-Agent": UA, "Accept": "application/json, text/plain, */*",
                    "Accept-Language": "en-US,en;q=0.9", ...extraHeaders };
  let lastErr;
  for(let attempt = 1; attempt <= 4; attempt++){
    try {
      const r = await fetch(url, { headers });
      if(r.ok) return await r.json();
      lastErr = new Error(url.split("/")[2] + " " + r.status);
      // retry on 403/429/5xx (transient/bot-protection); give up on other 4xx
      if(!(r.status === 403 || r.status === 429 || r.status >= 500)) break;
    } catch(e){ lastErr = e; }
    await sleep(700 * attempt + Math.random() * 400);
  }
  throw lastErr;
}
const KUBRA_HEADERS = { "Referer": "https://outages-oh.firstenergycorp.com/", "Origin": "https://outages-oh.firstenergycorp.com" };
const pushCapped = (arr, point, cap) => { arr.push(point); while(arr.length > cap) arr.shift(); return arr; };

async function fetchFE(){
  const cs = await jget(`${KB}/stormcenter/api/v1/stormcenters/${INSTANCE}/views/${VIEW}/currentState?preview=false`, KUBRA_HEADERS);
  const dataPath = cs.data.interval_generation_data, dep = cs.stormcenterDeploymentId;
  const conf = await jget(`${KB}/stormcenter/api/v1/stormcenters/${INSTANCE}/views/${VIEW}/configuration/${dep}?preview=false`, KUBRA_HEADERS);
  const reps = conf.config.reports.data.interval_generation_data;
  const src = (reps.find(r=>/report\.json$/i.test(r.source)) || reps[0]).source;
  const report = await jget(`${KB}/${dataPath}/${src}`, KUBRA_HEADERS);
  const st = report.file_data.areas[0];
  const counties = (st.areas||[]).map(c => ({
    name: c.name,
    out: (c.cust_a && typeof c.cust_a.val === "number") ? c.cust_a.val : 0,
    served: c.cust_s || 0, etr: c.etr || null, loc: centroid(c.gotoMap && c.gotoMap.bbox),
    subs: (c.areas||[]).map(s => ({
      id: s.areaId || (c.name+"|"+s.name), name: s.name,
      out: (s.cust_a && typeof s.cust_a.val === "number") ? s.cust_a.val : 0,
      served: s.cust_s || 0, etr: s.etr || null, loc: centroid(s.gotoMap && s.gotoMap.bbox)
    }))
  }));
  return { updatedAt: cs.updatedAt || Date.now(), counties };
}

async function fetchCPP(){
  const data = await jget(`https://www.arcgis.com/sharing/rest/content/items/${CPP_WEBMAP}/data?f=json`);
  const layer = (data.operationalLayers||[]).find(l=>/Approximate Outage/i.test(l.title||""));
  const expr  = (layer && layer.layerDefinition && layer.layerDefinition.definitionExpression) || "";
  const ids = [...new Set((expr.match(/'([^']*)'/g)||[]).map(s=>s.slice(1,-1).trim()).filter(Boolean))];
  let features = [];
  if(ids.length){
    const inList = ids.map(s=>`'${s.replace(/'/g,"''")}'`).join(",");
    const q = `where=${encodeURIComponent("FEEDER_ID1 IN ("+inList+")")}&outFields=SUBSTATION,FEEDER_ID1,COUNT_,Label_Count&returnGeometry=true&outSR=4326&f=geojson`;
    const gj = await jget(`${CPP_FS0}/query?${q}`);
    features = (gj.features||[]).filter(f=>f && f.geometry && f.properties);
  }
  let updatedAt = Date.now();
  try { const m = await jget(`https://www.arcgis.com/sharing/rest/content/items/${CPP_WEBMAP}?f=json`); if(m && m.modified) updatedAt = m.modified; } catch(e){}
  const accounts = features.reduce((s,f)=> s + (Number(f.properties.COUNT_)||0), 0);
  const feeders  = [...new Set(features.map(f=>String(f.properties.FEEDER_ID1||"").trim()).filter(Boolean))];
  return { updatedAt, accounts, feeders, features };
}

const FRESH = () => ({ peaks:{}, cppPeak:0, history:[], countyHistory:{}, cityHistory:{}, cppHistory:[], stormStartedAt:null, zeroSince:null });
function loadPrev(){
  try { return JSON.parse(readFileSync(STATE_PATH, "utf8")); }
  catch(e){ return FRESH(); }
}
// On-demand reset: archive the current storm, then start from a clean slate.
function resetState(prev){
  const has = (prev.history||[]).length || Object.keys(prev.countyHistory||{}).length || (prev.cppHistory||[]).length;
  if(has){
    try {
      mkdirSync("data/archive", { recursive: true });
      const stamp = prev.stormStartedAt || prev.collectedAt || Date.now();
      writeFileSync(`data/archive/storm-${new Date(stamp).toISOString().slice(0,10)}-${stamp}.json`,
        JSON.stringify({ stormStartedAt: prev.stormStartedAt||null, archivedAt: Date.now(),
          peaks: prev.peaks||{}, cppPeak: prev.cppPeak||0, history: prev.history||[],
          countyHistory: prev.countyHistory||{}, cppHistory: prev.cppHistory||[] }));
      console.log("reset: archived previous storm");
    } catch(e){ console.error("archive failed:", e.message); }
  }
  return FRESH();
}

(async () => {
  let prev = loadPrev();
  if(RESET){ prev = resetState(prev); console.log("manual reset requested — starting fresh"); }

  // FirstEnergy is required; if it fails, leave the last good state untouched.
  // Stay quiet on one-off blips (self-heals next cycle), but fail the run — which
  // triggers GitHub's automatic email — once data has been stale for a while.
  const STALE_ALERT_MIN = 90;
  let fe;
  try { fe = await fetchFE(); }
  catch(e){
    const lastGood = prev._feUpdatedAt || prev.collectedAt || 0;
    const ageMin = lastGood ? Math.round((Date.now() - lastGood) / 60000) : Infinity;
    console.error(`FE fetch failed (${e.message}); keeping previous state. Last good data ${ageMin} min ago.`);
    process.exit(ageMin > STALE_ALERT_MIN ? 1 : 0);
  }

  // CPP is optional; on failure reuse the last good CPP block.
  let cpp;
  try { cpp = await fetchCPP(); }
  catch(e){ console.error("CPP fetch failed, reusing previous:", e.message); cpp = null; }

  const now = Date.now();
  const cppBlock = cpp ? { updatedAt: cpp.updatedAt, accounts: cpp.accounts, feeders: cpp.feeders, features: cpp.features }
                       : (prev.cpp || { updatedAt: now, accounts: 0, feeders: [], features: [] });
  const neoOut = fe.counties.filter(c=>NEO.has(c.name)).reduce((s,c)=>s+c.out, 0);
  const cppOut = cppBlock.accounts || 0;
  const totalAll = neoOut + cppOut;

  // peaks (per county + per city, plus CPP)
  const peaks = { ...(prev.peaks||{}) };
  fe.counties.forEach(c => {
    if((peaks[c.name]||0) < c.out) peaks[c.name] = c.out;
    c.subs.forEach(s => { if((peaks[s.id]||0) < s.out) peaks[s.id] = s.out; });
  });
  let cppPeak = Math.max(prev.cppPeak||0, cppOut);

  // histories (append only when the underlying feed timestamp advanced)
  const history = [...(prev.history||[])];
  const countyHistory = structuredClone(prev.countyHistory||{});
  const cityHistory = structuredClone(prev.cityHistory||{});
  const cppHistory = [...(prev.cppHistory||[])];

  if(prev._feUpdatedAt !== fe.updatedAt){
    pushCapped(history, { t: fe.updatedAt, out: neoOut }, CAP_TOTAL);
    fe.counties.forEach(c => {
      if(c.out>0 || countyHistory[c.name]) pushCapped(countyHistory[c.name] = countyHistory[c.name]||[], { t: fe.updatedAt, out: c.out }, CAP_COUNTY);
      c.subs.forEach(s => { if(s.out>0 || cityHistory[s.id]) pushCapped(cityHistory[s.id] = cityHistory[s.id]||[], { t: fe.updatedAt, out: s.out }, CAP_CITY); });
    });
    const keys = Object.keys(cityHistory);
    if(keys.length > MAX_CITIES){
      const restored = keys.filter(k=>{ const a=cityHistory[k]; return a.length && a[a.length-1].out===0; })
                           .sort((a,b)=> cityHistory[a].at(-1).t - cityHistory[b].at(-1).t);
      let over = keys.length - MAX_CITIES;
      for(const k of restored){ if(over<=0) break; delete cityHistory[k]; over--; }
    }
  }
  if(cpp && prev._cppUpdatedAt !== cpp.updatedAt) pushCapped(cppHistory, { t: cpp.updatedAt, out: cppOut }, CAP_TOTAL);

  // storm lifecycle (informational only — reset is manual via RESET)
  let stormStartedAt = prev.stormStartedAt || null;
  let zeroSince = prev.zeroSince ?? null;
  if(totalAll > 0){ if(!stormStartedAt) stormStartedAt = now; zeroSince = null; }
  else if(zeroSince == null){ zeroSince = now; }

  const state = {
    schema: 1, collectedAt: now, stormStartedAt, zeroSince,
    fe: { updatedAt: fe.updatedAt, counties: fe.counties },
    cpp: cppBlock,
    peaks, cppPeak, history, countyHistory, cityHistory, cppHistory,
    _feUpdatedAt: fe.updatedAt, _cppUpdatedAt: cppBlock.updatedAt
  };
  mkdirSync("data", { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state));
  console.log(`ok neoOut=${neoOut} cppOut=${cppOut} total=${totalAll} reset=${RESET} cities=${Object.keys(cityHistory).length}`);
})();
