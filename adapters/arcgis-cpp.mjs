// Cleveland Public Power adapter (Esri/ArcGIS FeatureServer pattern — shared by many municipal/co-op
// utilities). The fetch (webmap item → feeder list → FeatureServer query) stays in the collector; these
// are the PURE parse steps that break when the vendor changes their schema, so they're isolated here and
// golden-tested against adapters/fixtures/arcgis-cpp/*.json.
//
// CPP is a single utility reported by feeder, not the county/subs canonical shape — so this adapter is
// vendor-specific ({accounts, feeders, features}) rather than the {official, areas} model. The collector
// folds it into the NE-Ohio total separately.

// The webmap's "Approximate Outage" layer encodes the currently-out feeders in its SQL
// definitionExpression (e.g. FEEDER_ID1 IN ('A','B')). Pull the distinct quoted ids out of it.
export function parseOutageFeederIds(webmapData) {
  const layer = ((webmapData && webmapData.operationalLayers) || []).find((l) => /Approximate Outage/i.test(l.title || ""));
  const expr = (layer && layer.layerDefinition && layer.layerDefinition.definitionExpression) || "";
  return [...new Set((expr.match(/'([^']*)'/g) || []).map((s) => s.slice(1, -1).trim()).filter(Boolean))];
}

// FeatureServer geojson for those feeders -> { accounts, feeders, features }. accounts is the summed
// customer COUNT_; only features with both geometry and properties count.
export function parseCppFeatures(geojson) {
  const features = ((geojson && geojson.features) || []).filter((f) => f && f.geometry && f.properties);
  const accounts = features.reduce((s, f) => s + (Number(f.properties.COUNT_) || 0), 0);
  const feeders = [...new Set(features.map((f) => String(f.properties.FEEDER_ID1 || "").trim()).filter(Boolean))];
  return { accounts, feeders, features };
}
