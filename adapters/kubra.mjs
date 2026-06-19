// Kübra StormCenter adapter. Kübra hosts FirstEnergy AND a large share of US utilities behind the
// same API shape, so this one parser generalizes to many markets — only markets/<id>.json changes
// (instance/view/referer). This module is the PURE part: raw report.json -> canonical model. The
// fetch orchestration (currentState -> configuration -> report) lives in the collector; this is what
// breaks when Kübra changes their schema, so it's isolated here and golden-tested against fixtures.
//
// Fix loop for an agent: a failing snapshot auto-captures the raw report to adapters/fixtures/kubra/.
// Reproduce with `node scripts/test_adapters.mjs`, edit parseKubraReport until the fixture passes the
// schema + expected output, open a PR. The reconciliation CI gate guards against a wrong-but-passing fix.

// out can never be negative or exceed served (Kübra occasionally returns masked/garbage values)
const sane = (val, served) => { const o = (typeof val === "number" && isFinite(val)) ? Math.max(0, val) : 0; return served > 0 ? Math.min(o, served) : o; };
// bbox [W_lon, S_lat, E_lon, N_lat] -> [lat, lon] centroid
const centroid = (b) => (b && b.length === 4) ? [(b[1] + b[3]) / 2, (b[0] + b[2]) / 2] : null;

// raw Kübra report.json -> { official, areas } (canonical). Throws on a structurally empty report.
export function parseKubraReport(report) {
  const fd = report && report.file_data;
  if (!fd || !Array.isArray(fd.areas) || !fd.areas[0]) throw new Error("kubra: report.file_data.areas[0] missing");
  const st = fd.areas[0];
  const tot = fd.totals || {};
  const areas = (st.areas || []).map((c) => {
    const served = c.cust_s || 0;
    return {
      name: c.name,
      out: sane(c.cust_a && c.cust_a.val, served),
      served,
      etr: c.etr || null,
      loc: centroid(c.gotoMap && c.gotoMap.bbox),
      subs: (c.areas || []).map((s) => {
        const ss = s.cust_s || 0;
        return {
          id: s.areaId || (c.name + "|" + s.name),
          name: s.name,
          out: sane(s.cust_a && s.cust_a.val, ss),
          served: ss,
          etr: s.etr || null,
          loc: centroid(s.gotoMap && s.gotoMap.bbox)
        };
      })
    };
  });
  const official = { out: (tot.cust_a && tot.cust_a.val) || 0, served: tot.cust_s || 0, nOut: tot.n_out || 0 };
  return { official, areas };
}
