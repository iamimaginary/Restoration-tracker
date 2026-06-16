// Collects FirstEnergy + Cleveland Public Power outage data and maintains a
// single shared data/state.json that the dashboard reads, so every visitor sees
// the same trends regardless of whether their browser was ever open.
// Triggered ~every 15 min. The storm history is reset ONLY on demand (run the
// workflow with reset=true, which sets RESET — archives the current storm and
// starts fresh). There is no automatic time-based reset.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

// Independent cross-check (poweroutage.us, scraped into pou.json by a separate
// best-effort step). Fresh within this window → use it; otherwise carry the last
// good one forward so a single missed scrape doesn't blank the verification badge.
const POU_PATH = process.env.POU_FILE || "pou.json";
const POU_FRESH_MS = 45 * 60 * 1000;
function loadCrosscheck(prev, feSumAll, cppOut){
  let pou = null;
  try { pou = JSON.parse(readFileSync(POU_PATH, "utf8")); } catch(e){}
  if(pou && pou.ok && pou.fetchedAt && (Date.now() - pou.fetchedAt) < POU_FRESH_MS && Array.isArray(pou.utilities)){
    const fe  = pou.utilities.find(u => u.id === "121"  || /firstenergy/i.test(u.name));
    const cpp = pou.utilities.find(u => u.id === "1468" || /cleveland public power/i.test(u.name));
    return {
      source: "poweroutage.us",
      fetchedAt: pou.fetchedAt,
      updatedText: pou.updatedText || null,
      ohio: pou.ohio || null,
      fe:  fe  ? { out: fe.out,  tracked: fe.tracked  } : null,   // poweroutage's FirstEnergy (all OH)
      cpp: cpp ? { out: cpp.out, tracked: cpp.tracked } : null,   // poweroutage's Cleveland Public Power
      ours: { fe: feSumAll, cpp: cppOut }                          // our figures at the same moment
    };
  }
  return prev.crosscheck || null;    // last good paired snapshot (page greys it out if old)
}

const KB = "https://kubra.io";
const INSTANCE = "6c715f0e-bbec-465f-98cc-0b81623744be";
const VIEW     = "db9c3f02-0a06-4672-a357-0f676eb75bfa";
const NEO = new Set("CUYAHOGA LAKE GEAUGA ASHTABULA LORAIN MEDINA SUMMIT PORTAGE STARK WAYNE TRUMBULL MAHONING COLUMBIANA".split(" "));
const CPP_WEBMAP = "88719296c67e4874b0bdd2abd91658b2";
const CPP_FS0 = "https://services3.arcgis.com/dty2kHktVXHrqO8i/arcgis/rest/services/CPPFeederAreas_BufferXMBuff100v3/FeatureServer/0";

const STATE_PATH = "data/state.json";
const CAP_TOTAL = 1500, CAP_COUNTY = 1000, CAP_CITY = 96, MAX_CITIES = 300;
// Automatic storm lifecycle (no manual reset): a storm begins when total customers
// out crosses STORM_START, and ends — logged + cleared for the next one — once it
// stays at/under "restored" (max(STORM_END_FLOOR, 2% of peak)) for STORM_END_SUSTAIN_MS.
const STORM_START = 2000, STORM_END_FLOOR = 500, STORM_END_PCT = 0.02;
const STORM_END_SUSTAIN_MS = 3 * 60 * 60 * 1000;   // 3 h at/under restored level
const STORM_MIN_PEAK = 5000;                        // don't log trivial blips
const REL_DT_CAP_MS = 30 * 60 * 1000;               // cap per-reading time weight (guards against collection gaps)

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
// Anomaly guard: customers-out can never be negative or exceed customers-served.
const sane = (val, served) => { const o = (typeof val === "number" && isFinite(val)) ? Math.max(0, val) : 0; return served > 0 ? Math.min(o, served) : o; };

