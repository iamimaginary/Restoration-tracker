# NE Ohio Power Restoration Tracker — Session Handoff

A single-page web app that tracks **FirstEnergy** (Ohio Edison + The Illuminating Company)
and **Cleveland Public Power** outages/restoration across Northeast Ohio, with shared
server-collected history, reliability analytics, and weather context. Built to run hands-off.

---

## 1. Where everything lives

| Thing | Value |
|---|---|
| Repo | `iamimaginary/Restoration-tracker` (PUBLIC) |
| Code branch (default branch + GitHub Pages source) | `claude/first-energy-restoration-tracker-m185by` |
| Data branch (shared snapshot) | `tracker-data` (single file `state.json` at root) |
| Live site | https://iamimaginary.github.io/Restoration-tracker/ (GitHub Pages) |
| Page | `index.html` (one self-contained file: HTML + CSS + JS) |
| Collector | `scripts/collect.mjs` (Node 20, ESM) |
| Workflow | `.github/workflows/collect.yml` |
| Map boundaries | `oh-counties.geojson` (slimmed Ohio county polygons, code branch) |

**Branch rule:** develop on `claude/first-energy-restoration-tracker-m185by`. The data
collector commits `state.json` to the separate `tracker-data` branch so the page branch
stays stable (avoids CDN cache thrash / Pages rebuilds on every snapshot).

---

## 2. How it works (data flow)

```
cron-job.org (every 15 min)  ──POST repository_dispatch {event_type:"collect"}──▶  GitHub Actions
        │                                                                              │
        └─ also: schedule cron (unreliable backstop) + workflow_dispatch (manual)      ▼
                                                                          scripts/collect.mjs
                                            fetches FirstEnergy (Kübra) + CPP (ArcGIS) + NWS alerts
                                            updates peaks/histories/reliability/etr/weather/storm log
                                            commits data/state.json  ──▶  tracker-data branch
                                                                              │
   Browser (Pages) ── fetch state.json (raw.githubusercontent, ~5min CDN) ◀───┘
        prefers the shared snapshot; if missing/stale (>25 min) → live per-browser fallback fetch
```

### Data sources (all CORS-open / fetched server-side)
- **FirstEnergy** = Kübra Storm Center. instance `6c715f0e-bbec-465f-98cc-0b81623744be`,
  view `db9c3f02-0a06-4672-a357-0f676eb75bfa`. 3-step chain: `currentState` → `configuration/{deploymentId}`
  → township `report.json`. Returns OHIO → counties → townships with `cust_a.val` (out), `cust_s` (served),
  `etr`, `gotoMap.bbox` (centroid). Intermittently 403s datacenter IPs → collector sends browser
  UA/Referer/Origin + retries 4×.
- **Cleveland Public Power** = City of Cleveland ArcGIS. Web map item `88719296c67e4874b0bdd2abd91658b2`
  has a `definitionExpression` (`FEEDER_ID1 IN (...)`) listing feeders currently out; query the hosted
  feature layer `CPPFeederAreas_BufferXMBuff100v3/FeatureServer/0` for those feeders' approx affected
  accounts (`COUNT_`) + polygons. CPP data is **approximate** (accounts within ~100m of a feeder).
- **Weather** = NWS `api.weather.gov/alerts/active?area=OH`, mapped to NE Ohio counties by `areaDesc`.
  ALL alert types count as "weather" (incl. heat).
- **ZIP search** = `api.zippopotam.us/us/{zip}` (client-side).
- Map tiles CARTO dark; Leaflet 1.9.4 + Leaflet.heat 0.2.0 (unpkg, pinned + SRI).

---

## 3. Operational setup (already done — don't redo)

- **Default branch** set to `claude/first-energy-restoration-tracker-m185by` (required so the
  scheduled workflow registers; Pages also serves from it).
- **GitHub Pages** enabled, "Deploy from a branch" → that branch, `/(root)`. `.nojekyll` present.
- **Actions** enabled, **Workflow permissions = Read and write** (so the bot can commit).
- **cron-job.org pinger** (the reliable 15-min trigger): POST `https://api.github.com/repos/iamimaginary/Restoration-tracker/dispatches`,
  headers `Authorization: Bearer <fine-grained PAT>`, `Accept: application/vnd.github+json`,
  `X-GitHub-Api-Version: 2022-11-28`; body `{"event_type":"collect"}`. Success = HTTP 204.
  - **PAT**: fine-grained, this repo only, **Contents: Read and write**, **expires ~2027-06-15**.
    When it expires the pings 401 — user must mint a new token and paste it into cron-job.org.
