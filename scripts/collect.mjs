// Collects FirstEnergy + Cleveland Public Power outage data and maintains a
// single shared data/state.json that the dashboard reads, so every visitor sees
// the same trends regardless of whether their browser was ever open.
// Triggered ~every 15 min. The storm history is reset ONLY on demand (run the
// workflow with reset=true, which sets RESET — archives the current storm and
// starts fresh). There is no automatic time-based reset.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { parseKubraReport } from "../adapters/kubra.mjs";

// Cross-check the headline numbers two ways:
//  • internal (always available): our county-sum vs FirstEnergy's OWN published Ohio
//    total from the same Kübra feed — catches a dropped county / parse bug / stale feed.
//  • independent (best-effort): poweroutage.us, scraped into pou.json by a separate step.
//    Cloudflare reliably blocks GitHub runner IPs, so this is usually absent in CI; it
//    populates only when the scrape can reach the site (e.g. run from a residential host).
const POU_PATH = process.env.POU_FILE || "pou.json";
const POU_FRESH_MS = 45 * 60 * 1000;
function buildCrosscheck(prev, fe, feSumAll, feServedSum, cppOut){
  const internal = {
    feOfficial:       fe.official ? fe.official.out : null,     // FirstEnergy's own published OH total out
    feServedOfficial: fe.official ? fe.official.served : null,  // their own served total
    feSum:            feSumAll,                                 // our sum across all counties
    feServedSum,                                                // our served sum across all counties
    nOut:             fe.official ? fe.official.nOut : null      // their own active-incident count
  };

  // independent (poweroutage): fresh → use; else carry the last good one forward
  let poweroutage = (prev.crosscheck && prev.crosscheck.poweroutage) || null;
  let pou = null;
  try { pou = JSON.parse(readFileSync(POU_PATH, "utf8")); } catch(e){}
  if(pou && pou.ok && pou.fetchedAt && (Date.now() - pou.fetchedAt) < POU_FRESH_MS && Array.isArray(pou.utilities)){
    const feU  = pou.utilities.find(u => u.id === POU_FE_ID  || /firstenergy/i.test(u.name));
    const cppU = pou.utilities.find(u => u.id === POU_CPP_ID || /cleveland public power/i.test(u.name));
    poweroutage = {
      fetchedAt: pou.fetchedAt,
      updatedText: pou.updatedText || null,
      ohio: pou.ohio || null,
      fe:  feU  ? { out: feU.out,  tracked: feU.tracked  } : null,   // poweroutage's FirstEnergy (all OH)
      cpp: cppU ? { out: cppU.out, tracked: cppU.tracked } : null,   // poweroutage's Cleveland Public Power
      ours: { fe: feSumAll, cpp: cppOut }                            // our figures at the same moment
    };
  }
  return { internal, poweroutage };
}

// Market configuration — adding a market is writing markets/<id>.json, not editing this file.
// Select with the MARKET env var (default neo-ohio); the rest of the collector reads from here.
const MARKET = process.env.MARKET || "neo-ohio";
const market = JSON.parse(readFileSync(new URL(`../markets/${MARKET}.json`, import.meta.url), "utf8"));
const feSource  = market.sources.find(s => s.adapter === "kubra");
const cppSource = market.sources.find(s => s.adapter === "arcgis-cpp");
const POU_FE_ID  = feSource  ? feSource.poweroutageId  : null;   // poweroutage.us utility ids (cross-check)
const POU_CPP_ID = cppSource ? cppSource.poweroutageId : null;

const KB = "https://kubra.io";
const INSTANCE = feSource.config.instance;
const VIEW     = feSource.config.view;
const NEO = new Set(market.scope.counties);
const CPP_WEBMAP = cppSource ? cppSource.config.webmap : null;
const CPP_FS0    = cppSource ? cppSource.config.featureServer : null;

const STATE_PATH = "data/state.json";
const CAP_TOTAL = 1500, CAP_COUNTY = 1000, CAP_CITY = 96, MAX_CITIES = 300;
// Automatic storm lifecycle (no manual reset): a storm begins when total customers
// out crosses STORM_START, and ends — logged + cleared for the next one — once it
// stays at/under "restored" (max(STORM_END_FLOOR, 2% of peak)) for STORM_END_SUSTAIN_MS.
const STORM_START = 2000, STORM_END_FLOOR = 500, STORM_END_PCT = 0.02;
const STORM_END_SUSTAIN_MS = 3 * 60 * 60 * 1000;   // 3 h at/under restored level
const STORM_MIN_PEAK = 5000;                        // don't log trivial blips
const REL_DT_CAP_MS = 30 * 60 * 1000;               // cap per-reading time weight (guards against collection gaps)
// within-season recency weighting: each season bucket is an exponentially-weighted moving average,
// so the grade keeps evolving all season (recent weeks dominate; old events fade) instead of freezing
// into a season-to-date cumulative average. ~21-day half-life ⇒ reflects roughly "the last few weeks".
const REL_HALFLIFE_DAYS = 21;
const REL_TAU_HRS = REL_HALFLIFE_DAYS * 24 / Math.LN2;

