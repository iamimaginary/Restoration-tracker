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
| Cross-check scraper | `scripts/poweroutage.mjs` (Playwright, best-effort) → `pou.json` |
| Deps manifest | `package.json` (declares `playwright`); `.gitignore` (node_modules, pou.json, data/) |
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
                                  scripts/poweroutage.mjs (headless Chromium, best-effort) ─▶ pou.json
                                                                          scripts/collect.mjs
                                            fetches FirstEnergy (Kübra) + CPP (ArcGIS) + NWS alerts
                                            reads pou.json → embeds independent cross-check
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
- **Independent cross-check** = `poweroutage.us/area/state/ohio`. Cloudflare-protected + its data API
  requires a browser-issued session, so plain fetch is **blocked** — but a real headless Chromium clears
  the challenge and the page is **server-rendered**, so the per-utility numbers are in the DOM.
  `scripts/poweroutage.mjs` (Playwright) scrapes the by-utility breakdown → `pou.json`
  (`{ok,fetchedAt,updatedText,ohio,utilities:[{id,name,out,tracked}]}`). Key rows: **FirstEnergy = utility
  `121`** (all-Ohio FE; matches our county-sum), **Cleveland Public Power = utility `1468`** (a *truly
  independent* CPP check, different upstream than our ArcGIS feed). Best-effort: any failure leaves
  `crosscheck` absent and the page hides the badge. The browser **never fetches poweroutage** (CSP/CORS
  would block it) — only the CI scraper does; the page just reads the result from `state.json`.
- **Outage causes (per-incident)** = Kübra cluster tiles, fetched **client-side on-demand** by the page (Map tab
  → "show causes"). Endpoint template is `currentState.data.cluster_interval_generation_data` =
  `cluster-data/{qkh}/<guid>/<intervalId>` → full URL `https://kubra.io/<that>/public/cluster-5/{quadkey}.json`,
  where **`{qkh}` = the quadkey's last 3 chars reversed** (CDN shard) and `{quadkey}` is a Bing/z quadkey.
  Tiles are gzip (CORS `*`, browser auto-decompresses). Items are quadtree-clustered: `desc.cluster=true` →
  aggregate bubble; `cluster=false` → individual incident with `desc.cause`/`crew_status`/`cust_a`/`etr`
  (`{EN-US,orig}` objects), position in `geom.p[0]` (Google polyline, **precision 5**). The page fetches only
  the tiles covering the current viewport at the current zoom (no descent, no server cost). Cause is NOT in the
  county/township rollup — only here. NOTE: aggregate "leading causes" panel was deferred (a full crawl costs
  ~250 fetches even in blue-sky, balloons in storms) — see open items.
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
- **Cross-check step (CI only)**: the workflow runs `npm install`, caches `~/.cache/ms-playwright`
  (key `playwright-Linux-1.61.0` — bump when the playwright version in `package.json` changes), then
  `npx playwright install --with-deps chromium`, then the scraper with `continue-on-error: true`.
  On GitHub runner IPs Cloudflare blocks it (managed challenge), so it **fast-fails** (2 attempts in one
  reused browser context, well under a minute) and the badge falls back to the always-on internal check.
  On a clear IP it succeeds in ~2-4 s. Wait on `domcontentloaded` + the "Customers Out" text, **never
  `networkidle`** (poweroutage streams continuously → networkidle never fires → 60 s timeout even on a
  page that loaded fine; that was the bug in the very first CI run). Any failure only drops the
  poweroutage layer; core collection is unaffected.

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
  etrStats:{ COUNTY:{ promises,met,missed,sumOverrunHrs,
                      etrChanges,         // lifetime total revisions (undirected; legacy/migration)
                      etrSlips,etrPullIns,// DIRECTIONAL: push-backs (ETR moved later, counts against stability) vs pull-ins (moved earlier, good)
                      _epActive,_epEtr,_epChanges,_epSlips,_epPullIns } },   // current-outage accumulators
  etrCity:{ areaId:{county,name,...same etr fields...} },
  weather:{ updatedAt, counties:{COUNTY:[events]}, alerts:[{id,event,severity,counties,onset,ends}] },
  weatherLog:[{id,event,severity,counties,onset,ends,firstSeen,lastSeen}],
  relDay:{day,outHrs,custHrs}, relTrend:[{day,availPct}],   // daily NE Ohio availability
  crosscheck:{                                              // hybrid data cross-check
    internal:{ feOfficial, feServedOfficial,               // FirstEnergy's OWN published OH totals (Kübra)
               feSum, feServedSum,                          // our sum across all counties (should match feOfficial)
               nOut },                                      // FE's own active-incident count
    poweroutage:{ fetchedAt, updatedText, ohio:{out,tracked},  // independent (or null — usually null in CI)
                  fe:{out,tracked}, cpp:{out,tracked},
                  ours:{ fe:<all-OH FE sum>, cpp:<our CPP accounts> } } | null },
  _feUpdatedAt, _cppUpdatedAt
}
```
Fields with `_` prefix are internal accumulators. The page exports a superset via "Export JSON".

---

## 5. Features (all implemented)

**Page = tabbed SPA** (`#now #map #trends #reliability #storms #about` deep-link hashes; sticky tab bar;
slim one-line disclaimer up top, full text in About). Always-visible: live status, search (city/ZIP),
refresh, auto-refresh, sort, "show all FE counties", export.