- **Self-monitor**: if the FirstEnergy fetch fails and the last good data is >90 min old, the
  collector exits non-zero → GitHub emails the owner. Transient 403s are silent (retry/next cycle).

---

## 4. `state.json` schema (shared snapshot)

```
{
  schema, collectedAt,
  activeStorm:{startedAt}|null, belowSince|null,
  stormLog:[{startedAt,endedAt,durationHrs,peakTotal,peakAt,topCounties:[{name,peak}]}],
  fe:{ updatedAt, counties:[{name,out,served,etr,loc:[lat,lng],subs:[{id,name,out,served,etr,loc}]}] },
  cpp:{ updatedAt, accounts, feeders:[...], features:[geojson] },
  peaks:{ "<COUNTY or areaId>": peak },  cppPeak,
  history:[{t,out}],                 // NE Ohio total (capped 1500)
  countyHistory:{ COUNTY:[{t,out}] }, // capped 1000
  cityHistory:{ areaId:[{t,out}] },   // capped 96 pts, ≤300 cities (restored pruned first)
  cppHistory:[{t,out}],
  reliability:{ areaId:{ name,county,served,obs,firstT,lastT,outHrs,custHrs,outTimeHrs,timeHrs,
                         peakFrac,events,outHrsBlue,outTimeBlueHrs,blueEvents } },
  etrStats:{ COUNTY:{promises,met,missed,sumOverrunHrs,etrChanges,_epActive,_epEtr,_epChanges} },
  etrCity:{ areaId:{county,name,...same etr fields...} },
  weather:{ updatedAt, counties:{COUNTY:[events]}, alerts:[{id,event,severity,counties,onset,ends}] },
  weatherLog:[{id,event,severity,counties,onset,ends,firstSeen,lastSeen}],
  relDay:{day,outHrs,custHrs}, relTrend:[{day,availPct}],   // daily NE Ohio availability
  _feUpdatedAt, _cppUpdatedAt
}
```
Fields with `_` prefix are internal accumulators. The page exports a superset via "Export JSON".

---

## 5. Features (all implemented)

**Page = tabbed SPA** (`#now #map #trends #reliability #storms #about` deep-link hashes; sticky tab bar;
slim one-line disclaimer up top, full text in About). Always-visible: live status, search (city/ZIP),
refresh, auto-refresh, sort, "show all FE counties", export.

- **Now**: hero summary stats; "Top movers" (cities with biggest change since last update, under their
  county); county cards (status accent, mini outage-over-time sparkline, restoration rate, drill-down);
  CPP panel; **📍 My City** pin (localStorage; pin from search; live status + reliability).
- **Map**: Leaflet. Modes via segmented control — **City/Township** & **County** (bubbles sized by out,
  colored by status) and **Heatmap** (faint county choropleth + city-level density via Leaflet.heat,
  fallback colored dots). **Storm playback** (play/pause + time slider scrubs markers/heat through the
  stored snapshots; "Live" resets). Search drops a pin with full stats.
- **Trends**: NE Ohio outage trend chart + daily **reliability trend** (availability/day).
- **Reliability** (gated ~3 days of data, then keeps averaging): **utility comparison** (Ohio Edison vs
  Illuminating, customer-weighted availability); **City reliability** (availability grade A+–F = ASAI-style
  `1 − Σ(out·dt)/Σ(served·dt)`, outage frequency, interruptions/avg duration = SAIFI/CAIDI-ish, "blue-sky"
  outages = no NWS alert + no active regional storm = possible infrastructure issues); **FirstEnergy ETR
  accuracy & stability** (met/missed by promised time + **ETR churn** = revisions per outage, incl. live
  "↻ revised N× this outage"; tap a county → its cities).
- **Storms**: auto storm log (archived events) + per-storm **Share** (copies summary + `#storms` link).
- **About**: how-it-works, weather/blue-sky, privacy, open-data link (`tracker-data/state.json`),
  report numbers, trademark/attribution.

