# Assembling the national app repo

You create the repo; this is the exact recipe. The national app = the NE-Ohio app's engine + the
locale-routing shell. Don't rewrite anything — copy the engine, then apply the deltas below.

## 1. Seed from the NEO repo

```sh
git clone <neo-ohio-repo> national-outage && cd national-outage
git remote set-url origin <your-new-repo>
```

You now have the engine, `adapters/`, `scripts/collect.mjs`, the gates (`test_adapters.mjs`,
`check_reconciliation.mjs`), the feedback `workers/`, and `index.html` for free.

## 2. Drop in the national pieces (from this `national-app/` folder)

- `markets/registry.json` + `markets/neo-ohio.json` + `markets/pennsylvania.json`  (replace `markets/`)
- `lib/locale.mjs`
- `.github/workflows/collect.yml`  (the matrix version — replaces the single-market one)
- `CLAUDE.md`  (the national runbook — replaces the NEO one)

## 3. Code deltas (small, surgical)

**a. Shard the collector output.** In `scripts/collect.mjs`, make the write path per-market:

```js
const STATE_PATH = process.env.STATE_PATH || `data/${MARKET}.json`;   // was "data/state.json"
```

That's the only collector change — it's already market-config-driven otherwise.

**b. Render from the shard only (the big client simplification).** The NEO `index.html` also fetches
Kübra/ArcGIS *directly* in the browser. For the national app, **drop the client-side live fetch and
render purely from the collected shard.** This removes almost all per-market client coupling (no
client-side instance/view, no per-vendor fetch, a much simpler CSP) and it scales — the browser never
hits utility APIs. The ~15-min shard cadence is plenty. Concretely: delete the client's `fetchFE`/
`fetchCPP` paths and point the existing loader at the resolved market's `dataUrl`.

**c. Add the locale shell** to `index.html`:
1. On load, `fetch("markets/registry.json")`.
2. If no saved locale → show the picker (state dropdown + ZIP box). Resolve with `lib/locale.mjs`
   (`resolveZip` / `resolveState`); if >1 candidate, let the user pick the utility.
3. Set the active market, `localStorage` it, and load `market.dataUrl` into the existing renderer.
4. A "change location" control re-opens the picker.

**d. Make the market-specific UI conditional:** hide the CPP section unless the market's `state.json`
has a `cpp` block (already null for non-CPP markets); show the heatmap only when the market has a
`geo.countiesGeoJson`; set the page title/`MARKET_ID` from the resolved market.

**e. CSP:** `connect-src` now needs only the data host (the shard + registry) and `api.zippopotam.us`
(ZIP lookup). With client-side live fetch removed, you can drop `kubra.io`/`arcgis.com`.

**f. Feedback:** set `window.FEEDBACK_REPO`/`FEEDBACK_ENDPOINT` to the new repo's; the widget already
captures the resolved `market`, so feedback is correctly attributed.

## 4. Serve it

- **Static site** (`index.html`, `markets/registry.json`, `lib/`, county geojsons) on GitHub Pages or a
  CDN. **Data shards** (`data/<id>.json`) on the `tracker-data` branch to start; move to object storage +
  CDN when it gets heavy.
- **Collection:** the matrix `collect.yml` runs each market; add an external pinger (repository_dispatch)
  for steady 15-min cadence. Seed each market's first shard with a manual `workflow_dispatch`.

## 5. Verify (the same gates, per market)

```sh
node scripts/test_adapters.mjs                                  # adapters still parse
for m in neo-ohio pennsylvania; do
  MARKET=$m STATE_PATH=/tmp/$m.json node scripts/collect.mjs    # each market collects
  node scripts/check_reconciliation.mjs /tmp/$m.json $m         # each reconciles
done
node -e 'import("./lib/locale.mjs").then(async L=>{const reg=require("./markets/registry.json");
  console.log(L.marketsFor(reg,"OH","CUYAHOGA").map(m=>m.id), L.marketsFor(reg,"PA","ERIE").map(m=>m.id));})'
```

## 6. Add the rest of the FirstEnergy states (cheap wins)

Each FE state is the same `kubra` adapter + a different StormCenter view. Grab the view from the state's
outage page (`outages-<st>.firstenergycorp.com` exposes the instance + view GUIDs), then add a
`markets/<st>.json`, a registry entry, and a matrix line. WV/MD/NJ/NY in, one config each.
