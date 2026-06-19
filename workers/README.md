# Feedback intake worker

Serverless endpoint for the in-app feedback widget. Receives the widget's POST, **sanitizes** it (keeps
PII out of the public repo), rate-limits + spam-filters, and opens a `feedback`+`triage` GitHub issue an
agent picks up. See `docs/FEEDBACK.md` for the pipeline and triage rules.

## Deploy

```sh
cd workers
# 1. (recommended) rate-limit + private email store
wrangler kv namespace create RL          # paste the id into wrangler.toml [[kv_namespaces]]
# 2. set the GitHub token (needs `issues: write` on REPO)
wrangler secret put GH_TOKEN
# 3. set REPO + ALLOW_ORIGIN in wrangler.toml (ALLOW_ORIGIN = your page's origin)
wrangler deploy
```

## Wire the page to it

In the deployment that serves `index.html`, set:

```html
<script>window.FEEDBACK_ENDPOINT = "https://feedback-intake.<your>.workers.dev";</script>
```

…and add that origin to the `connect-src` of the CSP `<meta>` in `index.html`, or the browser blocks the
POST. With no endpoint set, the widget falls back to a prefilled GitHub issue the user submits themselves.

## Why a worker (not direct-to-GitHub)

The browser must not hold a GitHub token, and raw feedback must be **sanitized** before it touches a
public repo. The worker is the trust boundary: it strips PII, rate-limits, and is the only thing holding
the token. Treat everything it forwards as untrusted (see the guardrails in `CLAUDE.md`).