const centroid = b => (b && b.length === 4) ? [(b[1]+b[3])/2, (b[0]+b[2])/2] : null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
// evenly downsample a {t,out} series to ~n points (always keeping the peak) for a stored storm thumbnail
function downsample(series, n){
  if(!series || series.length <= n) return (series||[]).map(p=>({ t:p.t, out:p.out }));
  const out = [], step = (series.length-1)/(n-1);
  for(let i=0;i<n;i++){ const p = series[Math.round(i*step)]; out.push({ t:p.t, out:p.out }); }
  let pk = series[0]; for(const p of series) if(p.out > pk.out) pk = p;
  if(!out.some(p=>p.t===pk.t)){ out.push({ t:pk.t, out:pk.out }); out.sort((a,b)=>a.t-b.t); }
  return out;
}

// Self-score the deployed ETA estimator on a completed storm's own trajectory: walk forward from
// the peak and, at each point still above the 90%-restored target, predict hours-to-90% and compare
// to what actually happened. Returns the median absolute error (h), or null if too short to score.
// Mirrors index.html rateInfo: 2-point rate over a ~2.5h window, holding guard, linear out/rate with a
// gated (peak>=1000, past halfway) bounded (<=2x) tail-slowdown correction. Keep in sync if that changes.
function scoreEta(series, peak){
  if(!series || series.length < 6 || !(peak > 0)) return null;
  const target = peak * 0.10, W = 150*60*1000;
  let pk = 0; for(let i=0;i<series.length;i++) if(series[i].out >= series[pk].out) pk = i;
  const errs = [];
  for(let i=pk+1;i<series.length;i++){
    const out = series[i].out; if(out <= target) continue;
    let j=-1; for(let k=i+1;k<series.length;k++){ if(series[k].out <= target){ j=k; break; } }
    if(j<0) break;                                              // 90% never reached afterward → no ground truth
    const realized = (series[j].t - series[i].t)/3600000;
    let s=null; for(let q=0;q<=i;q++){ if(series[q].t >= series[i].t - W){ s=series[q]; break; } }
    if(!s || s===series[i]) s = series[i-1]; if(!s) continue;
    const hrs = (series[i].t - s.t)/3600000; if(hrs<=0) continue;
    const rate = (s.out - out)/hrs;
    if(!(rate > Math.max(5, out*0.01))) continue;               // holding guard → estimator shows nothing
    const f = Math.max(0, Math.min(1, (peak-out)/peak));
    const decel = peak >= 1000 ? 1 + Math.min(1, Math.max(0, (f-0.5)/0.5)) : 1;
    const pred = ((out - target)/rate) * decel;
    errs.push(Math.abs(pred - realized));
  }
  if(!errs.length) return null;
  errs.sort((a,b)=>a-b);
  return Math.round(errs[Math.floor(errs.length/2)] * 10) / 10;
}

// meteorological season + occurrence key. Winter (Dec–Feb) is keyed to the December year,
// so a single occurrence (e.g. "winter-2026") spans the calendar boundary.
function seasonOf(ms){
  const d = new Date(ms), m = d.getMonth(), y = d.getFullYear();   // m: 0=Jan … 11=Dec
  const s = (m===11 || m<=1) ? "winter" : m<=4 ? "spring" : m<=7 ? "summer" : "fall";
  const yr = (s==="winter" && m<=1) ? y-1 : y;
  return { s, key: `${s}-${yr}` };
}

// Look like a browser and retry — FirstEnergy's CDN (KUBRA) intermittently 403s
// requests from datacenter IPs / non-browser clients.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
async function jget(url, extraHeaders = {}){
  const headers = { "User-Agent": UA, "Accept": "application/json, text/plain, */*",
                    "Accept-Language": "en-US,en;q=0.9", ...extraHeaders };
  let lastErr;
  for(let attempt = 1; attempt <= 4; attempt++){
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });   // never hang on a stalled connection
      if(r.ok) return await r.json();
      lastErr = new Error(url.split("/")[2] + " " + r.status);
      // retry on 403/429/5xx (transient/bot-protection); give up on other 4xx
      if(!(r.status === 403 || r.status === 429 || r.status >= 500)) break;
    } catch(e){ lastErr = e; }
    await sleep(700 * attempt + Math.random() * 400);
  }
  throw lastErr;
}
const KUBRA_HEADERS = { "Referer": feSource.config.referer, "Origin": new URL(feSource.config.referer).origin };
const pushCapped = (arr, point, cap) => { arr.push(point); while(arr.length > cap) arr.shift(); return arr; };
// Anomaly guard: customers-out can never be negative or exceed customers-served.
const sane = (val, served) => { const o = (typeof val === "number" && isFinite(val)) ? Math.max(0, val) : 0; return served > 0 ? Math.min(o, served) : o; };