- **Now**: hero summary stats; **data cross-check badge** (`renderCrosscheck()`, hybrid) — *always* checks our
  FirstEnergy county-sum vs FirstEnergy's OWN published Ohio total (green ✓ "matches FirstEnergy's official
  total", yellow ⚠ + delta if they diverge → dropped county / parse bug); *when present* also layers in the
  independent poweroutage.us comparison ("also confirmed independently…" or a divergence note, tolerances FE
  max(75,4%) / CPP max(40,8%)); "Top movers" (cities with biggest change since last update, under their
  county); county cards (status accent, mini outage-over-time sparkline, restoration rate, drill-down); CPP
  panel; **📍 My City** pin (localStorage; pin from search; live status + reliability).
- **Map**: Leaflet. Modes via segmented control — **City/Township** & **County** (bubbles sized by out,
  colored by status) and **Heatmap** (faint county choropleth + city-level density via Leaflet.heat,
  fallback colored dots). **Storm playback** (play/pause + time slider scrubs markers/heat through the
  stored snapshots; "Live" resets). Search drops a pin with full stats. **"show causes" toggle** overlays
  FirstEnergy's individual incidents (cause/crew/ETR) for the current viewport, loaded live client-side from
  Kübra cluster tiles (`renderCauses`/`loadCauses`, `causeLayer`); zoom drives cluster→incident resolution.
- **Trends**: NE Ohio outage trend chart + daily **reliability trend** (availability/day).
- **Reliability** (gated ~3 days of data, then keeps averaging): **utility comparison** (Ohio Edison vs
  Illuminating, customer-weighted availability); **City reliability** (availability grade A+–F = ASAI-style
  `1 − Σ(out·dt)/Σ(served·dt)`, outage frequency, interruptions/avg duration = SAIFI/CAIDI-ish, "blue-sky"
  outages = no NWS alert + no active regional storm = possible infrastructure issues); **FirstEnergy ETR
  accuracy & stability** (met/missed by promised time + **directional ETR churn** — revisions are split into
  **push-backs** [ETR moved *later*; the reliability-relevant instability metric → "N push-backs/outage",
  live "↻ ETR pushed back N×"] vs **pull-ins** [moved *earlier* = restored sooner than promised → shown as a
  positive "▲ beat estimate N×" / "▲ moved up N×"]; sorted & headlined by push-backs; tap a county → its
  cities). Page helpers `etrSlips()`/`etrLiveSlips()` fall back to the undirected `etrChanges` for records
  predating direction tracking.
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
  1. ~~**Outage cause** (tree/equipment/etc.)~~ — **map version DONE** (this session): on-demand client-side
     incident overlay on the Map tab (see Data sources → "Outage causes"). STILL PENDING: the **aggregate
     "leading causes" panel** (storm-wide breakdown like "Weather 70%, Trees 12%…"). It needs a budget-capped
     quadtree crawl in the collector (full descent ≈250 fetches blue-sky / far more in storms, on the same
     kubra.io host as the core feed) producing `causes:{sampledAt,totalCust,knownCust,byCause}` in state.json.
     User chose "both, map first" — aggregate panel is the agreed next step for this item.
  2. **Push notifications** ("alert when my city changes") — needs service worker + permission; iOS only
     for installed PWA, limited background; untestable from session.
  3. ~~**Cross-check source** (poweroutage.us)~~ — **DONE** (this session), **hybrid**. We *proved* poweroutage's
     Cloudflare reliably blocks GitHub runner IPs (the headless scrape got the unsolvable "Just a moment…"
     managed challenge 6/6 in CI; it does succeed from cleaner IPs in ~2-4 s). So the cross-check is two-layer:
     (a) **internal, always-on** — our FE county-sum vs FirstEnergy's own published OH total (same Kübra feed)
     catches dropped-county/parse/stale bugs; (b) **independent, best-effort** — `scripts/poweroutage.mjs`
     (fast-fail, 2 attempts) populates `crosscheck.poweroutage` only when reachable (e.g. if run from a
     residential host / via a proxy). To make poweroutage work from CI you'd need a residential proxy or a
     CF-bypass scraping API (paid, ToS-gray) — the collector reads `pou.json` from `$POU_FILE`, so any external
     process can supply it. Future: surface poweroutage's per-county rows, or add AEP/Duke from the same scrape.
  4. **Coverage expansion** — Toledo Edison (NW Ohio, already in the FE feed) / AEP / Duke. *(Note: the
     poweroutage scrape already pulls AEP/Duke/AES Ohio totals into `pou.json` — easy seed for this.)*
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
- Cross-check is **scraping** a server-rendered page (no stable contract). If poweroutage restructures the DOM
  or changes utility IDs, `scripts/poweroutage.mjs` may yield `ok:false` — the badge just hides (core collection
  unaffected). The selectors to maintain: `a[href*="/area/utility/<id>"]` cards whose text contains
  "Customers Out" / "Customers Tracked". A small FE delta during an active storm is normal (scrape vs collect
  run seconds apart) and absorbed by the match tolerance.
