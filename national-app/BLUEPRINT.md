# National outage app — blueprint

A national power-outage app where a user picks their locale and is guided to the right utility's data.
It **reuses the NE-Ohio app's engine wholesale** (map, trends, reliability, ETA + self-scoring, storm
lifecycle, replay) and the whole agent-maintenance harness (config-driven markets, pure golden-tested
adapters, reconciliation gate, feedback loop). What's *new* is a thin **locale → market routing shell**
and **per-market sharded serving**.

This is a SEPARATE app/repo from the NE-Ohio one (which stays single-market by design).

## The one new idea: locale → market routing

The NE-Ohio app loads one `state.json` and renders it. The national app adds a front door:

```
landing → user enters ZIP / address / picks state
        → resolve locale to the market(s) that serve it   (lib/locale.mjs + markets/registry.json)
        → if >1 utility serves them, let them pick
        → load THAT market's data shard  (data/<market-id>.json)
        → render with the existing engine (unchanged)
```

So the engine never changes — it always renders "one market's state.json." The shell just decides *which*
shard to hand it.

## Architecture

```
markets/registry.json     index of all markets: coverage (state+counties) + data shard url + status
markets/<id>.json         per-market config (scope/geo/sources) — same schema as the NEO app
adapters/<vendor>.mjs     pure raw→canonical parsers, golden-tested (kubra already covers FE nationwide)
lib/locale.mjs            ZIP/address/state → candidate markets (matches against the registry)
scripts/collect.mjs       the SAME collector, run once per market (matrix), writing data/<id>.json
index.html                the SAME render engine, wrapped in the locale shell; loads the resolved shard
```

- **Serving stays static/serverless.** Each market is a JSON shard on a CDN/object store (or a data
  branch to start). The client loads the registry once, then only the resolved market's shard — never
  the whole country. No database, no server.
- **Collection is a matrix.** One scheduled job per market (`MARKET=<id> node scripts/collect.mjs`),
  each writing its own shard. Adding a market adds a matrix entry, not infrastructure.
- **Agent maintenance is identical.** A market is a config (+ a registry entry); a broken vendor is a
  fixture-backed golden-test PR; reconciliation gates each market; feedback carries the locale so
  market-requests route to the right roadmap.

## Coverage strategy (how "national" grows without a team)

1. **FirstEnergy footprint, free.** The `kubra` adapter already parses FE's StormCenter; FE uses one
   instance with a **per-state view**, so OH, PA, WV, MD, NJ, NY are each just a `markets/<id>.json` +
   registry entry. (PA is proven — see `markets/pennsylvania.json`.) That's six states on day one.
2. **By vendor, not by utility.** Most US utilities sit behind a few outage-map vendors. One Kübra
   adapter and one ArcGIS adapter already cover a large share; add a vendor adapter, light up many.
3. **Licensed aggregate as the backdrop.** For locales you don't yet cover in detail, a national
   aggregate feed (e.g. PowerOutage.us) gives a coarse "regional view + we don't have your utility yet"
   so the locale picker never dead-ends. (You already use it as a reconciliation cross-check.)

## Locale resolution (the one genuinely new component)

`lib/locale.mjs` turns what the user gives you into candidate markets:

- **State pick** → markets whose `coverage.state` matches. Simplest, always works.
- **ZIP** → state (+ lat/lon) via the existing `api.zippopotam.us`, then market(s) for that state;
  if several utilities overlap, disambiguate by lat/lon against each market's geo, or just ask.
- **Address** → geocode → same as ZIP.

County/feeder-level precision (when two utilities split a state) is a refinement, not a blocker — start
state-level, tighten with point-in-polygon against each market's county geojson as those land.

## Build sequence

- **Phase A — routing shell + 2 markets.** Stand up the repo from the NEO base; add the registry,
  `lib/locale.mjs`, and a locale picker in `index.html`; shard the data path (`data/<id>.json`). Prove
  routing with **neo-ohio + pennsylvania**.
- **Phase B — multi-market collection + serving.** Matrix collect → per-market shards; move serving to a
  CDN/object store when the data branch gets heavy.
- **Phase C — breadth.** Add the rest of the FE states (kubra views), then other vendors; add county
  geojsons for the heatmap/disambiguation.
- **Phase D — fallback + search.** Licensed aggregate backdrop for uncovered locales; address search.

See `ASSEMBLY.md` for the exact files to copy/change to create the repo, and `CLAUDE.md` for the
agent-maintenance runbook.