**Restoration rate** (everywhere): linear slope over the last ~2.5 h (with sparse-data fallback to the
previous point). Label: `▼ ~Xh to clear (~N restored/hr)` where **ETA = out ÷ rate** (consistent;
re-measured each update; >48 h → "restoring slowly"); `↔ holding steady` when change isn't meaningful
(< max(5/hr, 1% of out)); `▲ rising (~N added/hr)`; `✓ fully restored`.

**Auto storm lifecycle** (no manual reset): storm begins when total ≥ **2000** out; ends/archives when
total ≤ **max(500, 2% of peak)** for **3 continuous hours** (then peaks/histories clear, next storm
auto-starts). `reliability`/`etrStats`/`etrCity`/`relTrend`/`weatherLog` persist across resets.

**Resilience**: anomaly guard clamps out to [0, served] and refuses empty reports; page falls back to live
data if the shared snapshot is >25 min stale; `prefers-reduced-motion` supported.

---

## 6. Conventions / how to make changes

- **Single-file page**: edit `index.html`. Validate before committing:
  - JS: extract last `<script>` block → `node --check`.
  - CSS: `{` count == `}` count.
  - Element IDs referenced by `getElementById` all exist.
- **Collector**: `node --check scripts/collect.mjs`; can run locally (`node scripts/collect.mjs` writes
  `data/state.json`) — delete `data/` after local tests, never commit a local seed.
- **Deploy**: push to the code branch → Pages rebuilds (~1 min; there's CDN lag, hard-refresh / `?v=` if
  needed). Collector changes take effect on the next pinger run, or trigger now via
  `actions_run_trigger` (workflow_dispatch) and verify `tracker-data` advanced + `state.json` shape.
- **Time-sensitive data "clocks"** (populate over days, not instantly): reliability (~3 days gate), ETR
  accuracy/churn, reliability trend. When adding such a metric, add the COLLECTOR capture first so the
  clock starts.
- **git push**: `git push -u origin <branch>`, retry w/ backoff on network errors. Commit message footer:
  `https://claude.ai/code/session_01SGku8uEBX8acPHhzCXrDAd` (per environment rules). Don't create PRs
  unless asked.
- **GitHub ops** via the `mcp__github__*` tools (no `gh` CLI). Scope limited to this repo.
- Can't visually preview in-session (no browser) — rely on syntax/structure checks + the user testing on
  their phone.

---

## 7. Open items / pending decisions

- **Storm re-intensification split (OPEN QUESTION the user was deciding):** if a storm never drops below
  the restored-level before a new storm hits, the two **merge** into one logged event (peak = max of both,
  no data loss, but not distinguished). Offered an optional conservative "split on re-intensification"
  rule (recover well below peak, then surge back above start threshold → archive + restart). User had not
  decided. Default (merge) is intentionally chosen to avoid over-splitting one storm into phantom events.
- **Remaining queued features (not built):**
  1. **Outage cause** (tree/equipment/etc.) — needs Kübra's incident-level feed (different endpoint than
     the township report). *This was next up; verify the incident feed first.*
  2. **Push notifications** ("alert when my city changes") — needs service worker + permission; iOS only
     for installed PWA, limited background; untestable from session.
  3. **Cross-check source** (e.g., poweroutage.us) for redundancy/anomaly validation.
  4. **Coverage expansion** — Toledo Edison (NW Ohio, already in the FE feed) / AEP / Duke.
  5. **Token-expiry reminder** — only partly doable (page can't read PAT expiry; static note at best).
- Honest take: My City, reliability, ETR (accuracy+churn), heatmap, playback, storm log are the
  high-value core. Remaining items are diminishing returns unless push alerts or statewide coverage matter.

## 8. Known caveats
- GitHub `schedule` cron is unreliable (sparse) — the cron-job.org pinger is the real heartbeat.
- ETA is a straight-line projection (out ÷ current rate) → slightly optimistic on the slow tail; consistent
  with the displayed rate by design (we reverted an exponential model that contradicted the rate).
- CPP availability isn't directly comparable to FE (feeder-level approximate) — excluded from utility comparison.
- ZIP→city pairing is best-effort (USPS place name vs feed township naming); falls back to centering the map.
- Reliability/ETR/churn numbers start accumulating from when each was deployed; storms before then aren't in them.
