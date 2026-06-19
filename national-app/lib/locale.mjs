// Locale → market resolver. Turns what a user gives you (state pick / ZIP / address) into the
// market(s) that serve them, by matching against markets/registry.json. Runs in the browser (the
// locale shell) and is also unit-testable in Node. Deliberately small: state-level routing always
// works; county/geo refinement is layered on top when a state has overlapping utilities.
//
// Usage (browser):
//   const reg = await fetch("markets/registry.json").then(r => r.json());
//   const hits = await resolveZip(reg, "44114");        // → [{ market, why }]
//   loadShard(hits[0].market.dataUrl);

// All markets whose coverage matches a state (+ optional county). county is matched case-insensitively
// against coverage.counties; a market with no counties list is treated as covering the whole state.
export function marketsFor(registry, state, county) {
  const st = String(state || "").toUpperCase();
  const co = county ? String(county).toUpperCase().replace(/\s+COUNTY$/, "").trim() : null;
  return (registry.markets || []).filter((m) => {
    const c = m.coverage || {};
    if (String(c.state || "").toUpperCase() !== st) return false;
    if (!co || !Array.isArray(c.counties) || !c.counties.length) return true;
    return c.counties.map((x) => x.toUpperCase()).includes(co);
  });
}

// State pick → candidates. Always works; the floor of the routing.
export function resolveState(registry, state) {
  return marketsFor(registry, state).map((market) => ({ market, why: `serves ${state}` }));
}

// ZIP → candidates. Uses the free api.zippopotam.us (already allowed in the NEO app's CSP) for
// state + lat/lon, then narrows by state. If several markets overlap a state and we have a point,
// the caller can disambiguate by distance/geojson; otherwise present the choices to the user.
export async function resolveZip(registry, zip, fetchImpl = fetch) {
  const z = String(zip || "").trim();
  if (!/^\d{5}$/.test(z)) throw new Error("ZIP must be 5 digits");
  const r = await fetchImpl(`https://api.zippopotam.us/us/${z}`);
  if (!r.ok) throw new Error(`unknown ZIP ${z}`);
  const data = await r.json();
  const place = (data.places && data.places[0]) || {};
  const state = place["state abbreviation"];
  const loc = { lat: Number(place.latitude), lon: Number(place.longitude), place: place["place name"], state };
  const candidates = marketsFor(registry, state);
  return candidates.map((market) => ({ market, loc, why: `${loc.place}, ${state}` }));
}

// Optional refinement when >1 market covers the locale and we have a point: nearest market by the
// centroid of its coverage bbox (markets/<id>.json geo.bbox = [N,E,S,W]). A stand-in until per-market
// county geojson enables true point-in-polygon.
export function nearestByBbox(candidatesWithLoc, bboxById) {
  const dist = (lat, lon, b) => { const clat = (b[0] + b[2]) / 2, clon = (b[1] + b[3]) / 2; return (lat - clat) ** 2 + (lon - clon) ** 2; };
  return [...candidatesWithLoc].sort((a, b) => {
    const ba = bboxById[a.market.id], bb = bboxById[b.market.id];
    if (!ba || !bb || !a.loc) return 0;
    return dist(a.loc.lat, a.loc.lon, ba) - dist(b.loc.lat, b.loc.lon, bb);
  });
}