async function fetchFE(){
  const cs = await jget(`${KB}/stormcenter/api/v1/stormcenters/${INSTANCE}/views/${VIEW}/currentState?preview=false`, KUBRA_HEADERS);
  const dataPath = cs.data.interval_generation_data, dep = cs.stormcenterDeploymentId;
  const conf = await jget(`${KB}/stormcenter/api/v1/stormcenters/${INSTANCE}/views/${VIEW}/configuration/${dep}?preview=false`, KUBRA_HEADERS);
  const reps = conf.config.reports.data.interval_generation_data;
  const src = (reps.find(r=>/report\.json$/i.test(r.source)) || reps[0]).source;
  const report = await jget(`${KB}/${dataPath}/${src}`, KUBRA_HEADERS);
  const { official, areas: counties } = parseKubraReport(report);   // adapters/kubra.mjs (golden-tested)
  if(!counties.length) throw new Error("empty report (no counties)");   // don't publish a blank snapshot
  const clusterTmpl = cs.data && cs.data.cluster_interval_generation_data;   // for the cause crawl
  return { updatedAt: cs.updatedAt || Date.now(), counties, official, clusterTmpl };
}

/* ---------- outage causes: budget-capped quadtree crawl of Kübra cluster tiles ----------
   Cause/crew-status live only on individual incidents (cluster=false), which resolve at deep
   zoom. We descend biggest-clusters-first with a hard fetch budget and stop once only tiny
   clusters remain, so blue-sky is cheap and storms stay bounded. Best-effort: any failure
   leaves causes untouched. */
const lon2tileX = (lon,z)=> Math.floor((lon+180)/360 * 2**z);
const lat2tileY = (lat,z)=>{ const r=lat*Math.PI/180; return Math.floor((1 - Math.log(Math.tan(r)+1/Math.cos(r))/Math.PI)/2 * 2**z); };
const tileQuadkey = (x,y,z)=>{ let q=""; for(let i=z;i>0;i--){ let d=0; const m=1<<(i-1); if(x&m)d+=1; if(y&m)d+=2; q+=String(d); } return q; };
const causeText = v => (v && typeof v === "object") ? (v["EN-US"] || v.orig || "") : (v || "");
async function fetchCauses(tmpl, totalCust){
  if(!tmpl || !/\{qkh\}/.test(tmpl)) throw new Error("no cluster data path");
  const url = q => `${KB}/${tmpl.replace("{qkh}", q.slice(-3).split("").reverse().join(""))}/public/cluster-5/${q}.json`;
  const tileGet = async q => {
    try { const r = await fetch(url(q), { headers: { "User-Agent": UA, "Accept": "*/*", "Referer": "https://kubra.io/" }, signal: AbortSignal.timeout(15000) });
      if(!r.ok) return []; const j = await r.json(); return Array.isArray(j.file_data) ? j.file_data : []; }
    catch(e){ return []; }
  };
  const OHIO = market.geo.bbox;   // N,E,S,W service bbox (from markets/<id>.json)
  const Z0 = 6, BUDGET = 220, CONC = 8, MAXZ = 15, MIN_CLUSTER = 8;   // stop once only tiny clusters remain
  let pq = [];
  for(let x=lon2tileX(OHIO[3],Z0); x<=lon2tileX(OHIO[1],Z0); x++)
    for(let y=lat2tileY(OHIO[0],Z0); y<=lat2tileY(OHIO[2],Z0); y++) pq.push({ q: tileQuadkey(x,y,Z0), cust: Infinity });
  const byCause = {}; let knownCust = 0, incidents = 0, fetches = 0;
  const seenPt = new Set(), fetched = new Set(); let ptless = 0;   // dedupe incidents by point; tiles by quadkey
  while(pq.length && fetches < BUDGET){
    pq.sort((a,b)=> b.cust - a.cust);
    if(pq[0].cust < MIN_CLUSTER) break;                   // biggest-first; nothing significant left to descend
    const batch = [];
    while(batch.length < CONC && pq.length && fetches + batch.length < BUDGET){
      const e = pq.shift(); if(fetched.has(e.q)) continue; fetched.add(e.q); batch.push(e);
    }
    if(!batch.length) break;
    fetches += batch.length;
    const results = await Promise.all(batch.map(e => tileGet(e.q).then(items => ({ e, items }))));
    for(const { e, items } of results){
      for(const it of items){
        const d = it.desc || {};
        const pt = it.geom && it.geom.p && it.geom.p[0];
        if(d.cluster){
          if(e.q.length < MAXZ){ const cu = (d.cust_a && d.cust_a.val) || 0; for(const c of ["0","1","2","3"]) pq.push({ q: e.q + c, cust: cu }); }
        } else {
          // an incident has a stable point and can re-appear at deeper zoom (alongside sibling clusters),
          // so dedupe by point — NOT by tile — to avoid counting it once per zoom level.
          const key = pt || ("p" + (ptless++));
          if(seenPt.has(key)) continue; seenPt.add(key);
          const label = causeText(d.cause) || "Assessing";
          const cu = (d.cust_a && d.cust_a.val) || 0;
          (byCause[label] = byCause[label] || { cust:0, n:0 }); byCause[label].cust += cu; byCause[label].n++;
          knownCust += cu; incidents++;
        }
      }
    }
  }
  // NOTE: knownCust is a sum of per-incident customer counts, which Kübra masks/rounds for small
  // outages and overlaps for nested ones — so it is NOT comparable to the official total and must
  // not be shown as a "% of customers". The page reports the sampled incident count instead.
  return { sampledAt: Date.now(), totalCust, knownCust, incidents, fetches, byCause };
}

