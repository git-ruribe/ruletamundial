# 🎡 World Cup Wheel

Vanilla web app (HTML + CSS + JS, no build, no dependencies) that builds a
**spinning outcome wheel** for World Cup matches using the implied
probabilities from **Polymarket**.

Each match is split into up to three sections — **Team 1**, **Draw** and
**Team 2** — and each section's angle equals the implied probability of that
outcome according to the market. On spin, the wheel lands uniformly: because
sectors are already sized by probability, the result is **weighted by the
odds** automatically.

## Usage

No server or install required — just serve the static files:

```bash
# option 1: open directly
xdg-open index.html      # (or double-click)

# option 2: local server (recommended)
python3 -m http.server 8000
# then open http://localhost:8000
```

1. The app queries Polymarket's **Gamma API** (`gamma-api.polymarket.com`),
   which is public and CORS-enabled — no backend or API key needed.
2. Pick a match from the dropdown (sorted by closing date, soonest first).
3. Hit **Spin**.

## How it works

- **Discovery**: resolves the World Cup tag(s) by slug (`world-cup`,
  `2026-fifa-world-cup`, `fifa-world-cup`) and fetches their active events.
  Matches are identified by Polymarket's **structural sports fields** (not by
  parsing titles): an event is a game when it has a `teams` array and markets
  whose `sportsMarketType === "moneyline"` (the full-time result). This cleanly
  excludes player props, group/outright winners and sub-markets (exact score,
  half-time, …).
- **Normalization**: each moneyline market is a binary *Yes/No* whose "Yes"
  price is that outcome's probability, labelled by `groupItemTitle` and ordered
  by `groupItemThreshold` (0 = home, 1 = draw, 2 = away). Probabilities are
  rescaled to sum to 1 (the *vig*/overround is removed). Team flags come from
  the event's `teams[].logo` and are shown on the wheel and legend.
- **Wheel**: drawn on a `<canvas>`; each sector's angular sweep is
  `prob × 360°`. The spin uses `requestAnimationFrame` with easeOutCubic
  deceleration, and the winner is the sector under the pointer. Each sector
  shows the team flag (`teams[].logo`), name and percentage directly on the
  wheel — there is no separate legend.
- **Why these odds?**: a discreet button next to the match selector opens a
  modal with Polymarket's generated context (`eventMetadata.context_description`)
  explaining the reasoning behind the implied probabilities, plus when that
  analysis was last generated. Hidden for matches without context.
- **Result celebration & sharing**: when a spin lands, a non-blocking result
  card pops up (you can re-spin without dismissing it) and confetti fires — its
  intensity *scales with the surprise*: a heavy favorite gets a light sprinkle,
  a giant-killing gets the full burst and an "Upset / Huge upset" badge (the
  winner is an upset when it wasn't the market favorite, "huge" under 18%). A
  **Share result** button uses the Web Share API to post a generated 1080×1080
  card (winner, flag, "the market gave them X%") to WhatsApp/X/etc.; on browsers
  without file sharing it shares text + link, and on desktop it copies the link.
  Flags in the share image are loaded `crossOrigin` so the canvas stays
  export-safe (a flag that isn't CORS-clean is simply omitted). Confetti and the
  pop animation respect `prefers-reduced-motion`.
- **Live updates**: matches whose kick-off (UTC `startTime`) has passed are
  flagged **LIVE**; while any game is live the odds re-fetch every 30s and the
  footer shows the last-updated time in the viewer's local timezone. Resolved
  games drop out automatically (the API only returns `closed=false`).
- **Loading splash**: a spinner overlays the wheel while odds are fetched
  (the full World Cup payload can take a few seconds).
- **Blocked / offline handling**: requests use a 10s timeout. Each request is
  *hedged* — it tries Polymarket directly first and, if a proxy is configured
  (`CONFIG.proxyBase`) and the direct call is slow (>3s) or fails, it also tries
  the proxy and keeps whichever responds first. A fast direct response means the
  proxy is never called. See [`proxy/`](./proxy) for a free Cloudflare Worker
  that lets visitors who can't reach Polymarket directly still load the odds.
  Only if both fail does a generic "couldn't load the data" overlay appear, with
  a Retry button.
- **Fixed layout**: everything fits within one viewport (`100dvh`, no page
  scroll); the wheel is sized by JS to the leftover space, and toggled
  components (legend, description, result) reserve their height as
  placeholders so nothing jumps as you interact.

## Visitor stats (optional)

A public visitor widget (total visits + countries) is included. It docks to the
side on desktop and opens from an **(i)** button in a modal on mobile. It uses
**[Flag Counter](https://flagcounter.com)** — a static, backend-less embed, so
no API token is exposed.

To enable it:

1. Create a free counter at [flagcounter.com](https://flagcounter.com).
2. Copy your counter **code** (the part of the image URL after `/count2/`).
3. Paste it into `CONFIG.analytics.flagCounter.code` in [`app.js`](./app.js)
   (or paste the full image URL in `src` to keep your own style).

Until configured, the widget shows these setup instructions. Flag Counter
geolocates visitor IPs to derive countries; disclose it in your privacy policy.
For a more privacy-strict, invisible alternative (private dashboard only),
Cloudflare Web Analytics or Plausible can be added with a single `<script>`.

## Configuration

Discovery parameters (tag slugs, keywords, limits) live in the `CONFIG` object
at the top of [`app.js`](./app.js) in case Polymarket changes how matches are
tagged.

## SEO & discoverability

Targeted at the production domain `https://gonnafind.com/`:

- **Meta**: descriptive `<title>` + `<meta description>`, `canonical`, `robots`,
  `theme-color`, keywords.
- **Social**: Open Graph + Twitter Card tags with a 1200×630 share image
  (`og-image.svg`).
- **Structured data**: `WebApplication` JSON-LD.
- **Crawling**: `robots.txt` (allows all, blocks the temporary `explorer.html`,
  links the sitemap) and `sitemap.xml`.
- **PWA / icons**: `favicon.svg`, apple-touch-icon and `site.webmanifest`
  (installable, themed).

> Note: `og-image.svg` works in modern browsers and several scrapers, but a few
> social platforms (Facebook/X) prefer raster images. For maximum preview
> support, export it to a 1200×630 `og-image.png` and switch the `og:image` /
> `twitter:image` URLs to `.png`.

## Files

| File               | Role                                              |
| ------------------ | ------------------------------------------------- |
| `index.html`       | Structure, layout and SEO/meta                    |
| `styles.css`       | Styles (dark theme, responsive, loading splash)   |
| `app.js`           | Data (Polymarket), normalization and the wheel    |
| `favicon.svg`      | Site icon (wheel)                                 |
| `og-image.svg`     | Social share card (1200×630)                      |
| `site.webmanifest` | PWA manifest                                      |
| `robots.txt`       | Crawler directives + sitemap pointer              |
| `sitemap.xml`      | Sitemap                                           |
| `CNAME`            | Custom domain (`gonnafind.com`)                   |

> For entertainment purposes only. Data from Polymarket (Gamma API).
