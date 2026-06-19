// Feedback intake — a Cloudflare Worker that receives the in-app widget's POST, sanitizes it (no PII
// into the public repo), rate-limits + spam-filters, and opens a labeled GitHub issue an agent triages.
// Deploy: see workers/README.md. The widget (index.html) POSTs here when window.FEEDBACK_ENDPOINT is set.
//
// Bindings (wrangler.toml / secrets):
//   GH_TOKEN  (secret)  — token with `issues: write` on REPO
//   REPO      (var)     — "owner/name"
//   ALLOW_ORIGIN (var)  — the site origin allowed to POST (CORS)
//   RL        (KV, optional) — rate-limit + private email store

const cors = (origin) => ({
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
});

// strip the obvious PII so it never lands in a public issue (email kept privately for replies)
function sanitize(s) {
  return String(s || "")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/\b(\+?\d[\d\s().-]{7,}\d)\b/g, "[phone]")
    .replace(/\b\d{1,6}\s+[A-Za-z0-9.\s]{2,40}\b(st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|ct|court|way|pkwy)\b\.?/gi, "[address]");
}

export default {
  async fetch(req, env) {
    const origin = env.ALLOW_ORIGIN || "*";
    if (req.method === "OPTIONS") return new Response(null, { headers: cors(origin) });
    if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: cors(origin) });

    let f;
    try { f = await req.json(); } catch { return new Response("bad json", { status: 400, headers: cors(origin) }); }

    const message = String(f.message || "").trim();
    if (message.length < 3 || message.length > 4000) return new Response("message length", { status: 422, headers: cors(origin) });

    // spam heuristics: too many links, or obvious junk
    const links = (message.match(/https?:\/\//g) || []).length;
    if (links > 3) return new Response("rejected", { status: 422, headers: cors(origin) });

    // rate-limit per IP (best-effort; needs the RL KV binding)
    const ip = req.headers.get("CF-Connecting-IP") || "anon";
    if (env.RL) {
      const key = `rl:${ip}`;
      const n = Number((await env.RL.get(key)) || 0);
      if (n >= 5) return new Response("rate limited", { status: 429, headers: cors(origin) });
      await env.RL.put(key, String(n + 1), { expirationTtl: 3600 });
    }

    const clean = sanitize(message);
    const ctx = {
      market: f.market, snapshotAt: f.snapshotAt, view: f.view,
      appVersion: f.appVersion, hash: f.hash, ua: String(f.ua || "").slice(0, 200), ts: f.ts
    };
    const body = `${clean}\n\n---\nContext (auto-captured):\n\`\`\`json\n${JSON.stringify(ctx, null, 2)}\n\`\`\``;

    const res = await fetch(`https://api.github.com/repos/${env.REPO}/issues`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        "User-Agent": "feedback-intake",
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ title: `[feedback] ${clean.slice(0, 60)}`, labels: ["feedback", "triage"], body })
    });
    if (!res.ok) return new Response("issue create failed", { status: 502, headers: cors(origin) });

    // keep the (PII) email OUT of the public repo — stash it privately, keyed to the issue, for replies
    if (env.RL && f.email) {
      const issue = await res.json();
      await env.RL.put(`email:${issue.number}`, String(f.email).slice(0, 120), { expirationTtl: 60 * 60 * 24 * 90 });
    }
    return new Response(JSON.stringify({ ok: true }), { headers: { ...cors(origin), "Content-Type": "application/json" } });
  }
};
