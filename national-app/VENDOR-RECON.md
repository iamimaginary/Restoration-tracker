# Vendor reconnaissance — which outage tracker each market uses

Coverage scales by **adapter**, not by utility: most US utilities don't build their own outage map,
they buy one from a handful of vendors. This is the recon that tells us which adapters buy us the most
country. Method: probed each utility's live outage map and classified by signature
(`kubra.io`/`stormcenter` → Kübra; `arcgis.com`/`FeatureServer` → Esri; Angular SPA / none → custom).

## The headline

**Kübra is the dominant outage-map vendor for large US IOUs — and we already have that adapter.** Every
utility confirmed Kübra below is parseable *today* by `adapters/kubra.mjs` (proven across FE-OH and
FE-PA). Onboarding one is a `markets/<id>.json` with its instance/view, **not** new adapter code.

## Evidence (probed live)

### Kübra — confirmed by signature  ✅ (covered by our existing adapter)
| Utility | Footprint (approx) | Notes |
|---|---|---|
| FirstEnergy | OH, PA, WV, MD, NJ, NY (~6M) | one instance, per-state view; OH+PA proven |
| Dominion Energy | VA, NC, SC (~4M) | |
| Entergy | AR, LA, MS, TX (~3M) | |
| ConEd | NY (~3.5M) | `apps.coned.com/stormcenter` |
| ComEd (Exelon) | IL (~4M) | |
| Eversource | CT, MA, NH (~4M) | |
| PSEG | NJ (~2.3M) | |
| Georgia Power (Southern) | GA (~2.7M) | |
| Alabama Power (Southern) | AL (~1.5M) | |
| Oncor | TX (~4M, T&D) | `stormcenter.oncor.com` |

That's **~35M+ customers already reachable with the adapter we have** — just config per utility.

### Esri / ArcGIS — confirmed  ✅ (we have a CPP-specific adapter; needs generalizing)
| Utility | Footprint | Notes |
|---|---|---|
| Southern California Edison | CA (~5M) | `js.arcgis`/FeatureServer |
| Consumers Energy | MI (~1.9M) | FeatureServer |
| Cleveland Public Power | OH (muni) | already in the NEO app (`arcgis-cpp.mjs`) |

ArcGIS is also the common pattern for **municipals and co-ops** (hundreds of small utilities) — a
generalized FeatureServer adapter is high-leverage for the long tail.

### Custom / in-house — probed, not a known vendor  ⚠️ (one-off adapter each)
| Utility | Footprint | Signal |
|---|---|---|
| Duke Energy | ~8M, multi-state | custom Angular SPA at `outagemap.duke-energy.com` |
| Pepco/Exelon (newer) | DC/MD | custom Angular SPA — Exelon appears to be migrating opcos off Kübra; **verify per-opco** |
| PG&E | CA (~5.5M) | custom |
| DTE Energy | MI (~2.3M) | custom |
| Florida Power & Light | FL (~5.8M) | custom |
| CenterPoint | TX (~2.5M) | custom (rebuilt after 2024) |
| APS, Puget Sound Energy | AZ, WA | custom |

### Unconfirmed — blocked/JS-gated, re-probe needed  ❓
AEP, National Grid, PPL, Ameren, Xcel, BGE, Tampa Electric. (Several are commonly Kübra in the wild;
returned empty here behind bot protection — worth a deeper probe before classifying.)

## Adapter roadmap (prioritized by coverage-per-adapter)

1. **Kübra — DONE.** Highest ROI by far. No new code; onboard utilities by config. Start with the
   confirmed list above (biggest first). ~35M+ customers.
2. **Generalize the ArcGIS/Esri adapter** (extend `arcgis-cpp.mjs` → a generic FeatureServer parser).
   Unlocks SCE, Consumers, and the muni/co-op long tail.
3. **Licensed aggregate backdrop** (PowerOutage.us) for everything not yet covered in detail, so the
   locale picker never dead-ends — coarse "regional view, your utility isn't detailed yet."
4. **Custom one-offs, biggest first** — Duke (~8M), FPL (~5.8M), PG&E (~5.5M), DTE, CenterPoint. Each is
   its own adapter + golden fixtures; only worth it once the cheap Kübra/ArcGIS coverage is in.

## Onboarding a Kübra utility (agent-maintainable flow)

The instance/view GUIDs live in each utility's outage page (how FE-PA was found):

1. Fetch the utility's outage map page; extract the two `…-…-…-…-…` GUIDs (instance + view).
2. Hit `kubra.io/stormcenter/api/v1/stormcenters/<instance>/views/<view>/currentState` to confirm.
3. Write `markets/<id>.json` (instance/view/referer + county scope + bbox/weather), add a registry entry.
4. `MARKET=<id> node scripts/collect.mjs` → `check_reconciliation.mjs` (our sum vs the utility's own
   total) must pass. PR → gates.

This is a clean, repeatable task for an agent — config + one verification, no engine work.

## Caveats

Vendor choices change (Exelon's apparent Kübra→custom migration is the live example), and bot protection
hid several maps from this pass. Treat this as a living document: re-probe before committing an adapter,
and let the reconciliation gate catch a misclassification (a wrong vendor won't reconcile).
