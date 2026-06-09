# Polymarket proxy (Cloudflare Worker)

A tiny read-only proxy so visitors in regions where Polymarket is geo-blocked
(e.g. Switzerland) can still load the odds. The browser calls this Worker, which
fetches from Polymarket's Gamma API on Cloudflare's network (a non-blocked IP)
and returns the JSON with CORS headers.

It only forwards `GET /events` and `GET /tags/...` and only accepts the app's
own origins — it is not an open proxy.

## Deploy (one time, ~5 min)

1. Go to **dash.cloudflare.com → Workers & Pages → Create → Worker**.
2. Name it (e.g. `wc-proxy`) and **Deploy** the starter.
3. Click **Edit code**, paste the contents of [`worker.js`](./worker.js), **Deploy**.
4. Copy the Worker URL, e.g. `https://wc-proxy.<your-subdomain>.workers.dev`.
5. Put that URL in `CONFIG.proxyBase` in [`../app.js`](../app.js) (no trailing slash).

The app tries Polymarket directly first; only if that fails (blocked/offline)
does it retry through the proxy. The friendly error appears only if both fail.

## Notes

- **Free**: Workers' free plan allows 100,000 requests/day.
- **Custom domain (optional)**: map the Worker to e.g. `api.gonnafind.com` in the
  Worker's *Triggers → Custom Domains*, then use that as `proxyBase`.
- If you add origins (new domains), update `ALLOW_ORIGINS` in `worker.js`.
