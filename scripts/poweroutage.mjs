// Independent cross-check scraper (best-effort).
//
// poweroutage.us aggregates outage counts from utilities nationwide. Its pages
// sit behind Cloudflare and its data API requires a browser-issued session, so a
// plain fetch is blocked — but a real (headless) Chromium clears the challenge,
// and the Ohio page is server-rendered, so the numbers are right there in the DOM.
//
// We pull the per-utility breakdown for Ohio and write a tiny pou.json:
//   { ok, fetchedAt, updatedText, ohio:{out,tracked}, utilities:[{id,name,out,tracked}] }
// collect.mjs reads it (if fresh) and compares poweroutage's FirstEnergy and
// Cleveland Public Power figures against our own, embedding the result in
// state.json as `crosscheck`. This is supplementary: any failure here must never
// block the core collection, so we always exit 0 and just mark ok:false.

import { writeFileSync } from "node:fs";

const OUT_FILE = process.env.POU_FILE || "pou.json";
const URL = "https://poweroutage.us/area/state/ohio";
const NAV_TIMEOUT = 35000;       // domcontentloaded fires fast; this is just a safety cap
const ATTEMPT_WAIT_MS = 12000;   // per-attempt wait for the figures (a CF interstitial fails fast → retry)
const MAX_ATTEMPTS = 6;          // CF's challenge is probabilistic + IP-reputation based; reusing one
                                 // context across attempts lets a cf_clearance cookie persist, so once
                                 // we get through, the rest are instant.
const SETTLE_MS = 800;           // let the utility cards finish hydrating

const num = s => { const m = String(s||"").replace(/,/g,"").match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : null; };

function writeResult(obj){
  try { writeFileSync(OUT_FILE, JSON.stringify(obj)); } catch(e){ console.error("pou write failed:", e.message); }
}

async function scrape(){
  let chromium;
  try { ({ chromium } = await import("playwright")); }
  catch(e){ console.error("playwright not installed:", e.message); return { ok:false, reason:"no-playwright" }; }

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage"]
  });
  try {
    const ctx = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      viewport: { width: 1366, height: 900 }, locale: "en-US",
      ignoreHTTPSErrors: true,                                  // some networks MITM TLS; harmless in CI
      extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" }
    });
    await ctx.addInitScript(() => {                             // basic anti-automation fingerprint
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
    const page = await ctx.newPage();

    // NOTE: don't wait for "networkidle" — poweroutage polls/streams continuously, so it never
    // goes idle and the nav would time out even though the page rendered fine. The Ohio figures
    // are server-rendered, so once we're past Cloudflare they're in the DOM near-instantly.
    // Cloudflare's challenge is hit-or-miss per request; retry in the SAME context so a
    // cf_clearance cookie (once earned) carries the remaining attempts straight through.
    let lastTitle = null;
    for(let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++){
      try {
        await page.goto(URL, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
        await page.waitForFunction(() => /Customers Out/i.test(document.body.innerText || ""), { timeout: ATTEMPT_WAIT_MS });
        await page.waitForTimeout(SETTLE_MS);

        const data = await page.evaluate(() => {
          const txt = document.body.innerText || "";
          const grab = re => { const m = txt.match(re); return m ? m[1] : null; };
          const ohio = {
            out: grab(/Customers Out\s*([\d,]+)/i),
            tracked: grab(/Customers Tracked\s*([\d,]+)/i),
          };
          const updatedText = grab(/Updated\s*([^\n]+?ago)/i);
          // Each utility renders a detail card linking to /area/utility/<id> whose text
          // reads "<Name> Updated Xm ago <out> Customers Out <tracked> Customers Tracked …".
          const seen = new Set(), utilities = [];
          document.querySelectorAll('a[href*="/area/utility/"]').forEach(a => {
            const t = (a.innerText || "").replace(/\s+/g, " ").trim();
            if(!/Customers Out/i.test(t)) return;                       // skip bare nav links
            const id = (a.getAttribute("href").match(/\/area\/utility\/(\d+)/) || [])[1];
            if(!id || seen.has(id)) return;
            seen.add(id);
            const name = t.split(/\s+Updated\b/i)[0].trim();
            const out = (t.match(/([\d,]+)\s*Customers Out/i) || [])[1];
            const tracked = (t.match(/([\d,]+)\s*Customers Tracked/i) || [])[1];
            utilities.push({ id, name, out, tracked });
          });
          return { ohio, updatedText, utilities };
        });

        if(data.utilities.length){
          if(attempt > 1) console.error(`pou: cleared on attempt ${attempt}`);
          return {
            ok: true,
            fetchedAt: Date.now(),
            updatedText: data.updatedText || null,
            ohio: { out: num(data.ohio.out), tracked: num(data.ohio.tracked) },
            utilities: data.utilities.map(u => ({ id: u.id, name: u.name, out: num(u.out), tracked: num(u.tracked) }))
              .filter(u => u.out != null)
          };
        }
        // content text present but no utility cards yet — fall through and retry
      } catch(e){
        lastTitle = await page.title().catch(() => null);   // usually "Just a moment..." when challenged
        console.error(`pou attempt ${attempt} blocked/slow (${lastTitle || e.message.slice(0,40)})`);
      }
      if(attempt < MAX_ATTEMPTS) await page.waitForTimeout(1200 + attempt * 600);   // brief backoff
    }
    const blocked = /just a moment|attention required|access denied|verify you are human/i.test(lastTitle || "");
    return { ok:false, reason: blocked ? "cloudflare-block" : "no-content", title: lastTitle };
  } finally {
    await browser.close().catch(()=>{});
  }
}

(async () => {
  let result;
  try { result = await scrape(); }
  catch(e){
    console.error("pou scrape failed:", e.message);
    result = { ok:false, reason:"exception", message:e.message };
  }
  writeResult(result);
  if(result.ok){
    const fe = result.utilities.find(u => u.id === "121" || /firstenergy/i.test(u.name));
    const cpp = result.utilities.find(u => u.id === "1468" || /cleveland public power/i.test(u.name));
    console.log(`pou ok: ohio=${result.ohio.out} FE=${fe?fe.out:"?"} CPP=${cpp?cpp.out:"?"} (${result.utilities.length} utilities, ${result.updatedText||"?"})`);
  } else {
    console.log(`pou unavailable: ${result.reason||"?"}`);
  }
  process.exit(0);                              // never fail the workflow on cross-check trouble
})();
