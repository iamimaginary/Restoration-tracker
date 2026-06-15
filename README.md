# Northeast Ohio Power Restoration Tracker

A single-file, dependency-free dashboard for tracking **FirstEnergy** power-restoration
progress across Northeast Ohio counties (served by **Ohio Edison** and **The Illuminating Company**).

Open `index.html` in any browser — no build step, no server, no internet required.

## Features

- **Summary stats** — total customers without power, peak outage, total restored, overall % restored, counties fully restored.
- **Per-county cards** — currently out, peak, customers served, % restored, status, ETR, and notes for each county. Sorted by who's hardest hit.
- **Restoration trend chart** — save snapshots over time and watch the outage curve come down (custom canvas chart, no libraries).
- **Local persistence** — everything is saved to your browser's `localStorage`.
- **Export / Import JSON** — back up a snapshot or share it with someone else.

Pre-loaded counties: Cuyahoga, Lake, Geauga, Ashtabula, Lorain, Medina, Summit,
Portage, Stark, Wayne, Trumbull, Mahoning, Columbiana.

## How to use

1. Click **+ Add / Update County** and enter the latest figures (pull them from the official map below).
2. Repeat as new numbers are published; click **Save Snapshot** periodically to build the trend line.
3. Use **Export JSON** to keep a record.

## About live data

FirstEnergy's real-time outage feed (a Kubra-hosted map) blocks direct cross-origin
browser requests (CORS), so a standalone HTML page can't pull it automatically without
a backend proxy. This tracker is built around manual/imported figures from the official
sources:

- **Ohio outage map:** https://outages.firstenergycorp.com/oh.html
- **Report an outage:** 1-888-LIGHTSS (1-888-544-4877) or https://www.firstenergycorp.com/

> Disclaimer: Not affiliated with or endorsed by FirstEnergy Corp. For official, authoritative
> outage information always refer to FirstEnergy directly.