// Observed daily max wind gust for NE Ohio (Cleveland), keyed by UTC day to match relTrend.
// Open-Meteo: free, no key, mph. Used to annotate the reliability trend's storm days.
async function fetchWind(){
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${market.weather.lat}&longitude=${market.weather.lon}`
    + "&daily=wind_gusts_10m_max,wind_speed_10m_max&wind_speed_unit=mph&timezone=GMT&past_days=14&forecast_days=1";
  const d = await jget(u);
  const days = (d.daily && d.daily.time) || [];
  const g = (d.daily && d.daily.wind_gusts_10m_max) || [];
  const wd = (d.daily && d.daily.wind_speed_10m_max) || [];
  const map = {};
  days.forEach((day,i)=>{ if(g[i] != null) map[day] = { gust: g[i], wind: wd[i] }; });
  return map;
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

// Active NWS weather alerts for Ohio, mapped to our counties. Used to tell whether
// an outage coincides with a weather event (vs. a blue-sky / infrastructure outage).
async function fetchWeather(){
  const data = await jget("https://api.weather.gov/alerts/active?area=OH", { "Accept": "application/geo+json" });
  const counties = {};                       // COUNTY -> [event names]
  const alerts = [];
  for(const f of (data.features || [])){
    const p = f.properties || {};
    const areaU = (p.areaDesc || "").toUpperCase();
    const hit = [...NEO].filter(c => areaU.includes(c));
    const id = p.id || f.id;
    if(p.event) alerts.push({ id, event: p.event, severity: p.severity || null,
                              counties: hit, onset: p.onset || null, ends: p.ends || p.expires || null });
    hit.forEach(c => { (counties[c] = counties[c] || []); if(!counties[c].includes(p.event)) counties[c].push(p.event); });
  }
  return { counties, alerts, weatherSet: new Set(Object.keys(counties)) };
}

function loadPrev(){
  try { return JSON.parse(readFileSync(STATE_PATH, "utf8")); }
  catch(e){ return { peaks:{}, cppPeak:0, history:[], countyHistory:{}, cityHistory:{}, cppHistory:[],
                     activeStorm:null, belowSince:null, stormLog:[], reliability:{}, weather:null, weatherLog:[], etrStats:{}, etrCity:{}, relDay:null, relTrend:[] }; }
}

(async () => {
  const prev = loadPrev();

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

  // Weather is optional context; on failure assume no known alert (won't false-flag blue-sky).
  let weather = { counties:{}, alerts:[], weatherSet:new Set() };
  try { weather = await fetchWeather(); }
  catch(e){ console.error("Weather fetch failed:", e.message); }
  const weatherSet = weather.weatherSet || new Set();

  // Outage causes (best-effort budget-capped crawl). Reuse last good on failure.
  let causes = prev.causes || null;
  try { causes = await fetchCauses(fe.clusterTmpl, fe.official.out); }
  catch(e){ console.error("Causes crawl failed:", e.message); }

  // Daily max wind gust (best-effort) to annotate the reliability trend.
  let wind = {};
  try { wind = await fetchWind(); }
  catch(e){ console.error("Wind fetch failed:", e.message); }

  const now = Date.now();
  const cppBlock = cpp ? { updatedAt: cpp.updatedAt, accounts: cpp.accounts, feeders: cpp.feeders, features: cpp.features }
                       : (prev.cpp || { updatedAt: now, accounts: 0, feeders: [], features: [] });
  const neoOut = fe.counties.filter(c=>NEO.has(c.name)).reduce((s,c)=>s+c.out, 0);
  const neoServed = fe.counties.filter(c=>NEO.has(c.name)).reduce((s,c)=>s+(c.served||0), 0);
  const feSumAll = fe.counties.reduce((s,c)=>s+c.out, 0);          // all-Ohio FE total (our sum of counties)
  const feServedSum = fe.counties.reduce((s,c)=>s+(c.served||0), 0);
  const cppOut = cppBlock.accounts || 0;
  const totalAll = neoOut + cppOut;
  const crosscheck = buildCrosscheck(prev, fe, feSumAll, feServedSum, cppOut);

  // peaks (per county + per city, plus CPP)
  const peaks = { ...(prev.peaks||{}) };
  fe.counties.forEach(c => {
    if((peaks[c.name]||0) < c.out) peaks[c.name] = c.out;
    c.subs.forEach(s => { if((peaks[s.id]||0) < s.out) peaks[s.id] = s.out; });
  });
  let cppPeak = Math.max(prev.cppPeak||0, cppOut);
  // true running NE-Ohio event peak — a running max (reset on event close), so it can't be
  // eroded by history capping the way max(history) can on a very long event.
  let neoPeak = Math.max(prev.neoPeak||0, neoOut);

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

  // ---- long-run per-city reliability (persists across storms; never reset here) ----
  // Time-weighted on every collection so it reflects real elapsed time. dt is capped
  // so a collection gap can't distort one reading. Yields ASAI-style availability,
  // outage-time fraction, peak severity, and a distinct-event count.
  // "Blue-sky" = an outage with no weather excuse: no current/recent NWS alert in the
  // county AND no active regional storm. Recent-weather window avoids flagging storm
  // aftermath (outages persist long after the NWS warning expires).
  const WX_RECENT_MS = 24 * 60 * 60 * 1000;
  const recentWxCounties = new Set(weatherSet);
  for(const w of (prev.weatherLog || [])){
    if((now - (w.lastSeen || 0)) <= WX_RECENT_MS) (w.counties || []).forEach(c => recentWxCounties.add(c));
  }
  const stormContext = !!prev.activeStorm || totalAll >= STORM_START;

  // meteorological season + occurrence (winter spans Dec–Feb, keyed to the December year),
  // so reliability can be reported per season instead of one ever-ratcheting lifetime average.
  const cur = seasonOf(now);
  const blankSeason = occ => ({ occ, outHrs:0, custHrs:0, outTimeHrs:0, timeHrs:0, obsHrs:0, peakFrac:0, events:0, outHrsBlue:0, outTimeBlueHrs:0, blueEvents:0 });
  const reliability = structuredClone(prev.reliability || {});
  fe.counties.forEach(c => {
    const blueCtx = !stormContext && !recentWxCounties.has(c.name);   // true ⇒ no weather/storm excuse
    c.subs.forEach(s => {
      if(!s.served || s.served <= 0) return;
      let r = reliability[s.id];
      if(!r){ r = reliability[s.id] = { name:s.name, county:c.name, served:s.served, obs:0, firstT:now, lastT:0,
                outHrs:0, custHrs:0, outTimeHrs:0, timeHrs:0, peakFrac:0, events:0,
                outHrsBlue:0, outTimeBlueHrs:0, blueEvents:0, _prevOut:0 }; }
      r.name = s.name; r.county = c.name; r.served = s.served;
      // migrate older records that lack the blue-sky fields
      if(r.outHrsBlue == null){ r.outHrsBlue = 0; r.outTimeBlueHrs = 0; r.blueEvents = 0; }
      // seasonal buckets: seed from lifetime on first migration (all data so far is the current
      // season for this app's age), then accumulate per season; a fresh occurrence starts clean.
      if(!r.seasons){ r.seasons = { [cur.s]: { occ:cur.key, outHrs:r.outHrs||0, custHrs:r.custHrs||0, outTimeHrs:r.outTimeHrs||0, timeHrs:r.timeHrs||0, peakFrac:r.peakFrac||0, events:r.events||0, outHrsBlue:r.outHrsBlue||0, outTimeBlueHrs:r.outTimeBlueHrs||0, blueEvents:r.blueEvents||0 } }; }
      let sb = r.seasons[cur.s];
      if(!sb || sb.occ !== cur.key) sb = r.seasons[cur.s] = blankSeason(cur.key);
      if(sb.obsHrs == null) sb.obsHrs = sb.timeHrs || 0;   // elapsed observation time (not decayed; for "days so far")
      if(r.lastT){
        const dt = Math.min(now - r.lastT, REL_DT_CAP_MS) / 3600000;   // hours, capped
        if(dt > 0){
          // lifetime accumulators stay cumulative; the season bucket is recency-weighted: decay its
          // running totals by exp(-dt/τ) each cycle before adding this reading, so it tracks recent weeks.
          const decay = Math.exp(-dt / REL_TAU_HRS);
          sb.outHrs *= decay; sb.custHrs *= decay; sb.timeHrs *= decay;
          sb.outTimeHrs *= decay; sb.outHrsBlue *= decay; sb.outTimeBlueHrs *= decay;
          sb.peakFrac *= decay; sb.events *= decay; sb.blueEvents *= decay;
          r.outHrs  += s.out * dt;        sb.outHrs  += s.out * dt;
          r.custHrs += s.served * dt;     sb.custHrs += s.served * dt;
          r.timeHrs += dt;                sb.timeHrs += dt;      sb.obsHrs += dt;
          if(s.out > 0){
            r.outTimeHrs += dt;           sb.outTimeHrs += dt;
            if(blueCtx){ r.outHrsBlue += s.out * dt; r.outTimeBlueHrs += dt; sb.outHrsBlue += s.out * dt; sb.outTimeBlueHrs += dt; }
          }
        }
      }
      if(s.out > 0 && !(r._prevOut > 0)){ r.events++; sb.events++; if(blueCtx){ r.blueEvents++; sb.blueEvents++; } }   // distinct onsets (season count fades via decay)
      r._prevOut = s.out;
      const frac = Math.min(1, s.out / s.served);
      if(frac > r.peakFrac) r.peakFrac = frac;
      if(frac > sb.peakFrac) sb.peakFrac = frac;
      r.obs++; r.lastT = now;
    });
  });

  // ---- daily regional reliability trend (NE Ohio availability per day) ----
  let relDay = prev.relDay ? { ...prev.relDay } : null;
  const relTrend = (prev.relTrend || []).slice();
  const dayKey = new Date(now).toISOString().slice(0,10);
  const dtCycle = prev.collectedAt ? Math.min(now - prev.collectedAt, REL_DT_CAP_MS) / 3600000 : 0;
  if(!relDay || relDay.day !== dayKey){
    if(relDay && relDay.custHrs > 0){                         // finalize the previous day
      relTrend.push({ day: relDay.day, availPct: (1 - relDay.outHrs / relDay.custHrs) * 100 });
      while(relTrend.length > 120) relTrend.shift();
    }
    relDay = { day: dayKey, outHrs: 0, custHrs: 0 };
  }
  if(dtCycle > 0 && neoServed > 0){ relDay.outHrs += neoOut * dtCycle; relDay.custHrs += neoServed * dtCycle; }
  // annotate each day with its observed max wind gust (fills in as Open-Meteo finalizes each day)
  relTrend.forEach(d => { const w = wind[d.day]; if(w){ d.gustMph = Math.round(w.gust); if(w.wind != null) d.windMph = Math.round(w.wind); } });

  // ---- ETR accuracy + churn per county (persistent) ----
  // accuracy: restored by the promised time?  churn: how often the ETR was revised mid-outage —
  // split by DIRECTION, because moving the estimate *later* (a "push-back") is the painful,
  // reliability-relevant event, while moving it *earlier* (a "pull-in", restored sooner than
  // promised) is good news for customers and shouldn't count against stability.
  const etrInit = extra => ({ promises:0, met:0, missed:0, sumOverrunHrs:0,
    etrChanges:0, etrSlips:0, etrPullIns:0,                       // lifetime totals (slips = push-backs)
    _epActive:false, _epEtr:0, _epChanges:0, _epSlips:0, _epPullIns:0, ...extra });   // current-outage accumulators
  const etrMigrate = e => {                                        // backfill fields on older records
    if(e.etrChanges == null){ e.etrChanges = 0; e._epChanges = 0; }
    if(e.etrSlips == null){ e.etrSlips = 0; e.etrPullIns = 0; }    // direction unknown for past data → start fresh
    if(e._epSlips == null){ e._epSlips = 0; e._epPullIns = 0; }
  };
  const etrObserve = (e, out, etrRaw) => {                         // one reading of an area's ETR
    const etrMs = Date.parse(etrRaw || "");                        // NaN for "ETR-NULL"/missing
    if(out > 0){
      e._epActive = true;
      if(!isNaN(etrMs)){
        if(e._epEtr && etrMs !== e._epEtr){
          e._epChanges++;
          if(etrMs > e._epEtr) e._epSlips++;                       // pushed later → push-back (counts against stability)
          else e._epPullIns++;                                     // moved earlier → pull-in (good news)
        }
        e._epEtr = etrMs;
      }
    } else if(e._epActive){                                        // area just fully restored → close the outage
      if(e._epEtr){
        e.promises++;
        if(now <= e._epEtr + 15*60000) e.met++;                    // restored by the promised time (15-min grace)
        else { e.missed++; e.sumOverrunHrs += (now - e._epEtr)/3600000; }
        e.etrChanges  += e._epChanges;
        e.etrSlips    += e._epSlips;
        e.etrPullIns  += e._epPullIns;
      }
      e._epActive = false; e._epEtr = 0; e._epChanges = 0; e._epSlips = 0; e._epPullIns = 0;
    }
  };

  const etrStats = structuredClone(prev.etrStats || {});
  fe.counties.forEach(c => {
    const e = etrStats[c.name] || (etrStats[c.name] = etrInit());
    etrMigrate(e);
    etrObserve(e, c.out, c.etr);
  });

  // same ETR accuracy + directional churn, per city/township
  const etrCity = structuredClone(prev.etrCity || {});
  fe.counties.forEach(c => c.subs.forEach(s => {
    const e = etrCity[s.id] || (etrCity[s.id] = etrInit({ county:c.name, name:s.name }));
    e.county = c.name; e.name = s.name;
    etrMigrate(e);
    etrObserve(e, s.out, s.etr);
  }));

  // rolling log of every weather event seen (NWS alerts), keyed by alert id
  const weatherLog = (prev.weatherLog || []).slice();
  const wlById = new Map(weatherLog.map(w => [w.id, w]));
  for(const a of (weather.alerts || [])){
    const ex = wlById.get(a.id);
    if(ex){ ex.lastSeen = now; ex.ends = a.ends; ex.counties = a.counties; }
    else { const w = { id:a.id, event:a.event, severity:a.severity, counties:a.counties, onset:a.onset, ends:a.ends, firstSeen:now, lastSeen:now };
           weatherLog.unshift(w); wlById.set(a.id, w); }
  }
  while(weatherLog.length > 150) weatherLog.pop();

  // ---- automatic storm lifecycle ----
  let activeStorm = prev.activeStorm || (history.length ? { startedAt: history[0].t } : null);
  let belowSince  = prev.belowSince ?? null;
  const stormLog  = (prev.stormLog || []).slice();
  let closed = false;

  // peak of the current storm (NE Ohio total). Prefer the live-tracked running peak (robust to
  // history capping on long events) and fall back to the max over the retained history.
  const peakTotal = Math.max((activeStorm && activeStorm.peak) || 0, history.reduce((m,p)=> Math.max(m, p.out), 0));
  const restoredLevel = Math.max(STORM_END_FLOOR, Math.round(peakTotal * STORM_END_PCT));

  if(!activeStorm){
    // between storms — start a new one once outages clearly rise
    if(totalAll >= STORM_START){ activeStorm = { startedAt: now }; belowSince = null; }
  } else {
    if(totalAll <= restoredLevel){
      if(belowSince == null) belowSince = now;
      if(now - belowSince >= STORM_END_SUSTAIN_MS){
        // storm is over: log a summary, then clear everything for the next storm
        if(peakTotal >= STORM_MIN_PEAK){
          const peakPt = history.find(p=>p.out === peakTotal) || { t: (activeStorm.peakAt || activeStorm.startedAt) };
          const topCounties = Object.entries(peaks)
            .filter(([k]) => NEO.has(k))
            .map(([name, peak]) => ({ name, peak }))
            .sort((a,b)=> b.peak - a.peak).slice(0,3);
          // total customer-hours lost (NE Ohio), dt-capped to ignore collection gaps
          let custHrsLost = 0;
          for(let i=1;i<history.length;i++){ const dt = Math.min(history[i].t-history[i-1].t, REL_DT_CAP_MS)/3600000; custHrsLost += history[i-1].out * dt; }
          // restoration milestones: hours from peak until out fell to 50% / 10% (= 90% restored)
          const afterPeak = history.filter(p=>p.t >= peakPt.t);
          const milestone = frac => { const hit = afterPeak.find(p=>p.out <= peakTotal*frac); return hit ? Math.round((hit.t-peakPt.t)/360000)/10 : null; };
          // weather alerts overlapping the storm window, worst-severity first
          const sevRank = { Extreme:4, Severe:3, Moderate:2, Minor:1 };
          const wEvents = [...new Set((weatherLog||[]).filter(e=>{ const a=Date.parse(e.onset)||e.firstSeen, b=Date.parse(e.ends)||e.lastSeen||a; return a && a<=belowSince && b>=activeStorm.startedAt; })
            .sort((x,y)=>(sevRank[y.severity]||0)-(sevRank[x.severity]||0)).map(e=>e.event))].slice(0,5);
          // max observed gust over the storm's days
          let maxGust = 0;
          for(let t=activeStorm.startedAt; t<=belowSince+864e5; t+=864e5){ const w = wind[new Date(t).toISOString().slice(0,10)]; if(w && w.gust>maxGust) maxGust = w.gust; }
          // archive a per-location history file so the storm can be replayed on the map (radar-style).
          // Locations are stable and present for every area in the report, so we grab them now.
          const replayId = activeStorm.startedAt;
          try {
            const RP = 80;            // downsample points per series (smooth scrub, bounded size)
            const cMeta = {}, sMeta = {};
            fe.counties.forEach(c => { cMeta[c.name] = { loc:c.loc, served:c.served };
              c.subs.forEach(s => { sMeta[s.id] = { name:s.name, loc:s.loc, served:s.served }; }); });
            const county = {};
            for(const [k,v] of Object.entries(countyHistory)){ if(v && v.length){ const m=cMeta[k]||{}; county[k] = { loc:m.loc||null, served:m.served||0, series: downsample(v, RP) }; } }
            const city = {};
            for(const [k,v] of Object.entries(cityHistory)){ if(v && v.length){ const m=sMeta[k]; if(m && m.loc) city[k] = { name:m.name, loc:m.loc, served:m.served||0, series: downsample(v, RP) }; } }
            mkdirSync("data/storms", { recursive: true });
            writeFileSync(`data/storms/${replayId}.json`, JSON.stringify({
              startedAt: activeStorm.startedAt, endedAt: belowSince, peakTotal,
              history: downsample(history, RP), county, city
            }));
          } catch(e){ console.error("replay file write failed:", e.message); }
          stormLog.unshift({
            startedAt: activeStorm.startedAt, endedAt: belowSince,
            durationHrs: Math.round((belowSince - activeStorm.startedAt) / 3600000 * 10) / 10,
            peakTotal, peakAt: peakPt.t, topCounties,
            custHrsLost: Math.round(custHrsLost),
            // prefer milestones tracked live during the storm (survive history capping); fall back to a scan
            toHalfHrs: (activeStorm.ms && activeStorm.ms.half != null) ? activeStorm.ms.half : milestone(0.5),
            to90Hrs:   (activeStorm.ms && activeStorm.ms.p90  != null) ? activeStorm.ms.p90  : milestone(0.10),
            etaMaeHrs: scoreEta(history, peakTotal),        // real-world accuracy of the app's ETA estimator on this storm
            peakCPP: cppPeak || 0,
            nOutPeak: activeStorm.nOutPeak || 0,
            maxGustMph: maxGust ? Math.round(maxGust) : null,
            weatherEvents: wEvents,
            causes: activeStorm.peakCauses || null,        // cause mix at the worst moment
            curve: downsample(history, 48),                // thumbnail of the outage curve
            replayId                                       // → data/storms/<replayId>.json
          });
          while(stormLog.length > 50) stormLog.pop();
        }
        history.length = 0; cppHistory.length = 0;
        for(const k of Object.keys(countyHistory)) delete countyHistory[k];
        for(const k of Object.keys(cityHistory)) delete cityHistory[k];
        for(const k of Object.keys(peaks)) delete peaks[k];
        cppPeak = 0; neoPeak = 0; activeStorm = null; belowSince = null; closed = true;
      }
    } else {
      belowSince = null;
    }
  }

  // accumulate live storm context (worst-moment incident count + cause mix) for the storm log
  if(activeStorm){
    activeStorm.nOutPeak = Math.max(activeStorm.nOutPeak || 0, fe.official.nOut || 0);
    if(totalAll >= (activeStorm.peak || 0)){
      activeStorm.peak = totalAll; activeStorm.peakAt = now;
      activeStorm.ms = {};                       // new high-water mark → milestones are timed from here
      if(causes && causes.byCause && causes.knownCust > 0){
        activeStorm.peakCauses = Object.fromEntries(Object.entries(causes.byCause).sort((a,b)=>(b[1].cust||0)-(a[1].cust||0)).slice(0,6));
      }
    }
    // restoration milestones tracked live (hours from peak to 50% / 90% restored), so they survive
    // history capping on long events and always populate the historical-pace prior.
    if(activeStorm.peak > 0){
      activeStorm.ms = activeStorm.ms || {};
      const hFromPeak = Math.round((now - activeStorm.peakAt) / 360000) / 10;
      if(activeStorm.ms.half == null && totalAll <= activeStorm.peak * 0.5)  activeStorm.ms.half = hFromPeak;
      if(activeStorm.ms.p90  == null && totalAll <= activeStorm.peak * 0.10) activeStorm.ms.p90  = hFromPeak;
    }
  }

  // backfill recoverable fields onto older storm-log entries (e.g. ones archived before these
  // fields existed). Customer-hours / curve / causes can't be reconstructed, but the day's max
  // gust (Open-Meteo, ~14d back) and overlapping weather alerts often still can be.
  const sevRank = { Extreme:4, Severe:3, Moderate:2, Minor:1 };
  stormLog.forEach(s => {
    if(s.maxGustMph == null){
      let g = 0;
      for(let t=s.startedAt; t<=s.endedAt+864e5; t+=864e5){ const w = wind[new Date(t).toISOString().slice(0,10)]; if(w && w.gust>g) g = w.gust; }
      if(g) s.maxGustMph = Math.round(g);
    }
    if(!s.weatherEvents){
      const ev = [...new Set((weatherLog||[]).filter(e=>{ const a=Date.parse(e.onset)||e.firstSeen, b=Date.parse(e.ends)||e.lastSeen||a; return a && a<=s.endedAt && b>=s.startedAt; })
        .sort((x,y)=>(sevRank[y.severity]||0)-(sevRank[x.severity]||0)).map(e=>e.event))].slice(0,5);
      if(ev.length) s.weatherEvents = ev;
    }
  });
  // prune replay files for storms that have aged out of the log
  try {
    const keep = new Set(stormLog.map(s=>String(s.replayId)).filter(Boolean));
    for(const f of readdirSync("data/storms")){ if(f.endsWith(".json") && !keep.has(f.replace(/\.json$/,""))) unlinkSync(`data/storms/${f}`); }
  } catch(e){ /* dir may not exist yet */ }

  const state = {
    schema: 1, collectedAt: now,
    activeStorm, belowSince, stormLog,
    fe: { updatedAt: fe.updatedAt, counties: fe.counties },
    cpp: cppBlock,
    peaks, cppPeak, neoPeak, history, countyHistory, cityHistory, cppHistory, reliability, etrStats, etrCity, relDay, relTrend,
    weather: { updatedAt: now, counties: weather.counties || {}, alerts: weather.alerts || [] },
    weatherLog, crosscheck, causes,
    _feUpdatedAt: fe.updatedAt, _cppUpdatedAt: cppBlock.updatedAt
  };
  mkdirSync("data", { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state));
  console.log(`ok neoOut=${neoOut} cppOut=${cppOut} total=${totalAll} active=${!!activeStorm} closed=${closed} logged=${stormLog.length}`
    + (causes ? ` causes=${causes.incidents}inc/${causes.fetches}fetch` : " causes=none"));
})();