async function fetchFE(){
  const cs = await jget(`${KB}/stormcenter/api/v1/stormcenters/${INSTANCE}/views/${VIEW}/currentState?preview=false`, KUBRA_HEADERS);
  const dataPath = cs.data.interval_generation_data, dep = cs.stormcenterDeploymentId;
  const conf = await jget(`${KB}/stormcenter/api/v1/stormcenters/${INSTANCE}/views/${VIEW}/configuration/${dep}?preview=false`, KUBRA_HEADERS);
  const reps = conf.config.reports.data.interval_generation_data;
  const src = (reps.find(r=>/report\.json$/i.test(r.source)) || reps[0]).source;
  const report = await jget(`${KB}/${dataPath}/${src}`, KUBRA_HEADERS);
  const st = report.file_data.areas[0];
  const counties = (st.areas||[]).map(c => {
    const served = c.cust_s || 0;
    return {
      name: c.name,
      out: sane(c.cust_a && c.cust_a.val, served),
      served, etr: c.etr || null, loc: centroid(c.gotoMap && c.gotoMap.bbox),
      subs: (c.areas||[]).map(s => {
        const ss = s.cust_s || 0;
        return { id: s.areaId || (c.name+"|"+s.name), name: s.name,
                 out: sane(s.cust_a && s.cust_a.val, ss), served: ss, etr: s.etr || null,
                 loc: centroid(s.gotoMap && s.gotoMap.bbox) };
      })
    };
  });
  if(!counties.length) throw new Error("empty report (no counties)");   // don't publish a blank snapshot
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

  const now = Date.now();
  const cppBlock = cpp ? { updatedAt: cpp.updatedAt, accounts: cpp.accounts, feeders: cpp.feeders, features: cpp.features }
                       : (prev.cpp || { updatedAt: now, accounts: 0, feeders: [], features: [] });
  const neoOut = fe.counties.filter(c=>NEO.has(c.name)).reduce((s,c)=>s+c.out, 0);
  const neoServed = fe.counties.filter(c=>NEO.has(c.name)).reduce((s,c)=>s+(c.served||0), 0);
  const feSumAll = fe.counties.reduce((s,c)=>s+c.out, 0);   // all-Ohio FE total (matches poweroutage's FirstEnergy line)
  const cppOut = cppBlock.accounts || 0;
  const totalAll = neoOut + cppOut;
  const crosscheck = loadCrosscheck(prev, feSumAll, cppOut);

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
      if(r.lastT){
        const dt = Math.min(now - r.lastT, REL_DT_CAP_MS) / 3600000;   // hours, capped
        if(dt > 0){
          r.outHrs  += s.out * dt;
          r.custHrs += s.served * dt;
          r.timeHrs += dt;
          if(s.out > 0){
            r.outTimeHrs += dt;
            if(blueCtx){ r.outHrsBlue += s.out * dt; r.outTimeBlueHrs += dt; }   // outage with NO weather excuse
          }
        }
      }
      if(s.out > 0 && !(r._prevOut > 0)){ r.events++; if(blueCtx) r.blueEvents++; }   // distinct onsets; blue-sky ones flagged
      r._prevOut = s.out;
      const frac = Math.min(1, s.out / s.served);
      if(frac > r.peakFrac) r.peakFrac = frac;
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

  // ---- ETR accuracy + churn per county (persistent) ----
  // accuracy: restored by the promised time?  churn: how many times the ETR was revised during the outage.
  const etrStats = structuredClone(prev.etrStats || {});
  fe.counties.forEach(c => {
    const e = etrStats[c.name] || (etrStats[c.name] = { promises:0, met:0, missed:0, sumOverrunHrs:0, etrChanges:0, _epActive:false, _epEtr:0, _epChanges:0 });
    if(e.etrChanges == null){ e.etrChanges = 0; e._epChanges = 0; }   // migrate older records
    const etrMs = Date.parse(c.etr || "");        // NaN for "ETR-NULL"/missing
    if(c.out > 0){
      e._epActive = true;
      if(!isNaN(etrMs)){
        if(e._epEtr && etrMs !== e._epEtr) e._epChanges++;   // ETR revised mid-outage
        e._epEtr = etrMs;
      }
    } else if(e._epActive){                        // county just fully restored
      if(e._epEtr){
        e.promises++;
        if(now <= e._epEtr + 15*60000) e.met++;    // restored by the promised time (15-min grace)
        else { e.missed++; e.sumOverrunHrs += (now - e._epEtr)/3600000; }
        e.etrChanges += e._epChanges;
      }
      e._epActive = false; e._epEtr = 0; e._epChanges = 0;
    }
  });

  // same ETR accuracy + churn, per city/township
  const etrCity = structuredClone(prev.etrCity || {});
  fe.counties.forEach(c => c.subs.forEach(s => {
    const e = etrCity[s.id] || (etrCity[s.id] = { county:c.name, name:s.name, promises:0, met:0, missed:0, sumOverrunHrs:0, etrChanges:0, _epActive:false, _epEtr:0, _epChanges:0 });
    e.county = c.name; e.name = s.name;
    if(e.etrChanges == null){ e.etrChanges = 0; e._epChanges = 0; }
    const etrMs = Date.parse(s.etr || "");
    if(s.out > 0){ e._epActive = true; if(!isNaN(etrMs)){ if(e._epEtr && etrMs !== e._epEtr) e._epChanges++; e._epEtr = etrMs; } }
    else if(e._epActive){
      if(e._epEtr){ e.promises++; if(now <= e._epEtr + 15*60000) e.met++; else { e.missed++; e.sumOverrunHrs += (now - e._epEtr)/3600000; } e.etrChanges += e._epChanges; }
      e._epActive = false; e._epEtr = 0; e._epChanges = 0;
    }
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

  // peak of the current storm (NE Ohio total) from its accumulated history
  const peakTotal = history.reduce((m,p)=> Math.max(m, p.out), 0);
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
          const peakPt = history.find(p=>p.out === peakTotal) || { t: activeStorm.startedAt };
          const topCounties = Object.entries(peaks)
            .filter(([k]) => NEO.has(k))
            .map(([name, peak]) => ({ name, peak }))
            .sort((a,b)=> b.peak - a.peak).slice(0,3);
          stormLog.unshift({
            startedAt: activeStorm.startedAt, endedAt: belowSince,
            durationHrs: Math.round((belowSince - activeStorm.startedAt) / 3600000 * 10) / 10,
            peakTotal, peakAt: peakPt.t, topCounties
          });
          while(stormLog.length > 50) stormLog.pop();
        }
        history.length = 0; cppHistory.length = 0;
        for(const k of Object.keys(countyHistory)) delete countyHistory[k];
        for(const k of Object.keys(cityHistory)) delete cityHistory[k];
        for(const k of Object.keys(peaks)) delete peaks[k];
        cppPeak = 0; activeStorm = null; belowSince = null; closed = true;
      }
    } else {
      belowSince = null;
    }
  }

  const state = {
    schema: 1, collectedAt: now,
    activeStorm, belowSince, stormLog,
    fe: { updatedAt: fe.updatedAt, counties: fe.counties },
    cpp: cppBlock,
    peaks, cppPeak, history, countyHistory, cityHistory, cppHistory, reliability, etrStats, etrCity, relDay, relTrend,
    weather: { updatedAt: now, counties: weather.counties || {}, alerts: weather.alerts || [] },
    weatherLog, crosscheck,
    _feUpdatedAt: fe.updatedAt, _cppUpdatedAt: cppBlock.updatedAt
  };
  mkdirSync("data", { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state));
  console.log(`ok neoOut=${neoOut} cppOut=${cppOut} total=${totalAll} active=${!!activeStorm} closed=${closed} logged=${stormLog.length}`);
})();
