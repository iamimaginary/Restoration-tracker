# Northeast Ohio Power Restoration Tracker

An unofficial, near-live dashboard that tracks power-outage and restoration progress across
Northeast Ohio. It reads **public** outage feeds from **FirstEnergy** (Ohio Edison & The
Illuminating Company, via the Ohio Storm Center) and **Cleveland Public Power**, and presents
outages, recovery-from-peak, per-area trends, a map, ETR tracking, weather context, and an
archive of completed outage events.

> **Unofficial — not affiliated with or endorsed by FirstEnergy or Cleveland Public Power.**
> For emergencies call **911**. To report an outage: FirstEnergy 1-888-LIGHTSS
> (1-888-544-4877); Cleveland Public Power (216) 664-3156. Always treat the utilities'
> own channels as authoritative.

## What it does now

- **Now** — FirstEnergy customers out, event peak (with the time it occurred), recovered from
  peak, change since the last snapshot, per-county/township cards, a "top movers" list, a
  "why the power's out" cause breakdown, and a separate Cleveland Public Power card.
- **Map** — outage map by city/township, county, or heatmap; scrub the playback slider to
  watch an event progress over time.
- **Trends** — the NE Ohio outage curve over collected snapshots, with weather-alert shading.
- **Reliability** — experimental long-run per-city reliability and FirstEnergy ETR-accuracy
  stats, derived from accumulated snapshots.
- **Events** — completed outage events, auto-archived as each one is restored, each replayable
  on the map like weather radar.
- **About** — methodology, confidence levels, privacy, and the open-data link.

## Data sources

| Source | What it provides | Confidence |
| --- | --- | --- |
| FirstEnergy Ohio Storm Center (KUBRA) | Customers out per county and city/township; utility ETRs; per-incident causes | High (raw utility counts) |
| Cleveland Public Power (City of Cleveland ArcGIS) | Out-of-service distribution **feeders** and an **approximate** count of affected accounts | Medium (estimate / not per-customer) |
| National Weather Service | Active alerts for NE Ohio counties (weather context) | High (official alerts) |
| poweroutage.us | Independent cross-check of FE/CPP totals when reachable | Best-effort (often blocked) |

**FirstEnergy and Cleveland Public Power are different measurements and are never added into a
single "customers out" total.** CPP affected-account areas can overlap and are not equivalent
to FirstEnergy per-customer outage counts.

## How the data flows (shared snapshot model)

- A scheduled GitHub Actions job (`scripts/collect.mjs`) collects the feeds **about every 15
  minutes** and commits one shared snapshot to the `tracker-data` branch as
  [`state.json`](https://raw.githubusercontent.com/iamimaginary/Restoration-tracker/tracker-data/state.json),
  plus per-event replay files under `tracker-data/storms/`.
- The page (`index.html`, served via GitHub Pages) **checks for a new snapshot every 5
  minutes**. So the displayed data is **near-live**, not live: the browser checks every 5 min,
  but the underlying data only updates ~every 15 min. The **Data health** bar near the top
  shows each source's collection time, the snapshot age, and a freshness label
  (**Fresh** < 20 min · **Stale** 20–45 min · **Very stale** 45+ min).
- If the shared snapshot is missing or stale, the page falls back to fetching the utility feeds
  **directly in your browser** (shown as "Live feed"), appending to the shared baseline.

## Key metrics

- **Recovered from peak** = `(peak − current) / peak`, clamped 0–100% (0 when no peak has been
  observed). This is recovery from the event's observed peak — **not** the share of all
  customers who have power.
- **Event peak** = the single highest *simultaneous* total seen in the collected history (shown
  with its timestamp), not the sum of per-area peaks.
- **Utility ETR** = the restoration time published by the utility (or "none given"). The app's
  "restoration rate" / time-to-clear figures are separate **experimental** estimates derived
  from the observed decline, not utility commitments.

## Outage events (archiving)

When NE Ohio outages fall to a low baseline and stay there, the current event is closed and
archived to the **Events** tab with its peak, duration, customer-hours lost, recovery
milestones, hardest-hit counties, likely causes, and weather. A per-event replay file is also
written so the event can be played back on the map. "Storm" is only used where weather appears
to be the cause; otherwise events are described neutrally.

## Confidence labels

- **High confidence** — raw utility outage counts (FirstEnergy).
- **Medium confidence** — approximations such as CPP affected-account estimates.
- **Experimental** — derived analytics: reliability scores, ETR-accuracy, cause classification,
  and the app's own restoration estimates.

## Known limitations

- Near-live, not real-time; the snapshot can lag and is occasionally stale if the collector is
  delayed (the Data health bar makes this visible).
- CPP figures are approximate, area/feeder-based, and not directly comparable to FE counts.
- Reliability and ETR-accuracy stats need days of data to stabilize.
- Cause classification and app restoration estimates are heuristic.
- poweroutage.us cross-check is frequently blocked by bot protection and simply omitted then.

## Privacy

No accounts, cookies, analytics, or tracking. The shared snapshot is fetched from GitHub; map
tiles and ZIP lookups from OpenStreetMap/CARTO and zippopotam.us; in fallback mode, data from
FirstEnergy (kubra.io) and Cleveland Public Power's ArcGIS. Those services see your IP address,
as any website would. An optional **pinned area** is stored **only in your browser's
`localStorage`** — it is never uploaded, shared, or included in the public snapshot, and there
is **no default or personal location** in the public view. Clear it anytime with its × button.

## Local development

It's a single static file plus a Node collector — no build step.

```bash
# View the app (any static server works; it fetches the live shared snapshot)
python3 -m http.server 8000      # then open http://localhost:8000

# Run the collector once (writes data/state.json + data/storms/)
node scripts/collect.mjs
```

`index.html` is fully self-contained (HTML/CSS/JS in one file). `scripts/collect.mjs` is the
data collector. There are no dependencies to install for the page itself.

## Deployment / update workflow

- The page is published with **GitHub Pages** from the repo's app branch.
- The collector runs on a **GitHub Actions schedule** (~every 15 min), committing fresh
  snapshots to the `tracker-data` branch, which the page reads at runtime.
- The shared dataset is public, reusable JSON:
  [`tracker-data/state.json`](https://raw.githubusercontent.com/iamimaginary/Restoration-tracker/tracker-data/state.json).

## Open data

The shared dataset (current outages, peaks, histories, reliability, ETR-accuracy, weather, and
the event archive) is public JSON — reuse it freely. Per-event replay files live under
`tracker-data/storms/`.
