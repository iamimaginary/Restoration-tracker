// Reconciliation gate — the safety net against a "wrong but passing" adapter fix. An adapter can
// satisfy its golden test yet still mis-parse live data; this catches it by checking that our summed
// county total agrees with the utility's OWN published headline (and, when available, the independent
// poweroutage.us figure) within the market's tolerance. Reads a local state.json path or a URL.
//
//   node scripts/check_reconciliation.mjs [path-or-url] [marketId]
//
// Defaults: data/state.json, market neo-ohio. Exits non-zero on a breach.
import { readFileSync } from "node:fs";

const arg = process.argv[2] || process.env.STATE_SOURCE || "data/state.json";
const marketId = process.argv[3] || process.env.MARKET || "neo-ohio";
const market = JSON.parse(readFileSync(new URL(`../markets/${marketId}.json`, import.meta.url), "utf8"));
const tol = (market.reconciliation && market.reconciliation.tolerancePct) || 15;
const FLOOR = 500;   // ignore tiny totals where rounding/masking dominates

async function load(src) {
  if (/^https?:\/\//.test(src)) { const r = await fetch(src, { cache: "no-store" }); if (!r.ok) throw new Error(`fetch ${src} → ${r.status}`); return r.json(); }
  return JSON.parse(readFileSync(src, "utf8"));
}

const pct = (a, b) => Math.abs(a - b) / Math.max(b, 1) * 100;

const state = await load(arg);
const cc = (state.crosscheck && state.crosscheck.internal) || {};
const pou = state.crosscheck && state.crosscheck.poweroutage;
const fails = [], notes = [];

// (1) internal: our county sum vs the utility's own published total — the primary adapter-health check
if (cc.feSum != null && cc.feOfficial != null && Math.max(cc.feSum, cc.feOfficial) >= FLOOR) {
  const d = pct(cc.feSum, cc.feOfficial);
  (d > tol ? fails : notes).push(`internal: our sum ${cc.feSum} vs utility-published ${cc.feOfficial} → ${d.toFixed(1)}% (tol ${tol}%)`);
} else notes.push("internal: below floor or missing — skipped");

// (2) independent: our sum vs poweroutage.us (looser — different methodology; informational unless wildly off)
if (pou && pou.fe && pou.fe.out != null && cc.feSum != null && Math.max(cc.feSum, pou.fe.out) >= FLOOR) {
  const d = pct(cc.feSum, pou.fe.out);
  (d > tol * 3 ? fails : notes).push(`independent: our sum ${cc.feSum} vs poweroutage ${pou.fe.out} → ${d.toFixed(1)}% (tol ${tol * 3}%)`);
}

const age = state.collectedAt ? ((Date.now() - state.collectedAt) / 60000).toFixed(0) + " min old" : "age unknown";
console.log(`reconciliation [${marketId}] (${age}):`);
for (const n of notes) console.log("  · " + n);
for (const f of fails) console.error("  ✗ " + f);
if (fails.length) { console.error(`\nRECONCILIATION FAILED (${fails.length}) — likely a mis-parsing adapter or a bad source.`); process.exit(1); }
console.log("  ✓ within tolerance");
