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
  deceleration, and the winner is the sector under the pointer. Sectors show
  only team flags (`teams[].logo`); names and percentages live in the legend to
  avoid cramped, redundant on-wheel text.
- **Live updates**: matches whose kick-off (UTC `startTime`) has passed are
  flagged **LIVE**; while any game is live the odds re-fetch every 30s and the
  footer shows the last-updated time in the viewer's local timezone. Resolved
  games drop out automatically (the API only returns `closed=false`).
- **Loading splash**: a spinner overlays the wheel while odds are fetched
  (the full World Cup payload can take a few seconds).
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

## Files

| File           | Role                                              |
| -------------- | ------------------------------------------------- |
| `index.html`   | Structure and layout                              |
| `styles.css`   | Styles (dark theme, responsive, loading splash)   |
| `app.js`       | Data (Polymarket), normalization and the wheel    |

> For entertainment purposes only. Data from Polymarket (Gamma API).
