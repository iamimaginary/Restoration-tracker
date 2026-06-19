// Canonical outage model — the single shape EVERY source adapter must return, so the analytics
// engine (storm lifecycle, reliability, ETA) never knows or cares which utility/vendor it came from.
//
//   {
//     official: { out, served, nOut },              // the utility's OWN published headline totals
//     areas: [ {                                    // top-level reporting areas (e.g. counties)
//       name, out, served, etr, loc:[lat,lon]|null,
//       subs: [ { id, name, out, served, etr, loc } ]   // sub-areas (e.g. cities/townships/feeders)
//     } ]
//   }
//
// `out` is customers without power; `served` is customers tracked in that area. out is clamped to
// [0, served]. Adding a market = writing markets/<id>.json; adding a vendor = a new adapter that
// fetches its raw payload and returns THIS shape. Keep this contract stable.

const num = (v) => typeof v === "number" && isFinite(v);

function validateNode(n, path, errs, isSub) {
  if (!n || typeof n !== "object") { errs.push(`${path}: not an object`); return; }
  if (typeof n.name !== "string" || !n.name) errs.push(`${path}.name: missing`);
  if (!num(n.out) || n.out < 0) errs.push(`${path}.out: must be a number >= 0`);
  if (!num(n.served) || n.served < 0) errs.push(`${path}.served: must be a number >= 0`);
  if (num(n.served) && num(n.out) && n.out > n.served) errs.push(`${path}.out (${n.out}) > served (${n.served})`);
  if (n.etr != null && typeof n.etr !== "string") errs.push(`${path}.etr: must be string|null`);
  if (n.loc != null && !(Array.isArray(n.loc) && n.loc.length === 2 && n.loc.every(num))) errs.push(`${path}.loc: must be [lat,lon]|null`);
  if (isSub && (typeof n.id !== "string" || !n.id)) errs.push(`${path}.id: missing`);
}

// Returns { ok, errors[] }. Use as the schema CI gate and inside adapter golden tests.
export function validateCanonical(c) {
  const errs = [];
  if (!c || typeof c !== "object") return { ok: false, errors: ["root: not an object"] };
  const o = c.official;
  if (!o || !num(o.out) || !num(o.served) || !num(o.nOut)) errs.push("official: needs numeric {out,served,nOut}");
  if (!Array.isArray(c.areas)) { errs.push("areas: must be an array"); return { ok: false, errors: errs }; }
  if (!c.areas.length) errs.push("areas: empty (refuse to publish a blank snapshot)");
  c.areas.forEach((a, i) => {
    validateNode(a, `areas[${i}]`, errs, false);
    if (!Array.isArray(a.subs)) errs.push(`areas[${i}].subs: must be an array`);
    else a.subs.forEach((s, j) => validateNode(s, `areas[${i}].subs[${j}]`, errs, true));
  });
  return { ok: errs.length === 0, errors: errs };
}
