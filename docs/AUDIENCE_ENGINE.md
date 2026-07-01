# Audience engine — NE Ohio tracker (deferred, noted for later)

The audience-acquisition work (handoff v2) is being built on **Outage Atlas first**; the same patterns
get mirrored onto this NE Ohio tracker afterward. This file records the deferred plan so it's not lost.

**Status: NOT STARTED — noted for later.** Do not build until asked.

## Domain

- A **second, dedicated domain** for this deployment is being acquired (Atlas uses `outageatlas.com`;
  this app is a separate deployment with its own domain).
- **Domain name: TBD** — the owner will provide the exact hostname. Until then, do not hardcode a name
  into `CNAME`, canonical, OG, `robots.txt`, or `sitemap.xml`.

## Phase 1 to mirror from Atlas (when greenlit)

Atlas Phase 1 (commit on branch `claude/outage-atlas-v2-handoff-qs2a3y`) is the template. Apply the same,
dependency-free, no-build treatment here:

1. **PWA** — `manifest.json` + vanilla `sw.js` (cache-first shell, network-first `state.json` snapshot
   with offline fallback) + registration with a "new version" refresh prompt. NEO ships a single
   `state.json` (not sharded), so the SW's data rule is simpler than Atlas's.
2. **SEO unlock** — **remove the `noindex` meta** (index.html line ~8) + add `robots.txt` + `sitemap.xml`.
   Atlas had no noindex; NEO does — this is the key extra step here.
3. **OG/Twitter card meta** + `theme-color` (already present: `#0f1722`). Reuse the existing brand.
4. **Domain wiring** — `CNAME` (TBD) on the served branch + document DNS records; enforce HTTPS.

## NEO-specific differences from Atlas (do NOT copy Atlas blindly)

- **Brand is orange, not blue.** NEO uses `#ff7a18` on bg `#0f1722` (see the existing inline SVG
  apple-touch-icon). Generate NEO icons/OG in orange — do not reuse Atlas's blue bolt. `scripts/gen_icons.mjs`
  in the Atlas repo is a good starting point; re-palette it.
- **Lighter commercial branding + prominent "unofficial / not affiliated with FirstEnergy".** Per the
  handoff compliance note, this app runs on scraped-utility data, so keep monetization/branding
  conservative and the disclaimer prominent on every shared/monetized surface. Atlas (ODIN/DOE public
  data) is the surface to commercialize first.
- **Single market by design.** Per CLAUDE.md, this repo is NE-Ohio-only — SEO area pages (Phase 4) stay
  within the NEO county/city scope; do not turn this into a multi-region app.

## When ready

Owner to provide: the exact domain, and a go-ahead to build. Then mirror Atlas Phase 1 here with the
differences above.
