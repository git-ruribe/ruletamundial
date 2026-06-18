/* ===========================================================================
 * World Cup Wheel — Polymarket odds
 * Vanilla app (HTML + CSS + JS). No build step, no dependencies.
 *
 * Flow:
 *   1. Discover World Cup *matches* via Polymarket's Gamma API (CORS enabled).
 *   2. Normalize each match to sections {label, prob}, removing the "vig"
 *      (probabilities are rescaled to sum to 1).
 *   3. Draw a wheel where each section's angle = prob * 360°.
 *   4. On spin, land uniformly: since sectors are already sized by probability,
 *      the result is naturally weighted by the odds.
 * ===========================================================================*/

'use strict';

/* ----------------------------- CONFIGURATION ----------------------------- */
const CONFIG = {
  gamma: 'https://gamma-api.polymarket.com',
  // Public CLOB market stream: pushes order-book/price events for subscribed
  // outcome tokens (no auth). Used only while a match is live; the 30s REST
  // poll below stays as reconciliation and as the fallback where Polymarket
  // is geo-blocked (the WSS is blocked in the same regions as the REST API).
  clobWss: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
  // Public sports stream: pushes live score/period/elapsed/ended for ALL active
  // games (no auth, no subscription). We filter by gameId to our matches. This
  // makes the scoreline real-time instead of waiting for the 30s REST poll.
  sportsWss: 'wss://sports-api.polymarket.com/ws',
  // Fallback proxy for regions where Polymarket is geo-blocked (e.g. Switzerland).
  // Deploy proxy/worker.js to Cloudflare and paste its URL here (no trailing
  // slash). Leave '' to disable.
  proxyBase: 'https://wc-proxy.zcv25kyj7b.workers.dev',
  // Source-side filter of choice: the Gamma series that groups the World
  // Cup game events. Verified live with explorer.html: series 11433
  // ("FIFA World Cup", ticker soccer-fifwc) covers every match — including
  // one the World Cup tags miss — in a single query family. Events load
  // with /events?series_id=…; the tag queries below are only a fallback.
  // '' disables it (re-verify with the "Buscar series_id" probe).
  seriesId: '11433',
  // Candidate World Cup tag slugs (tried in order). The "filtro óptimo"
  // analysis in explorer.html tells which single tag covers every match —
  // once confirmed, narrow this list and set relatedTags to false.
  worldCupTagSlugs: ['world-cup', '2026-fifa-world-cup', 'fifa-world-cup'],
  // Broaden tag queries to related tags. Costs many extra events; only
  // needed if no single tag carries all the match events.
  relatedTags: true,
  // Tags to exclude server-side (exclude_tag_id) — prop/futures tags that
  // never carry a match. The explorer's combo analysis suggests these.
  excludeTagSlugs: [],
  // Fallback keywords to recognize the World Cup in tags/title/slug.
  worldCupKeywords: ['world cup', 'fifa world cup', 'mundial', 'wc 2026'],
  // Pagination: Gamma caps page sizes, so events are fetched in pages of
  // `pageSize` until a short page arrives or `eventLimit` per tag is reached.
  pageSize: 100,
  eventLimit: 1000,
  // Manual curation (slugs as shown by explorer.html). All lists optional:
  //  - slugPrefixes non-empty → only events whose slug starts with one of
  //    these prefixes are considered (WC match events all use 'fifwc-').
  //  - includeSlugs non-empty → ONLY those exact events are considered.
  //  - excludeSlugs → those events are always dropped.
  filters: {
    slugPrefixes: ['fifwc'],
    includeSlugs: [],
    excludeSlugs: [],
  },
  // Public visitor widget (visits + countries). Uses Flag Counter — a static,
  // backend-less embed. Create a free counter at https://flagcounter.com and
  // paste your code (the part of the image URL after "/count2/") below, OR
  // paste the full image URL in `src` to keep your chosen style.
  analytics: {
    flagCounter: {
      code: 'hwP4',
      src:
        'https://s05.flagcounter.com/countxl/hwP4/bg_000000/txt_FFFFFF' +
        '/border_CCCCCC/columns_3/maxflags_15/viewers_3/labels_0' +
        '/pageviews_1/flags_0/percent_1/',
      href: 'https://info.flagcounter.com/hwP4',
    },
  },
};

// Recognize the "draw" section (to clean the label and colour it neutrally).
const DRAW_RE = /\b(draw|tie|empate)\b/i;
// Recognize the "Yes" outcome of each binary moneyline market.
const YES_RE = /^\s*(yes|s[ií])\s*$/i;

const COLORS = {
  team1: '#2f81f7',
  draw: '#6e7681',
  team2: '#f85149',
};

/* ------------------------------- STATE ----------------------------------- */
const state = {
  matches: [],
  current: null, // { title, sections: [{label, prob, color}], endDate }
  rotation: 0, // radians
  spinning: false,
  // A goal-signal price swing on the selected match that the scoreline feed
  // hasn't confirmed yet. The CLOB price stream reacts to a goal seconds before
  // Sportradar's score lands, so we surface "unexpected swing" in place of the
  // clock until the new score is confirmed (real goal) or it times out (a
  // VAR-overturned goal or price noise that never produces a score change).
  swing: null, // { matchId, at, baseScore }
};

/* ------------------------------ ELEMENTS --------------------------------- */
const el = {
  select: document.getElementById('match-select'),
  refresh: document.getElementById('refresh-btn'),
  status: document.getElementById('status'),
  spin: document.getElementById('spin-btn'),
  result: document.getElementById('result'),
  matchInfo: document.getElementById('match-info'),
  matchInfoScore: document.getElementById('match-info-score'),
  matchInfoWhen: document.getElementById('match-info-when'),
  matchInfoVenue: document.getElementById('match-info-venue'),
  resultText: document.getElementById('result-text'),
  resultLabel: document.getElementById('result-label'),
  resultFlag: document.getElementById('result-flag'),
  shareBtn: document.getElementById('share-btn'),
  shareLabel: document.getElementById('share-label'),
  confetti: document.getElementById('confetti'),
  liveBadge: document.getElementById('live-badge'),
  lastUpdated: document.getElementById('last-updated'),
  whyBtn: document.getElementById('why-open'),
  whyCard: document.getElementById('why-card'),
  whyBackdrop: document.getElementById('why-backdrop'),
  whyClose: document.getElementById('why-close'),
  whyTitle: document.getElementById('why-title'),
  whyBody: document.getElementById('why-body'),
  whyUpdated: document.getElementById('why-updated'),
  loading: document.getElementById('loading'),
  loadError: document.getElementById('load-error'),
  loadErrorText: document.getElementById('load-error-text'),
  retry: document.getElementById('retry-btn'),
  canvas: document.getElementById('wheel'),
  wheelWrap: document.querySelector('.wheel-wrap'),
  wheelSlot: document.querySelector('.wheel-slot'),
};
const ctx = el.canvas.getContext('2d');

/* ------------------------------- HELPERS --------------------------------- */
function setStatus(msg, kind = '') {
  el.status.textContent = msg || '';
  el.status.className = 'status' + (kind ? ` status--${kind}` : '');
}

function showLoading(show) {
  el.loading.hidden = !show;
  if (show) el.loadError.hidden = true;
}

// Friendly, centered error overlay (with a Retry button) over the wheel.
function showError(html) {
  el.loading.hidden = true;
  el.loadErrorText.innerHTML = html;
  el.loadError.hidden = false;
}

// Reserve-space toggle: keeps the element's height as a placeholder when off.
function reserve(elem, show) {
  elem.classList.toggle('is-hidden', !show);
}

// Size the (square) wheel to fit whatever vertical space the slot has left.
function fitWheel() {
  if (!el.wheelSlot) return;
  const size = Math.max(
    120,
    Math.floor(Math.min(el.wheelSlot.clientWidth, el.wheelSlot.clientHeight))
  );
  el.wheelWrap.style.width = `${size}px`;
  el.wheelWrap.style.height = `${size}px`;
}

// Fetch JSON with a hard timeout so a blocked/blackholed request (e.g. where
// Polymarket is geo-blocked) fails fast instead of hanging forever.
async function getJSON(url, timeoutMs = 10000, live = false) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      // Live polling reuses identical URLs every 30s; `no-store` stops the
      // browser from serving a heuristically-cached response (Gamma sends no
      // Cache-Control), which would freeze the score/minute while the WSS keeps
      // the wheel looking live. We only pay that cost on live refreshes — the
      // initial discovery load uses the default cache so a reload paints fast.
      cache: live ? 'no-store' : 'default',
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} at ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Base URL that last worked (direct Gamma or the proxy). Once known, we reuse
// it for the rest of the session so requests stay fast.
let preferredBase = null;
// If the direct API is slow to answer, also try the proxy after this delay and
// keep whichever responds first (a "hedged" request).
const HEDGE_MS = 3000;

// GET a Gamma path (e.g. '/events?…' or '/tags/slug/world-cup'). `live=true`
// bypasses the HTTP cache (for the 30s in-play poll); the default lets the
// initial discovery load be served from cache on reloads.
async function gammaGet(path, live = false) {
  // Known-good base: use it, falling back to the other once on failure.
  if (preferredBase) {
    try {
      return await getJSON(preferredBase + path, undefined, live);
    } catch (e) {
      const other = preferredBase === CONFIG.gamma ? CONFIG.proxyBase : CONFIG.gamma;
      if (!other) throw e;
      const data = await getJSON(other + path, undefined, live);
      preferredBase = other;
      return data;
    }
  }

  const primary = CONFIG.gamma;
  const secondary = CONFIG.proxyBase;
  if (!secondary) {
    const data = await getJSON(primary + path, undefined, live);
    preferredBase = primary;
    return data;
  }

  // Hedged race: start direct; if it's slow or fails, also try the proxy.
  // Whichever returns first wins; only reject if both fail. A fast direct
  // response means the proxy is never even called.
  return new Promise((resolve, reject) => {
    let settled = false;
    let outstanding = 0;
    let secondaryStarted = false;
    let lastErr;
    let hedgeTimer = null;

    const tryBase = (base) => {
      outstanding++;
      getJSON(base + path, undefined, live).then(
        (data) => {
          if (settled) return;
          settled = true;
          if (hedgeTimer) clearTimeout(hedgeTimer);
          preferredBase = base;
          resolve(data);
        },
        (err) => {
          lastErr = err;
          outstanding--;
          if (!secondaryStarted) startSecondary();      // direct failed early
          else if (outstanding === 0) reject(lastErr);   // both failed
        }
      );
    };
    const startSecondary = () => {
      if (settled || secondaryStarted) return;
      secondaryStarted = true;
      tryBase(secondary);
    };

    tryBase(primary);
    hedgeTimer = setTimeout(startSecondary, HEDGE_MS);
  });
}

// outcomes / outcomePrices arrive as a JSON string or already as an array.
function parseList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function pct(p) {
  return `${(p * 100).toFixed(1)}%`;
}

/* --------------------------- DATA LAYER ---------------------------------- */

// Resolve tag ids from slugs (in parallel, so a blocked network fails in one
// timeout window rather than several).
async function resolveTagIds(slugs) {
  const results = await Promise.allSettled(
    slugs.map((slug) => gammaGet(`/tags/slug/${slug}`))
  );
  const ids = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value && r.value.id) ids.push(String(r.value.id));
  }
  return [...new Set(ids)];
}

// Fetch ALL open events under a tag, page by page. A single request used to
// cap the result (the API silently truncates large limits), which left later
// matches out — e.g. only the first ~18 games of the tournament.
async function fetchEventsByTag(tagId, excludeTagIds = [], live = false) {
  const events = [];
  for (let offset = 0; offset < CONFIG.eventLimit; offset += CONFIG.pageSize) {
    const qs = new URLSearchParams({
      closed: 'false',
      limit: String(CONFIG.pageSize),
      offset: String(offset),
      order: 'endDate',
      ascending: 'true',
      related_tags: CONFIG.relatedTags ? 'true' : 'false',
      tag_id: tagId,
    });
    for (const id of excludeTagIds) qs.append('exclude_tag_id', id);
    const page = await gammaGet(`/events?${qs.toString()}`, live);
    if (!Array.isArray(page) || !page.length) break;
    events.push(...page);
    if (page.length < CONFIG.pageSize) break; // short page = no more results
  }
  return events;
}

// Fetch ALL open events of a series (a sports "league" grouping on Gamma —
// for game events this is the tightest server-side filter available).
async function fetchEventsBySeries(seriesId, live = false) {
  const events = [];
  for (let offset = 0; offset < CONFIG.eventLimit; offset += CONFIG.pageSize) {
    const qs = new URLSearchParams({
      closed: 'false',
      limit: String(CONFIG.pageSize),
      offset: String(offset),
      order: 'endDate',
      ascending: 'true',
      series_id: String(seriesId),
    });
    // Cache-buster only on the live poll, where scores must never be stale; the
    // initial load omits it so a reload can be served from the browser cache.
    if (live) qs.set('_t', String(Date.now()));
    const page = await gammaGet(`/events?${qs.toString()}`, live);
    if (!Array.isArray(page) || !page.length) break;
    events.push(...page);
    if (page.length < CONFIG.pageSize) break;
  }
  return events;
}

// Fallback: if no tag is found, fetch events (paginated) and filter by keywords.
async function fetchEventsFallback(live = false) {
  const events = [];
  for (let offset = 0; offset < CONFIG.eventLimit; offset += CONFIG.pageSize) {
    const qs = new URLSearchParams({
      closed: 'false',
      limit: String(CONFIG.pageSize),
      offset: String(offset),
      order: 'endDate',
      ascending: 'true',
    });
    if (live) qs.set('_t', String(Date.now())); // fresh scores only on live poll
    const page = await gammaGet(`/events?${qs.toString()}`, live);
    if (!Array.isArray(page) || !page.length) break;
    events.push(...page);
    if (page.length < CONFIG.pageSize) break;
  }
  return events.filter((ev) => matchesWorldCup(ev));
}

function matchesWorldCup(ev) {
  const haystacks = [
    ev.title, ev.slug, ev.seriesSlug,
    ...(ev.tags || []).map((t) => `${t.label || ''} ${t.slug || ''}`),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return CONFIG.worldCupKeywords.some((k) => haystacks.includes(k));
}

// Build a match from an event using Polymarket's institutional sports fields
// (no title-text parsing). A real game has a `teams` array and full-time
// result markets tagged `sportsMarketType === "moneyline"`; each such market
// is a Yes/No whose "Yes" price is that outcome's probability, labelled by
// `groupItemTitle` and ordered by `groupItemThreshold` (0=home, 1=draw, 2=away).
function eventToMatch(ev) {
  const teams = Array.isArray(ev.teams) ? ev.teams : [];
  const moneyline = (ev.markets || []).filter(
    (m) =>
      m &&
      m.sportsMarketType === 'moneyline' &&
      m.active !== false &&
      m.closed !== true
  );
  if (teams.length < 2 || moneyline.length < 2) return null;

  // Map each team name to its flag/logo image (from the event's `teams`).
  const logoFor = {};
  for (const t of teams) {
    if (t && t.name) logoFor[t.name.trim().toLowerCase()] = t.logo || null;
  }

  const raw = moneyline
    .map((m) => {
      const outs = parseList(m.outcomes);
      const prices = parseList(m.outcomePrices);
      const tokens = parseList(m.clobTokenIds); // aligned with `outcomes`
      const yesIdx = outs.findIndex((o) => YES_RE.test(o));
      const label = (m.groupItemTitle || '').trim();
      return {
        label,
        prob: yesIdx >= 0 ? Number(prices[yesIdx]) || 0 : 0,
        order: Number(m.groupItemThreshold) || 0,
        logo: logoFor[label.toLowerCase()] || null,
        // CLOB token id of the "Yes" outcome — the WSS subscription key.
        token: yesIdx >= 0 ? String(tokens[yesIdx] || '') || null : null,
      };
    })
    .filter((s) => s.label);
  if (raw.length < 2) return null;

  raw.sort((a, b) => a.order - b.order);
  const sections = normalize(raw);

  // Home/away from the teams array (Polymarket tags each with `ordering`).
  const homeTeam = teams.find((t) => t && t.ordering === 'home') || teams[0];
  const awayTeam = teams.find((t) => t && t.ordering === 'away') || teams[1];
  // Live scoreline: the event-level `score` ("H-A") is a real Sportradar/
  // OpticOdds feed, mapped to home/away via the same ordering.
  let score = null;
  const sm = typeof ev.score === 'string' && ev.score.match(/^(\d+)\s*-\s*(\d+)$/);
  if (sm) score = { home: Number(sm[1]), away: Number(sm[2]) };
  // Timestamp of this REST snapshot — lets clockLabel interpolate the
  // displayed minute between 30s fetches rather than jumping in steps.
  const elapsedAt = Date.now();

  // Pre-match probabilities reconstructed from price-change fields:
  // current_raw − oneDayPriceChange ≈ price before kickoff (oneDayPriceChange
  // is preferred because it always predates kickoff; oneHourPriceChange is the
  // fallback for markets where the day field is absent).
  // Calibrate once here so renderScore can call WP.live() cheaply on every tick.
  let lambdas = null;
  if (typeof WP !== 'undefined') {
    const preByThreshold = {};
    for (const m of moneyline) {
      const thr = Number(m.groupItemThreshold);
      const outs = parseList(m.outcomes);
      const prices = parseList(m.outcomePrices);
      const yi = outs.findIndex((o) => YES_RE.test(o));
      if (yi < 0) continue;
      const cur = Number(prices[yi]) || 0;
      const delta = m.oneDayPriceChange != null
        ? Number(m.oneDayPriceChange)
        : m.oneHourPriceChange != null ? Number(m.oneHourPriceChange) : 0;
      preByThreshold[thr] = Math.max(0.001, cur - delta);
    }
    const p0 = preByThreshold[0], p1 = preByThreshold[1], p2 = preByThreshold[2];
    if (p0 > 0 && p1 > 0 && p2 > 0) {
      const tot = p0 + p1 + p2;
      lambdas = WP.calibrate({ h: p0 / tot, d: p1 / tot, a: p2 / tot });
    }
  }

  return {
    id: ev.id,
    title: (ev.title || '').trim() || 'Match',
    sections,
    // End-of-game signals (resolution can lag the final whistle by a while):
    // an explicit `ended` flag if the payload carries one, and how many
    // moneylines still accept orders — books close at the final whistle.
    ended: ev.ended === true,
    // Event-level live feed (Sportradar via Polymarket): live flag, score,
    // minute and period ("1H"/"2H"/"HT"/"FT"). Refreshed on each REST tick.
    live: ev.live === true,
    score,
    elapsed: ev.elapsed != null && ev.elapsed !== '' ? Number(ev.elapsed) : null,
    period: String(ev.period || '').trim(),
    gameId: ev.gameId || null,
    home: homeTeam ? { name: (homeTeam.name || '').trim(), logo: homeTeam.logo || null } : null,
    away: awayTeam ? { name: (awayTeam.name || '').trim(), logo: awayTeam.logo || null } : null,
    lambdas,   // { lh, la } for WP.live(), null when calibration unavailable
    elapsedAt, // Date.now() at fetch time — for interpolating the minute display
    acceptingOpen: moneyline.filter((m) => m.acceptingOrders !== false).length,
    // Venue, when the payload provides one (field coverage varies by event).
    venue: String(ev.venue || (ev.eventMetadata && ev.eventMetadata.venue) || '').trim(),
    // Probabilities as of the last REST snapshot — the baseline the live
    // stream deltas are measured against in the status line.
    baseline: sections.map((s) => ({ label: s.label, prob: s.prob })),
    startTime: ev.startTime || ev.endDate || null,
    endDate: ev.endDate || ev.startTime || null,
    context: ((ev.eventMetadata && ev.eventMetadata.context_description) || '').trim(),
    contextUpdated: (ev.eventMetadata && ev.eventMetadata.context_updated_at) || null,
  };
}
// Remove the "vig": rescale probabilities to sum to 1 and assign colors.
// `raw` (the unscaled Yes price) is kept so live stream prices can replace it
// and the match can be re-normalized in place.
function normalize(sections) {
  const total = sections.reduce((s, x) => s + (x.prob > 0 ? x.prob : 0), 0);
  return sections.map((s, i) => {
    const prob = total > 0 ? Math.max(s.prob, 0) / total : 1 / sections.length;
    const isDraw = DRAW_RE.test(s.label);
    let color;
    if (isDraw) color = COLORS.draw;
    else color = i === sections.length - 1 ? COLORS.team2 : COLORS.team1;
    // Clean up Polymarket's verbose draw label "Draw (A vs. B)" → "Draw".
    const label = isDraw ? 'Draw' : s.label;
    return { label, prob, raw: Math.max(s.prob, 0), color, logo: s.logo || null, token: s.token || null };
  });
}

// Recompute de-vigged probabilities from the sections' current raw prices.
function renormalizeMatch(match) {
  const total = match.sections.reduce((s, x) => s + (x.raw > 0 ? x.raw : 0), 0);
  for (const s of match.sections) {
    s.prob = total > 0 ? Math.max(s.raw, 0) / total : 1 / match.sections.length;
  }
}

function endTime(match) {
  const t = match.endDate ? Date.parse(match.endDate) : NaN;
  return Number.isNaN(t) ? Infinity : t;
}

// A match is "live" once its kickoff (startTime, in UTC) has passed and it is
// still listed (Polymarket drops resolved games). Capped to a ~3h window so a
// stale unresolved game doesn't stay "live" forever. All math is epoch-based,
// so it is correct regardless of the viewer's timezone.
const LIVE_WINDOW_MS = 3 * 60 * 60 * 1000;
// Polymarket resolves markets well after the final whistle, so "still listed"
// over-reports liveness. A match counts as ended when the event says so, or
// when its books stopped accepting orders past the ~100-minute mark (early
// order pauses are in-play reviews, not the end; they re-open within a tick).
const ENDED_MIN_MINUTES = 100;
function matchEnded(match) {
  if (!match) return false;
  if (match.ended) return true;
  const s = match.startTime ? Date.parse(match.startTime) : NaN;
  if (Number.isNaN(s)) return false;
  const mins = (Date.now() - s) / 60000;
  return mins > ENDED_MIN_MINUTES && (match.acceptingOpen || 0) < 2;
}

function isLive(match) {
  const s = match && match.startTime ? Date.parse(match.startTime) : NaN;
  if (Number.isNaN(s)) return false;
  const now = Date.now();
  return now >= s && now < s + LIVE_WINDOW_MS && !matchEnded(match);
}

// `live=true` (the 30s in-play poll) bypasses the HTTP cache so scores stay
// fresh; the default (initial discovery) uses the cache so reloads paint fast.
async function loadMatches(live = false) {
  let events = [];
  let reached = false; // did any request to Polymarket actually succeed?

  // Preferred source: the series groups exactly the game events.
  if (CONFIG.seriesId) {
    try {
      events = await fetchEventsBySeries(CONFIG.seriesId, live);
      reached = true;
    } catch {
      // fall through to the tag-based discovery below
    }
  }

  if (!events.length) {
    const [tagIds, excludeIds] = await Promise.all([
      resolveTagIds(CONFIG.worldCupTagSlugs),
      CONFIG.excludeTagSlugs.length ? resolveTagIds(CONFIG.excludeTagSlugs) : [],
    ]);
    if (tagIds.length) reached = true;

    const fetched = await Promise.allSettled(tagIds.map((id) => fetchEventsByTag(id, excludeIds, live)));
    for (const r of fetched) {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) {
        events.push(...r.value);
        reached = true;
      }
    }
  }
  // If series/tags couldn't be resolved/fetched, try the open fallback query.
  // Letting it throw here surfaces a real connectivity/geo-block error.
  if (!events.length) {
    events = await fetchEventsFallback(live);
    reached = true;
  }
  if (!reached) throw new Error('NETWORK');

  // Manual curation from CONFIG.filters (slugs come from explorer.html).
  const prefixes = CONFIG.filters.slugPrefixes || [];
  const include = new Set(CONFIG.filters.includeSlugs || []);
  const exclude = new Set(CONFIG.filters.excludeSlugs || []);
  if (prefixes.length) {
    events = events.filter((ev) =>
      prefixes.some((p) => String(ev.slug || '').startsWith(p))
    );
  }
  if (include.size) events = events.filter((ev) => include.has(ev.slug));
  if (exclude.size) events = events.filter((ev) => !exclude.has(ev.slug));

  // Dedupe by event id. A single malformed event must never abort the whole
  // refresh — otherwise one bad market (e.g. a half-result event that appears
  // mid-game) would freeze all live updates silently while refreshLive's catch
  // swallows the throw. Guard each event independently.
  const seen = new Set();
  const matches = [];
  for (const ev of events) {
    if (seen.has(ev.id)) continue;
    seen.add(ev.id);
    try {
      const match = eventToMatch(ev);
      if (match) matches.push(match);
    } catch (e) {
      console.warn('eventToMatch failed for', ev && ev.slug, e);
    }
  }

  // Sort by closing date — soonest (next up) first.
  matches.sort((a, b) => endTime(a) - endTime(b));

  state.matches = matches;
  // Re-point the sports-feed gameId index at the freshly rebuilt match objects
  // so live score pushes keep updating the right ones after every REST refresh.
  indexSportsMatches();
  state.lastUpdated = Date.now();
  renderUpdated();
  return matches;
}

// Footer line: when the odds were last fetched, in the viewer's local time.
// Reads "Real Time" only while the SELECTED match is live-streaming. Flashes
// briefly on each change so a refresh is visibly a refresh.
function renderUpdated() {
  const text = streamActive() && state.current && isLive(state.current)
    ? 'Updated Real Time'
    : state.lastUpdated
      ? `Updated ${new Date(state.lastUpdated).toLocaleString([], {
          month: 'short', day: 'numeric',
          hour: '2-digit', minute: '2-digit', second: '2-digit',
        })}`
      : '';
  if (el.lastUpdated.textContent === text) return; // no churn, no re-flash
  el.lastUpdated.textContent = text;
  if (!text) return;
  el.lastUpdated.classList.remove('is-tick');
  void el.lastUpdated.offsetWidth; // reflow so the animation re-triggers
  el.lastUpdated.classList.add('is-tick');
}

/* ----------------------------- DROPDOWN ---------------------------------- */
function matchPrefix(m) {
  return isLive(m) ? '🔴 ' : matchEnded(m) ? '🏁 ' : '';
}

function populateSelect() {
  el.select.innerHTML = '';
  state.matches.forEach((m, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = matchPrefix(m) + m.title;
    el.select.appendChild(opt);
  });
  el.select.disabled = false;
}

// Refresh the live prefixes/badge without refetching (cheap, runs every tick).
function refreshLiveLabels() {
  Array.from(el.select.options).forEach((opt, i) => {
    const m = state.matches[i];
    if (m) opt.textContent = matchPrefix(m) + m.title;
  });
  updateLiveBadge();
}

function updateLiveBadge() {
  el.liveBadge.hidden = !(state.current && isLive(state.current));
}

/* ----------------------- "WHY THESE ODDS?" MODAL ------------------------- */
function updateWhyButton() {
  el.whyBtn.hidden = !(state.current && state.current.context);
}

function openWhy() {
  if (!state.current || !state.current.context) return;
  el.whyTitle.textContent = state.current.title;
  el.whyBody.textContent = state.current.context;
  const ts = state.current.contextUpdated ? new Date(state.current.contextUpdated) : null;
  if (ts && !Number.isNaN(ts.getTime())) {
    el.whyUpdated.textContent = `Context updated ${ts.toLocaleString([], {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    })}`;
    el.whyUpdated.hidden = false;
  } else {
    el.whyUpdated.hidden = true;
  }
  el.whyCard.classList.add('is-open');
  el.whyBackdrop.hidden = false;
}

function closeWhy() {
  el.whyCard.classList.remove('is-open');
  el.whyBackdrop.hidden = true;
}

function wireWhyModal() {
  if (!el.whyBtn) return;
  el.whyBtn.addEventListener('click', openWhy);
  el.whyClose.addEventListener('click', closeWhy);
  el.whyBackdrop.addEventListener('click', closeWhy);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeWhy(); });
}

// Default selection on load: a match being played right now if there is one,
// otherwise the next one to kick off; never an ended/past one if avoidable.
function defaultMatchIndex() {
  const now = Date.now();
  let live = -1;
  let next = -1;
  let nextAt = Infinity;
  state.matches.forEach((m, i) => {
    if (live < 0 && isLive(m)) live = i;
    const s = m.startTime ? Date.parse(m.startTime) : NaN;
    if (!Number.isNaN(s) && s >= now && s < nextAt) { next = i; nextAt = s; }
  });
  if (live >= 0) return live;
  if (next >= 0) return next;
  return 0;
}

function selectMatch(index) {
  clearSwing(); // a pending swing belongs to the previously selected match
  state.current = state.matches[index];
  el.select.value = String(index); // keep the dropdown in sync when called programmatically
  state.rotation = 0;
  hideResult(); // clear any previous result on a different selection
  preloadLogos(state.current.sections);
  preloadShareLogos(state.current.sections);
  drawWheel();
  el.spin.disabled = false;
  updateLiveBadge();
  updateWhyButton();
  // Start/stop the stream to match the new selection, and reset the status
  // line so a stale "streaming" message never outlives the live match it
  // belonged to. The 1s ticker takes over once the stream is connected.
  syncLiveStream();
  syncMatchClock(); // tick the minute even if the price stream never connects
  if (isLive(state.current)) {
    setStatus(`${state.matches.length} matches · 🔴 live — connecting stream…`, 'ok');
  } else if (matchEnded(state.current)) {
    setStatus('🏁 Match ended — Polymarket is resolving the market.', '');
  } else {
    setStatus(`${state.matches.length} matches loaded`, 'ok');
  }
  renderUpdated(); // footer back to date/time (or to Real Time) immediately
}

/* ------------------------------ TEAM FLAGS ------------------------------- */
// Cache team flag/logo images; redraw the wheel once one finishes loading.
const logoCache = new Map();
function getLogo(url) {
  if (!url) return null;
  let entry = logoCache.get(url);
  if (!entry) {
    const img = new Image();
    entry = { img, loaded: false };
    img.onload = () => { entry.loaded = true; if (!state.spinning) drawWheel(); };
    img.onerror = () => { entry.error = true; };
    img.src = url;
    logoCache.set(url, entry);
  }
  return entry.loaded ? entry.img : null;
}
function preloadLogos(sections) {
  sections.forEach((s) => { if (s.logo) getLogo(s.logo); });
}

/* ---------------------------- WHEEL RENDER ------------------------------- */
// Angles run clockwise from the top (12 o'clock).
function sectorAngles() {
  const m = state.current;
  const angles = [];
  let start = 0;
  for (const s of m.sections) {
    const sweep = s.prob * Math.PI * 2;
    angles.push({ start, end: start + sweep, section: s });
    start += sweep;
  }
  return angles;
}

function drawWheel() {
  if (!state.current) return;
  const W = el.canvas.width;
  const cx = W / 2;
  const cy = W / 2;
  const r = W / 2 - 10;
  const TOP = -Math.PI / 2; // 12 o'clock in canvas coordinates

  ctx.clearRect(0, 0, W, W);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(state.rotation);

  const angles = sectorAngles();
  for (const { start, end, section } of angles) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, r, TOP + start, TOP + end);
    ctx.closePath();
    ctx.fillStyle = section.color;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(13,17,23,0.85)';
    ctx.stroke();

    drawSectorLabel(r, start, end, section);
  }

  // Outer ring.
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.lineWidth = 6;
  ctx.strokeStyle = '#0d1117';
  ctx.stroke();
  ctx.restore();

  // Hub.
  ctx.beginPath();
  ctx.arc(cx, cy, 26, 0, Math.PI * 2);
  ctx.fillStyle = '#0d1117';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#30363d';
  ctx.stroke();
}

// Each sector shows the team flag, name and percentage (the legend below the
// wheel was removed, so everything the viewer needs is on the wheel itself).
function drawSectorLabel(r, start, end, section) {
  const sweep = end - start;
  if (sweep <= 0.16) return; // sector too small to label
  const mid = -Math.PI / 2 + start + sweep / 2;
  const dist = r * 0.6;
  const img = section.logo ? getLogo(section.logo) : null;

  ctx.save();
  ctx.rotate(mid);
  ctx.translate(dist, 0);
  // Counter-rotate so the flag and text stay upright regardless of the
  // wheel's spin or which side of the circle the sector is on.
  ctx.rotate(-(state.rotation + mid));
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 4;

  if (img) {
    const fw = 40;
    const fh = Math.min(34, fw * (img.height / img.width || 0.66));
    ctx.drawImage(img, -fw / 2, -fh - 6, fw, fh);
  }
  const yLabel = img ? 14 : -9;
  ctx.fillStyle = '#fff';
  ctx.font = '600 18px system-ui, sans-serif';
  ctx.fillText(fit(section.label, 14), 0, yLabel);
  ctx.font = '700 15px system-ui, sans-serif';
  ctx.fillText(pct(section.prob), 0, yLabel + 21);
  ctx.restore();
}

function fit(text, max) {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

/* ------------------------------- SPIN ------------------------------------ */
function spin() {
  if (state.spinning || !state.current) return;
  state.spinning = true;
  el.spin.disabled = true;
  el.select.disabled = true;
  hideResult();

  // Uniform landing: random angle over the full circle. Since sectors are
  // sized by probability, the result is naturally weighted by the odds.
  const extraTurns = 5 + Math.floor(Math.random() * 4); // 5–8 turns
  const landing = Math.random() * Math.PI * 2;
  const startRot = state.rotation % (Math.PI * 2);
  const target = startRot + extraTurns * Math.PI * 2 + landing;
  const duration = 4200 + Math.random() * 800;
  const t0 = performance.now();

  function frame(now) {
    const t = Math.min((now - t0) / duration, 1);
    const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
    state.rotation = startRot + (target - startRot) * eased;
    drawWheel();
    if (t < 1) {
      requestAnimationFrame(frame);
    } else {
      state.spinning = false;
      el.spin.disabled = false;
      el.select.disabled = false;
      announceWinner();
    }
  }
  requestAnimationFrame(frame);
}

// Figure out which sector sits under the pointer (top) once stopped.
function winnerAtPointer() {
  const TWO_PI = Math.PI * 2;
  // A point at local angle `a` shows on screen at `a + rotation`.
  // The pointer is at 0 (top) → a = -rotation (mod 2π).
  const localAngle = ((-state.rotation) % TWO_PI + TWO_PI) % TWO_PI;
  for (const { start, end, section } of sectorAngles()) {
    if (localAngle >= start && localAngle < end) return section;
  }
  return state.current.sections[0];
}

// Honour the OS "reduce motion" setting: keep the result, drop the confetti.
const REDUCE_MOTION =
  window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Classify a result by how surprising it is. The winner is an "upset" when it
// wasn't the market favourite; a "huge" upset when the crowd gave it < 18%.
// This is the whole viral hook — the rare result is framed as rare.
function classifyResult(winner) {
  const fave = state.current.sections.reduce(
    (a, b) => (b.prob > a.prob ? b : a),
    state.current.sections[0]
  );
  const isUpset = winner !== fave && winner.prob < fave.prob;
  const isHuge = isUpset && winner.prob < 0.18;
  return { isUpset, isHuge };
}

function announceWinner() {
  const winner = winnerAtPointer();
  const { isUpset, isHuge } = classifyResult(winner);
  state.lastResult = { winner, match: state.current, isUpset, isHuge };

  el.resultLabel.textContent = isHuge ? '🚨 Huge upset' : isUpset ? '😮 Upset' : 'Result';
  el.resultText.textContent = `${winner.label} · ${pct(winner.prob)}`;
  el.resultText.style.color = winner.color;

  if (winner.logo) {
    el.resultFlag.src = winner.logo;
    el.resultFlag.style.visibility = 'visible';
  } else {
    el.resultFlag.removeAttribute('src');
    el.resultFlag.style.visibility = 'hidden';
  }

  el.result.classList.toggle('is-upset', isUpset);
  el.result.classList.toggle('is-huge', isHuge);
  reserve(el.matchInfo, false); // the result takes the slot over
  reserve(el.result, true);

  // Pop-in (restart the animation each time by toggling the class).
  el.result.classList.remove('is-pop');
  void el.result.offsetWidth; // reflow so the animation re-triggers
  el.result.classList.add('is-pop');

  // Confetti intensity scales with the surprise: a heavy favourite gets a light
  // sprinkle, a giant-killing gets the full burst.
  if (!REDUCE_MOTION) {
    const intensity = isHuge ? 1 : isUpset ? 0.7 : 0.3 + (1 - winner.prob) * 0.3;
    launchConfetti(Math.min(1, intensity), isHuge);
  }
}

function hideResult() {
  reserve(el.result, false);
  el.result.classList.remove('is-pop', 'is-upset', 'is-huge');
  // Clear the flag explicitly: its inline `visibility: visible` (set when a
  // winner is announced) would otherwise override the container's inherited
  // `visibility: hidden` and keep the previous winner's flag on screen.
  el.resultFlag.removeAttribute('src');
  el.resultFlag.style.visibility = 'hidden';
  // With no result on screen, the slot shows the match's schedule instead.
  renderMatchInfo();
}

// Interpolated elapsed minute: advance the REST snapshot by wall-clock
// seconds so the display ticks every second instead of jumping every 30s.
// Capped at 95' to avoid running past the realistic end of stoppage time.
function liveElapsed(m) {
  if (m.elapsed == null || !m.elapsedAt) return m.elapsed;
  const added = Math.floor((Date.now() - m.elapsedAt) / 60000);
  return Math.min(95, m.elapsed + added);
}

// The minute/period badge for a live or just-finished match.
function clockLabel(m) {
  const p = (m.period || '').toUpperCase();
  if (p === 'HT') return '⏱ Half-time';
  if (p === 'FT' || matchEnded(m)) return '🏁 Full-time';
  const mins = liveElapsed(m);
  if (mins != null && Number.isFinite(mins)) {
    const half = p === '1H' ? ' · 1st half' : p === '2H' ? ' · 2nd half' : '';
    return `⏱ ${mins}'${half}`;
  }
  return p ? `⏱ ${p}` : '';
}

// Live scoreline with both flags into the match-info slot. Returns whether a
// score was rendered (so the slot can still show the schedule when there isn't).
function renderScore(m) {
  const box = el.matchInfoScore;
  if (!box) return false;
  const show = m && m.score && m.home && m.away && (isLive(m) || matchEnded(m));
  if (!show) { box.hidden = true; box.replaceChildren(); return false; }

  const flag = (team) => {
    const img = document.createElement('img');
    img.className = 'match-info__flag';
    if (team.logo) img.src = team.logo;
    img.alt = '';
    return img;
  };
  const span = (cls, text) => {
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    return s;
  };

  const line = document.createElement('div');
  line.className = 'match-info__scoreline';
  line.append(
    flag(m.home),
    span('match-info__team', m.home.name),
    span('match-info__nums', `${m.score.home} – ${m.score.away}`),
    span('match-info__team', m.away.name),
    flag(m.away)
  );
  box.replaceChildren(line);

  // While a goal-signal swing is unconfirmed, the displayed score is stale (the
  // market moved but Sportradar hasn't caught up). Replace the clock with an
  // "unexpected swing" notice and skip the model strip — its probabilities,
  // computed from the stale score, would contradict the wheel until the score
  // lands. The badge clears in resolveSwing (score confirmed or timed out).
  const swingPending = state.swing && state.swing.matchId === m.id;
  if (swingPending) {
    box.append(span('match-info__swing', '⚡ Unexpected swing — confirming score…'));
    box.hidden = false;
    return true;
  }

  const clk = clockLabel(m);
  if (clk) box.append(span('match-info__clock', clk));

  // Model strip: Poisson in-play probabilities vs the live market (wheel).
  // Only shown during live play when calibration succeeded.
  if (m.lambdas && m.elapsed != null && m.score && isLive(m)) {
    const wp = WP.live(m.lambdas.lh, m.lambdas.la, liveElapsed(m), m.score);
    const pct = (v) => Math.round(v * 100) + '%';
    const strip = document.createElement('div');
    strip.className = 'match-info__model';
    // Diff on whichever outcome the model favours most (sections: 0=home,1=draw,2=away).
    const wpArr = [wp.h, wp.d, wp.a];
    const topIdx = wpArr.indexOf(Math.max(...wpArr));
    const mktTop = m.sections[topIdx] ? m.sections[topIdx].prob : null;
    const diff = mktTop != null ? Math.round((wpArr[topIdx] - mktTop) * 100) : 0;
    const diffStr = diff === 0 ? '' : (diff > 0 ? ` (+${diff}pp)` : ` (${diff}pp)`);
    strip.innerHTML =
      `<span class="mi-model-label">⚗ Model</span>` +
      `<span class="mi-model-h">${pct(wp.h)}</span>` +
      `<span class="mi-model-sep">·</span>` +
      `<span class="mi-model-d">${pct(wp.d)}</span>` +
      `<span class="mi-model-sep">·</span>` +
      `<span class="mi-model-a">${pct(wp.a)}</span>` +
      (diffStr ? `<span class="mi-model-diff">${diffStr}</span>` : '');
    box.append(strip);
  }

  box.hidden = false;
  return true;
}

// Kickoff in the viewer's local time (with timezone) plus venue when known.
// Lives in the result slot: visible until a result lands, back on re-spin.
function renderMatchInfo() {
  const m = state.current;
  if (!m || !el.matchInfo) { if (el.matchInfo) reserve(el.matchInfo, false); return; }
  const hasScore = renderScore(m);
  const t = m.startTime ? Date.parse(m.startTime) : NaN;
  let when = '';
  if (!Number.isNaN(t)) {
    const local = new Date(t).toLocaleString([], {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
    });
    // With the scoreline already announcing live/finished state, keep the date
    // line secondary; otherwise it carries the status itself.
    when = hasScore ? `📅 Kicked off ${local}`
      : isLive(m) ? `🔴 In play — kicked off ${local}`
      : matchEnded(m) ? `🏁 Played ${local}`
      : `📅 ${local}`;
  }
  el.matchInfoWhen.textContent = when;
  if (m.venue) {
    el.matchInfoVenue.textContent = `🏟 ${m.venue}`;
    el.matchInfoVenue.hidden = false;
  } else {
    el.matchInfoVenue.hidden = true;
  }
  // Never show on top of a visible result — the result owns the slot.
  const resultShowing = !el.result.classList.contains('is-hidden');
  reserve(el.matchInfo, (!!when || hasScore) && !resultShowing);
}

/* ----------------------------- CONFETTI ---------------------------------- */
const cctx = el.confetti ? el.confetti.getContext('2d') : null;
let confettiParticles = [];
let confettiRAF = null;
const CONFETTI_COLORS = ['#ffd23f', '#2f81f7', '#f85149', '#3fb950', '#e6edf3', '#ff8ad8'];

function sizeConfetti() {
  if (!el.confetti) return;
  const dpr = window.devicePixelRatio || 1;
  el.confetti.width = window.innerWidth * dpr;
  el.confetti.height = window.innerHeight * dpr;
  cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function spawnParticle(x, y, spread, upward) {
  confettiParticles.push({
    x,
    y,
    vx: (Math.random() - 0.5) * spread,
    vy: upward ? -(Math.random() * 9 + 4) : Math.random() * 3 + 2,
    size: Math.random() * 6 + 4,
    color: CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0],
    rot: Math.random() * Math.PI,
    vrot: (Math.random() - 0.5) * 0.32,
    rect: Math.random() < 0.55,
    life: 0,
  });
}

// intensity 0..1 sets the particle count; `burst` adds a center pop for big upsets.
function launchConfetti(intensity, burst) {
  if (!cctx) return;
  sizeConfetti();
  const W = window.innerWidth;
  const count = Math.round(40 + intensity * 170);
  for (let i = 0; i < count; i++) {
    spawnParticle(W / 2 + (Math.random() - 0.5) * W * 0.5, -20, 7 + intensity * 6, false);
  }
  if (burst) {
    const bx = W / 2;
    const by = window.innerHeight * 0.4;
    for (let i = 0; i < 80; i++) spawnParticle(bx, by, 16, true);
  }
  if (!confettiRAF) confettiRAF = requestAnimationFrame(confettiFrame);
}

function confettiFrame() {
  const W = window.innerWidth;
  const H = window.innerHeight;
  cctx.clearRect(0, 0, W, H);
  for (const p of confettiParticles) {
    p.vy += 0.16; // gravity
    p.vx *= 0.99;
    p.x += p.vx;
    p.y += p.vy;
    p.rot += p.vrot;
    p.life++;
    cctx.save();
    cctx.translate(p.x, p.y);
    cctx.rotate(p.rot);
    cctx.globalAlpha = Math.max(0, 1 - p.life / 230);
    cctx.fillStyle = p.color;
    if (p.rect) cctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
    else { cctx.beginPath(); cctx.arc(0, 0, p.size / 2, 0, Math.PI * 2); cctx.fill(); }
    cctx.restore();
  }
  confettiParticles = confettiParticles.filter((p) => p.y < H + 40 && p.life < 240);
  if (confettiParticles.length) {
    confettiRAF = requestAnimationFrame(confettiFrame);
  } else {
    confettiRAF = null;
    cctx.clearRect(0, 0, W, H);
  }
}

/* ------------------------------ SHARING ---------------------------------- */
// Flags drawn into the share image must be CORS-clean or toBlob() would throw on
// a tainted canvas. We load a separate crossOrigin='anonymous' copy: if the CDN
// allows it the image loads (and is export-safe); if not it simply never loads
// and we skip the flag. Either way the export never taints.
const shareLogoCache = new Map();

function loadCorsImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function getShareLogo(url) {
  if (!url) return null;
  let entry = shareLogoCache.get(url);
  if (!entry) {
    entry = { img: null, loaded: false };
    shareLogoCache.set(url, entry);
    // Try the CDN directly first (free, no proxy quota). Most of Polymarket's
    // logo CDNs send no CORS header, which fails the crossOrigin load — so fall
    // back to our Worker, which refetches the image and adds CORS so the export
    // canvas stays clean.
    loadCorsImage(url).then(
      (img) => { entry.img = img; entry.loaded = true; },
      () => {
        if (!CONFIG.proxyBase) { entry.error = true; return; }
        const proxied = `${CONFIG.proxyBase}/img?url=${encodeURIComponent(url)}`;
        loadCorsImage(proxied).then(
          (img) => { entry.img = img; entry.loaded = true; },
          () => { entry.error = true; }
        );
      }
    );
  }
  return entry.loaded ? entry.img : null;
}
function preloadShareLogos(sections) {
  sections.forEach((s) => { if (s.logo) getShareLogo(s.logo); });
}

function wrapText(ctx2, text, x, y, maxW, lineH) {
  const words = String(text).split(/\s+/);
  let line = '';
  let yy = y;
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx2.measureText(test).width > maxW && line) {
      ctx2.fillText(line, x, yy);
      line = w;
      yy += lineH;
    } else {
      line = test;
    }
  }
  if (line) ctx2.fillText(line, x, yy);
  return yy;
}

// Render a 1080×1080 share card from the last result. Returns a PNG Blob (or
// null if the browser can't export). Square format travels well on WhatsApp/X/IG.
function buildShareImage(r) {
  return new Promise((resolve) => {
    try {
      const S = 1080;
      const c = document.createElement('canvas');
      c.width = S;
      c.height = S;
      const g = c.getContext('2d');

      const bg = g.createLinearGradient(0, 0, 0, S);
      bg.addColorStop(0, '#182030');
      bg.addColorStop(1, '#0d1117');
      g.fillStyle = bg;
      g.fillRect(0, 0, S, S);

      g.textAlign = 'center';
      let y = 132;

      // Wordmark
      g.fillStyle = '#ffd23f';
      g.font = '800 50px system-ui, sans-serif';
      g.fillText('🎡 World Cup Wheel', S / 2, y);
      y += 96;

      // Match title — bright and large, with a soft shadow so it reads on the
      // dark gradient (was small/low-contrast before).
      g.save();
      g.shadowColor = 'rgba(0, 0, 0, 0.65)';
      g.shadowBlur = 8;
      g.fillStyle = '#e6edf3';
      g.font = '700 52px system-ui, sans-serif';
      y = wrapText(g, r.match.title, S / 2, y, S - 140, 64) + 78;
      g.restore();

      // Upset badge
      if (r.isUpset) {
        g.fillStyle = r.isHuge ? '#ffd23f' : '#e6edf3';
        g.font = '800 48px system-ui, sans-serif';
        g.fillText(r.isHuge ? '🚨 HUGE UPSET' : '😮 UPSET', S / 2, y);
        y += 76;
      }

      // Winner flag (only if a CORS-clean copy loaded — never taints export)
      const img = r.winner.logo ? getShareLogo(r.winner.logo) : null;
      if (img) {
        const fw = 320;
        const fh = Math.min(210, fw * (img.height / img.width || 0.66));
        g.drawImage(img, (S - fw) / 2, y, fw, fh);
        y += fh + 36;
      } else {
        y += 24;
      }

      // Winner name — shrink the font until it fits the width.
      const name = fit(r.winner.label, 22);
      let namePx = 108;
      do {
        g.font = `800 ${namePx}px system-ui, sans-serif`;
        namePx -= 4;
      } while (g.measureText(name).width > S - 120 && namePx > 40);
      g.save();
      g.shadowColor = 'rgba(0, 0, 0, 0.55)';
      g.shadowBlur = 6;
      g.fillStyle = r.winner.color;
      g.fillText(name, S / 2, y + 92);
      g.restore();
      y += 150;

      // Probability line
      g.fillStyle = '#e6edf3';
      g.font = '600 46px system-ui, sans-serif';
      g.fillText(`The market gave them ${pct(r.winner.prob)}`, S / 2, y);

      // Footer — pinned to the bottom, on-brand and high-contrast.
      g.fillStyle = '#ffd23f';
      g.font = '700 40px system-ui, sans-serif';
      g.fillText('Spin yours → gonnafind.com', S / 2, S - 64);

      if (c.toBlob) c.toBlob((b) => resolve(b), 'image/png');
      else resolve(null);
    } catch {
      resolve(null); // tainted canvas or no support → share text-only
    }
  });
}

function shareUrl() {
  return location.origin + location.pathname;
}

function shareText(r) {
  const p = pct(r.winner.prob);
  const teams = r.match.sections.filter((s) => !DRAW_RE.test(s.label));
  // Draw: name both teams. Team win: name the rival it came up against.
  if (DRAW_RE.test(r.winner.label)) {
    const names = teams.map((t) => t.label).join(' vs ');
    return r.isUpset
      ? `🤝 A draw (${p}) came up in ${names} on the World Cup Wheel — the market barely backed it!`
      : `🤝 A draw (${p}) came up in ${names} on the World Cup Wheel.`;
  }
  const opp = teams.find((t) => t.label !== r.winner.label);
  const vs = opp ? ` vs ${opp.label}` : '';
  return r.isUpset
    ? `😱 ${r.winner.label} came up${vs} on the World Cup Wheel — the market only gave them ${p}!`
    : `🎡 ${r.winner.label} (${p}) came up${vs} on my World Cup Wheel spin.`;
}

async function copyShare(text, url) {
  const payload = `${text} Spin yours: ${url}`;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(payload);
    flashShareLabel('Link copied ✓');
  } else {
    flashShareLabel('Copy: ' + url);
  }
}

let shareLabelTimer = null;
function flashShareLabel(msg) {
  if (!el.shareLabel) return;
  const original = 'Share result';
  el.shareLabel.textContent = msg;
  if (shareLabelTimer) clearTimeout(shareLabelTimer);
  shareLabelTimer = setTimeout(() => { el.shareLabel.textContent = original; }, 2200);
}

async function doShare() {
  const r = state.lastResult;
  if (!r) return;
  const url = shareUrl();
  const text = shareText(r);
  const data = { title: 'World Cup Wheel', text: `${text} Spin yours:`, url };
  try {
    const blob = await buildShareImage(r);
    if (blob && navigator.canShare) {
      const file = new File([blob], 'world-cup-wheel.png', { type: 'image/png' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ ...data, files: [file] });
        return;
      }
    }
    if (navigator.share) {
      await navigator.share(data);
      return;
    }
    await copyShare(text, url);
  } catch (err) {
    if (err && err.name === 'AbortError') return; // user dismissed the sheet
    try { await copyShare(text, url); } catch { /* ignore */ }
  }
}

/* ------------------------------ STARTUP ---------------------------------- */
async function init() {
  fitWheel();
  drawPlaceholder();
  hideResult();
  el.spin.disabled = true;
  el.select.disabled = true;
  el.select.innerHTML = '<option>Loading matches…</option>';
  setStatus('');
  showLoading(true);

  try {
    const matches = await loadMatches();
    if (!matches.length) {
      el.select.innerHTML = '<option>No matches available</option>';
      setStatus(
        'No World Cup matches with a 1-X-2 market were found on Polymarket.',
        'error'
      );
      return;
    }
    populateSelect();
    setStatus(`${matches.length} matches loaded`, 'ok');
    selectMatch(defaultMatchIndex());
    scheduleLive();
    syncLiveStream();
    syncSportsStream(); // real-time scores via the sports feed
    // Mobile browsers throttle/suspend timers in backgrounded tabs, so the 30s
    // poll can stall while you watch the game elsewhere. Force a fresh fetch
    // the moment the tab regains focus so the score is never stale on return.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (state.matches.some((m) => isLive(m) || matchEnded(m))) refreshLive();
      syncLiveStream();
      syncSportsStream();
    });
  } catch (err) {
    console.error(err);
    el.select.innerHTML = '<option>Unavailable</option>';
    el.select.disabled = true;
    setStatus('');
    showError(
      '<strong>Couldn’t load the data.</strong><br>' +
      'Something went wrong fetching the odds. Please try again.'
    );
  } finally {
    showLoading(false);
  }
}

/* ------------------------------ LIVE POLL -------------------------------- */
let liveTimer = null;

// Every 30s: refresh live badges cheaply; if a game is live, re-fetch odds.
function scheduleLive() {
  if (liveTimer) clearInterval(liveTimer);
  liveTimer = setInterval(onLiveTick, 30000);
}

async function onLiveTick() {
  refreshLiveLabels(); // a match may have just kicked off — update badges
  syncLiveStream(); // open/close the WSS as matches enter/leave their window
  syncSportsStream(); // open/close the sports score feed likewise
  if (state.spinning) return;
  // Keep reconciling while anything is live OR ended-but-unresolved, so we
  // notice when Polymarket finally closes a finished match's market.
  if (state.matches.some((m) => isLive(m) || matchEnded(m))) await refreshLive();
}

/* ------------------------- LIVE ODDS STREAM (WSS) ------------------------ */
// Sub-second odds for live matches via Polymarket's public CLOB market
// channel. The stream only accelerates what happens BETWEEN the 30s REST
// polls; the poll remains the source of truth (it catches resolutions,
// de-listings and missed messages) and the full fallback where the WSS is
// geo-blocked — there, everything keeps working exactly as before.
const stream = {
  ws: null,
  tokens: new Set(), // token ids currently subscribed
  prices: new Map(), // token id -> { bid, ask, last }
  retry: 0,
  reconnectTimer: null,
  keepaliveTimer: null,
  applyTimer: null,
  lastMsgAt: 0,         // any inbound data (incl. PONG) — connection health signal
  goalRefreshAt: 0,     // epoch of last goal-triggered REST refresh (debounce)
};

// "Continuous" stream: socket open AND something heard recently (our PINGs
// are answered every 5s, so silence beyond 12s means the stream stalled).
function streamActive() {
  return !!(
    stream.ws &&
    stream.ws.readyState === WebSocket.OPEN &&
    Date.now() - stream.lastMsgAt < 12000
  );
}

// The stream follows the SELECTION: only the currently selected match is
// subscribed, and only while it's inside its live window. Selecting a
// non-live match stops the stream; selecting another live one re-subscribes.
function liveStreamTokens() {
  const m = state.current;
  if (!m || !isLive(m)) return [];
  return m.sections.filter((s) => s.token).map((s) => s.token);
}

// Open/close/resubscribe so the connection mirrors the set of live matches.
// Subscriptions are fixed per connection, so a changed set means reconnect
// (it only changes at kickoff/final-whistle boundaries).
function syncLiveStream() {
  if (typeof WebSocket === 'undefined') return;
  const tokens = liveStreamTokens();
  if (!tokens.length) {
    const wasStreaming = !!stream.ws;
    closeLiveStream();
    // The selected match just crossed from live to ended: say so instead of
    // leaving the last streaming message on screen until resolution.
    if (wasStreaming && matchEnded(state.current)) {
      setStatus('🏁 Match ended — Polymarket is resolving the market.', '');
      renderUpdated();
    }
    return;
  }
  const sameSet =
    stream.ws &&
    stream.ws.readyState <= WebSocket.OPEN &&
    tokens.length === stream.tokens.size &&
    tokens.every((t) => stream.tokens.has(t));
  if (sameSet) return;
  openLiveStream(tokens);
}

function openLiveStream(tokens) {
  closeLiveStream();
  let ws;
  try {
    ws = new WebSocket(CONFIG.clobWss);
  } catch {
    return; // blocked environment — REST poll keeps everything alive
  }
  stream.ws = ws;
  stream.tokens = new Set(tokens);
  // Drop quotes of matches that left the live window.
  for (const k of [...stream.prices.keys()]) {
    if (!stream.tokens.has(k)) stream.prices.delete(k);
  }

  ws.onopen = () => {
    stream.retry = 0;
    ws.send(JSON.stringify({ type: 'market', assets_ids: tokens }));
    // The server drops quiet connections; answer/keep it warm every 5s.
    stream.keepaliveTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send('PING');
    }, 5000);
    // The 1s clock that repaints the minute/model and the "🔴 streaming" status
    // runs off syncMatchClock (driven by the selected match being live), not off
    // this socket — so the minute keeps ticking even if the price stream drops.
  };
  ws.onmessage = (e) => handleStreamMessage(e.data);
  ws.onclose = () => {
    if (stream.ws !== ws) return; // an intentional close/replace
    cleanupStreamTimers();
    stream.ws = null;
    scheduleStreamReconnect();
  };
  ws.onerror = () => {
    try { ws.close(); } catch { /* ignore */ }
  };
}

function cleanupStreamTimers() {
  if (stream.keepaliveTimer) { clearInterval(stream.keepaliveTimer); stream.keepaliveTimer = null; }
  if (stream.applyTimer) { clearTimeout(stream.applyTimer); stream.applyTimer = null; }
  renderUpdated(); // restore the date/time footer once streaming stops
}

function closeLiveStream() {
  if (stream.reconnectTimer) { clearTimeout(stream.reconnectTimer); stream.reconnectTimer = null; }
  cleanupStreamTimers();
  const ws = stream.ws;
  stream.ws = null;
  stream.tokens = new Set();
  if (ws) {
    ws.onclose = null;
    try { ws.close(); } catch { /* ignore */ }
  }
}

function scheduleStreamReconnect() {
  if (stream.reconnectTimer) return;
  const delay = Math.min(30000, 1000 * 2 ** stream.retry++);
  stream.reconnectTimer = setTimeout(() => {
    stream.reconnectTimer = null;
    syncLiveStream();
  }, delay);
}

/* ----------------------- LIVE SCORE STREAM (Sports WSS) ------------------ */
// Polymarket's sports feed (wss://sports-api.polymarket.com/ws) pushes
// score/period/elapsed/live/ended for ALL active games — no auth, no
// subscription. We connect while any match is live, filter messages to our
// matches by gameId, and update the scoreline in real time. The 30s REST poll
// stays as the fallback (and supplies the price-change fields the model needs).
const sports = {
  ws: null,
  keepaliveTimer: null,
  reconnectTimer: null,
  retry: 0,
  byGame: new Map(), // gameId(String) -> match
};

// (Re)index the live matches by gameId so message lookup is O(1).
function indexSportsMatches() {
  sports.byGame.clear();
  for (const m of state.matches) {
    if (m.gameId != null) sports.byGame.set(String(m.gameId), m);
  }
}

// Open/close the sports stream to mirror whether anything is live.
function syncSportsStream() {
  if (typeof WebSocket === 'undefined') return;
  const anyLive = state.matches.some((m) => isLive(m));
  if (!anyLive) { closeSportsStream(); return; }
  indexSportsMatches();
  if (sports.ws && sports.ws.readyState <= WebSocket.OPEN) return; // already up
  openSportsStream();
}

function openSportsStream() {
  closeSportsStream();
  let ws;
  try { ws = new WebSocket(CONFIG.sportsWss); } catch { return; }
  sports.ws = ws;
  ws.onopen = () => { sports.retry = 0; }; // server pings; we reply PONG reactively
  ws.onmessage = (e) => handleSportsMessage(e.data);
  ws.onclose = () => {
    if (sports.ws !== ws) return;
    sports.ws = null;
    scheduleSportsReconnect();
  };
  ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
}

function closeSportsStream() {
  if (sports.reconnectTimer) { clearTimeout(sports.reconnectTimer); sports.reconnectTimer = null; }
  if (sports.keepaliveTimer) { clearInterval(sports.keepaliveTimer); sports.keepaliveTimer = null; }
  const ws = sports.ws;
  sports.ws = null;
  if (ws) { ws.onclose = null; try { ws.close(); } catch { /* ignore */ } }
}

function scheduleSportsReconnect() {
  if (sports.reconnectTimer) return;
  const delay = Math.min(30000, 1000 * 2 ** sports.retry++);
  sports.reconnectTimer = setTimeout(() => {
    sports.reconnectTimer = null;
    syncSportsStream();
  }, delay);
}

function handleSportsMessage(data) {
  if (typeof data !== 'string') return;
  // The server pings to keep the socket alive; reply pong.
  if (data === 'PING' || data === 'ping') { try { sports.ws.send('PONG'); } catch { /* ignore */ } return; }
  let parsed;
  try { parsed = JSON.parse(data); } catch { return; }
  const msgs = Array.isArray(parsed) ? parsed : [parsed];
  let currentTouched = false;

  let goalScored = false;

  for (const msg of msgs) {
    if (!msg || msg.gameId == null) continue;
    const m = sports.byGame.get(String(msg.gameId));
    if (!m) continue; // not one of our World Cup matches
    const es = msg.eventState || msg;

    // Score "H-A" (soccer); ignore set-style scores from other sports.
    const sc = String(es.score != null ? es.score : msg.score || '').match(/^(\d+)\s*-\s*(\d+)$/);
    if (sc) {
      const newH = Number(sc[1]), newA = Number(sc[2]);
      const prevTotal = m.score ? m.score.home + m.score.away : null;
      const newTotal = newH + newA;
      if (prevTotal !== null && newTotal > prevTotal && m === state.current) goalScored = true;
      m.score = { home: newH, away: newA };
    }

    const elapsedRaw = es.elapsed != null ? es.elapsed : msg.elapsed;
    if (elapsedRaw != null && elapsedRaw !== '') {
      const n = parseInt(String(elapsedRaw), 10); // "45", "45+2", "45:00" → 45
      if (Number.isFinite(n)) { m.elapsed = n; m.elapsedAt = Date.now(); }
    }

    const pd = es.period != null ? es.period : msg.period;
    if (pd != null) m.period = String(pd);

    const live = es.live != null ? es.live : msg.live;
    const ended = es.ended != null ? es.ended : msg.ended;
    if (typeof live === 'boolean') m.live = live;
    if (typeof ended === 'boolean') m.ended = ended;

    if (m === state.current) currentTouched = true;
  }

  if (currentTouched && !state.spinning) {
    resolveSwing(state.current); // a confirmed score clears the pending badge
    renderMatchInfo();
    if (goalScored) flashGoalScore();
    // A live↔ended transition may need the price stream and clock started/stopped.
    syncLiveStream();
    syncMatchClock();
  }
  // Always refresh dropdown labels so 🔴→🏁 transitions are instant, even for
  // matches that aren't currently selected.
  refreshLiveLabels();
}

// Brief gold flash on the score card when Sports WSS confirms a new goal.
function flashGoalScore() {
  const box = el.matchInfoScore;
  if (!box) return;
  box.classList.remove('match-info__score--goal');
  // Force reflow so removing+re-adding the class always restarts the animation.
  void box.offsetWidth;
  box.classList.add('match-info__score--goal');
  setTimeout(() => box.classList.remove('match-info__score--goal'), 2000);
}

// Best bid/ask from a book snapshot side (levels arrive in no fixed order).
function bestPrice(levels, pickMax) {
  let best = null;
  for (const l of levels || []) {
    const p = Number(l && l.price);
    if (!Number.isFinite(p) || p <= 0 || p >= 1) continue;
    if (best === null || (pickMax ? p > best : p < best)) best = p;
  }
  return best;
}

function priceEntry(token) {
  let entry = stream.prices.get(token);
  if (!entry) { entry = { bid: null, ask: null, last: null }; stream.prices.set(token, entry); }
  return entry;
}

function handleStreamMessage(data) {
  stream.lastMsgAt = Date.now(); // any inbound traffic counts as a heartbeat
  if (typeof data !== 'string' || data === 'PONG' || data === 'PING') return;
  let parsed;
  try { parsed = JSON.parse(data); } catch { return; }
  const events = Array.isArray(parsed) ? parsed : [parsed];
  let touched = false;

  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    const type = ev.event_type || ev.type;

    if (type === 'book' && ev.asset_id) {
      const entry = priceEntry(ev.asset_id);
      entry.bid = bestPrice(ev.bids || ev.buys, true);
      entry.ask = bestPrice(ev.asks || ev.sells, false);
      touched = true;
    } else if (type === 'price_change') {
      // Both shapes seen in the wild: top-level {asset_id, changes:[…]} and
      // aggregated {price_changes:[{asset_id, best_bid, best_ask, …}]}.
      const changes = ev.price_changes || ev.changes || [ev];
      for (const c of changes) {
        const token = (c && c.asset_id) || ev.asset_id;
        if (!token) continue;
        const entry = priceEntry(token);
        const bid = Number(c && c.best_bid);
        const ask = Number(c && c.best_ask);
        if (Number.isFinite(bid) && bid > 0) { entry.bid = bid; touched = true; }
        if (Number.isFinite(ask) && ask < 1 && ask > 0) { entry.ask = ask; touched = true; }
      }
    } else if (type === 'last_trade_price' && ev.asset_id) {
      const p = Number(ev.price);
      if (Number.isFinite(p) && p > 0 && p < 1) {
        priceEntry(ev.asset_id).last = p;
        touched = true;
      }
    }
  }
  if (touched) queueStreamApply();
}

// Coalesce bursts of book events into at most ~2 UI updates per second.
function queueStreamApply() {
  if (stream.applyTimer) return;
  stream.applyTimer = setTimeout(applyStreamPrices, 500);
}

function streamProb(token) {
  const e = stream.prices.get(token);
  if (!e) return null;
  if (e.bid !== null && e.ask !== null) return (e.bid + e.ask) / 2;
  return e.last; // may be null — then the REST price stands
}

// A probability swing of this size on the selected match's top outcome is
// treated as a goal signal — kick a REST refresh immediately so the scoreline
// updates without waiting for the next 30s tick.
const GOAL_SIGNAL_PP = 0.05; // 5 percentage points
const GOAL_REFRESH_COOLDOWN = 8000; // ms — max one extra refresh per 8s

// How long to keep showing "unexpected swing" while waiting for the score feed
// to confirm. Past this we assume the swing was VAR-overturned or noise and
// quietly restore the normal clock — the regular 30s reconciliation continues.
const SWING_TIMEOUT = 40000; // ms
const SWING_POLL_MS = 5000;  // while pending, poll REST this often to confirm
let swingPollTimer = null;

// "H-A" snapshot of a match's current score (or '' when none) — the key we
// compare against to tell whether the scoreline has actually moved.
function scoreKey(m) {
  return m && m.score ? `${m.score.home}-${m.score.away}` : '';
}

// Flag a pending swing on the current match (no-op if one is already tracked
// for it) and start polling REST to confirm the new score quickly.
function flagSwing() {
  const m = state.current;
  if (!m) return;
  if (state.swing && state.swing.matchId === m.id) return; // already pending
  state.swing = { matchId: m.id, at: Date.now(), baseScore: scoreKey(m) };
  scheduleSwingPoll();
  if (!state.spinning) renderMatchInfo(); // surface the badge immediately
}

function clearSwing() {
  state.swing = null;
  if (swingPollTimer) { clearTimeout(swingPollTimer); swingPollTimer = null; }
}

// Resolve a pending swing for match `m`: clear it once the scoreline has moved
// (real goal confirmed → returns true) or once it has waited past SWING_TIMEOUT
// (VAR/noise → returns false). No-op when no swing is pending for this match.
function resolveSwing(m) {
  if (!state.swing || !m || state.swing.matchId !== m.id) return false;
  if (scoreKey(m) !== state.swing.baseScore) { clearSwing(); return true; }
  if (Date.now() - state.swing.at > SWING_TIMEOUT) clearSwing();
  return false;
}

// While a swing is pending, poll REST every few seconds so the score is
// confirmed fast even if the Sports WSS push is blocked or lagging.
function scheduleSwingPoll() {
  if (swingPollTimer) return;
  swingPollTimer = setTimeout(function tick() {
    swingPollTimer = null;
    if (!state.swing) return;
    refreshLive(); // resolveSwing runs inside, on the fresh score
    if (state.swing) swingPollTimer = setTimeout(tick, SWING_POLL_MS);
  }, SWING_POLL_MS);
}

function applyStreamPrices() {
  stream.applyTimer = null;
  if (state.spinning) { queueStreamApply(); return; } // never resize mid-spin
  let currentChanged = false;
  let maxSwing = 0; // largest single-section move on the selected match

  for (const m of state.matches) {
    if (!isLive(m)) continue;
    let changed = false;
    for (const s of m.sections) {
      if (!s.token) continue;
      const p = streamProb(s.token);
      if (p === null) continue;
      const delta = Math.abs(p - s.raw);
      // Ignore sub-0.05pp jitter so the wheel doesn't vibrate.
      if (delta > 0.0005) { s.raw = p; changed = true; }
      if (m === state.current) maxSwing = Math.max(maxSwing, delta);
    }
    if (changed) {
      renormalizeMatch(m);
      if (m === state.current) currentChanged = true;
    }
  }

  if (currentChanged) {
    drawWheel();
    renderStreamStatus();
  }

  // A large swing on the selected match almost certainly means a goal.
  // Trigger an immediate REST refresh to pull the updated scoreline — but
  // debounce hard so a cascade of WSS messages fires at most one extra call.
  // The score feed lags the market, so also flag the swing so the UI shows
  // "unexpected swing" until the new score is confirmed (see flagSwing).
  if (maxSwing >= GOAL_SIGNAL_PP && state.current && isLive(state.current)) {
    const now = Date.now();
    if (now - stream.goalRefreshAt > GOAL_REFRESH_COOLDOWN) {
      stream.goalRefreshAt = now;
      refreshLive(); // fire-and-forget; refreshLive is already safe to overlap
    }
    flagSwing();
  }
}

// "🔴 streaming" status: a live clock, ticking every second while the stream
// stays continuous (no favourite delta here — the wheel itself shows moves).
function renderStreamStatus() {
  const m = state.current;
  if (!m || !isLive(m) || !streamActive()) return;
  const liveCount = state.matches.filter(isLive).length;
  const at = new Date().toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const liveStr = liveCount > 1 ? `${liveCount} live · ` : '';
  setStatus(`${liveStr}${state.matches.length} matches · 🔴 streaming @ ${at}`, 'ok');
}

// 1s ticker that runs whenever the SELECTED match is live — independent of the
// CLOB price stream. The minute clock and in-play model must keep advancing even
// when the price stream is geo-blocked, stalled, or never connects; previously
// this ticker was started only on the price socket's `open`, so the displayed
// minute froze between the 30s REST polls wherever that socket was unavailable.
let matchClockTimer = null;
function syncMatchClock() {
  const live = !!(state.current && isLive(state.current));
  if (live && !matchClockTimer) {
    matchClockTimer = setInterval(matchClockTick, 1000);
  } else if (!live && matchClockTimer) {
    clearInterval(matchClockTimer);
    matchClockTimer = null;
  }
}

function matchClockTick() {
  renderStreamStatus(); // no-ops unless the price stream is actually streaming
  renderUpdated();      // keeps the footer in "Real Time" mode while streaming
  // Re-render the score slot every second so the interpolated minute and the
  // model probabilities advance visually without waiting for the 30s REST tick.
  if (state.current && isLive(state.current) && !state.spinning) {
    resolveSwing(state.current); // expire the "unexpected swing" badge on timeout
    renderMatchInfo();
  } else {
    syncMatchClock(); // selection went non-live → stop ticking
  }
}

// Re-fetch odds without disturbing the current spin/selection/rotation.
async function refreshLive() {
  const prevId = state.current && state.current.id;
  const prevSections = state.current ? state.current.sections : null;
  try {
    await loadMatches(true); // live poll: bypass the HTTP cache for fresh scores
  } catch (e) {
    console.warn('refreshLive: loadMatches failed, keeping current data', e);
    return; // transient network error — keep showing what we have
  }
  if (!state.matches.length) return;
  populateSelect();
  let idx = state.matches.findIndex((m) => m.id === prevId);
  const vanished = idx < 0; // selected match resolved/de-listed on Polymarket
  if (vanished) idx = 0;
  el.select.value = String(idx);
  state.current = state.matches[idx];
  preloadLogos(state.current.sections);
  preloadShareLogos(state.current.sections);
  drawWheel();
  updateLiveBadge();
  updateWhyButton();
  syncMatchClock(); // start/stop the minute ticker as the selection's liveness changes
  const swingConfirmed = resolveSwing(state.current); // REST may carry the new score
  renderMatchInfo(); // live/ended adornment may have just changed
  if (swingConfirmed) flashGoalScore(); // gold burst when the lagging score lands
  // Say what just happened — otherwise a live refresh is indistinguishable
  // from a stale initial snapshot. Includes the refresh time and how the
  // current favourite moved since the previous tick (in percentage points).
  const at = new Date(state.lastUpdated).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  let faveMove = '';
  if (!vanished && prevSections) {
    const fave = state.current.sections.reduce(
      (a, b) => (b.prob > a.prob ? b : a),
      state.current.sections[0]
    );
    const before = prevSections.find((s) => s.label === fave.label);
    if (before) {
      const pp = (fave.prob - before.prob) * 100;
      faveMove = ` · ${fave.label} ${pp >= 0 ? '+' : ''}${pp.toFixed(1)}pp`;
    }
  }
  // While the stream is continuous, its 1s clock owns the status line — the
  // REST reconciliation works silently. It only speaks when streaming is off
  // (geo-blocked/stalled) or the selected match vanished.
  if (vanished || !streamActive()) {
    setStatus(
      vanished
        ? '🏁 Match finished — Polymarket closed its market. Showing the next match.'
        : `${state.matches.length} matches · live odds refreshed @ ${at}${faveMove}`,
      vanished ? '' : 'ok'
    );
  }
  syncLiveStream(); // the fresh match list may have entered/left live windows
}

function drawPlaceholder() {
  const W = el.canvas.width;
  ctx.clearRect(0, 0, W, W);
  ctx.beginPath();
  ctx.arc(W / 2, W / 2, W / 2 - 10, 0, Math.PI * 2);
  ctx.fillStyle = '#161b22';
  ctx.fill();
  ctx.strokeStyle = '#30363d';
  ctx.lineWidth = 4;
  ctx.stroke();
}

/* --------------------------- VISITOR WIDGET ------------------------------ */
function buildStats() {
  const body = document.getElementById('stats-body');
  if (!body) return;
  const fc = CONFIG.analytics.flagCounter;

  let src = fc.src;
  if (!src && fc.code) {
    // Dark-theme Flag Counter image matching the app palette.
    src =
      `https://s01.flagcounter.com/count2/${fc.code}` +
      '/bg_161B22/txt_E6EDF3/border_30363D/columns_2/maxflags_10' +
      '/viewers_0/labels_1/pageviews_1/flags_1/percent_0/';
  }

  // Our own live medal board (first-party tracker, gonnafind.com/flags).
  const board = document.createElement('a');
  board.href = '/flags/';
  board.className = 'stats-board-link';
  board.textContent = '🏅 Full visitor medal board →';

  if (src) {
    const img = new Image();
    img.src = src;
    img.alt = 'Visitor flag counter';
    img.loading = 'eager';
    const link = document.createElement('a');
    link.href = fc.href || 'https://flagcounter.com';
    link.target = '_blank';
    link.rel = 'noopener';
    link.appendChild(img);
    const privacy = document.createElement('p');
    privacy.className = 'stats-privacy';
    privacy.innerHTML =
      'This site uses <a href="https://flagcounter.com" target="_blank" ' +
      'rel="noopener">Flag Counter</a> to show aggregate visits and visitor ' +
      'countries. It processes your IP address to derive your country; it is ' +
      'not used to identify you and no data is sold. Browsing implies ' +
      'acceptance of this anonymous, aggregate measurement.';
    body.replaceChildren(board, link, privacy);
  } else {
    body.replaceChildren(board);
    body.insertAdjacentHTML('beforeend',
      '<p class="stats-setup">To show visits and countries here:<br>' +
      '1. Create a free counter at ' +
      '<a href="https://flagcounter.com" target="_blank" rel="noopener">flagcounter.com</a>.<br>' +
      '2. Copy your counter <strong>code</strong> (the part of the image URL ' +
      'after <code>/count2/</code>).<br>' +
      '3. Paste it into <code>CONFIG.analytics.flagCounter.code</code> in ' +
      '<code>app.js</code>.</p>');
  }
}

function wireStatsWidget() {
  const fab = document.getElementById('stats-fab');
  const card = document.getElementById('stats-card');
  const backdrop = document.getElementById('stats-backdrop');
  const closeBtn = document.getElementById('stats-close');
  if (!fab || !card) return;

  const open = () => {
    card.classList.add('is-open');
    backdrop.hidden = false;
  };
  const close = () => {
    card.classList.remove('is-open');
    backdrop.hidden = true;
  };

  fab.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
}

function wireEduModal() {
  const openBtn = document.getElementById('edu-open');
  const card = document.getElementById('edu-card');
  const backdrop = document.getElementById('edu-backdrop');
  const closeBtn = document.getElementById('edu-close');
  if (!openBtn || !card) return;

  const open = () => { card.classList.add('is-open'); backdrop.hidden = false; };
  const close = () => { card.classList.remove('is-open'); backdrop.hidden = true; };

  openBtn.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
}

/* ------------------------------- EVENTS ---------------------------------- */
el.select.addEventListener('change', (e) => selectMatch(Number(e.target.value)));
el.spin.addEventListener('click', spin);
el.shareBtn.addEventListener('click', doShare);
el.refresh.addEventListener('click', () => {
  if (state.spinning) return;
  init();
});
el.retry.addEventListener('click', () => {
  if (state.spinning) return;
  init();
});

window.addEventListener('resize', fitWheel);
window.addEventListener('resize', sizeConfetti);

buildStats();
wireStatsWidget();
wireEduModal();
wireWhyModal();

fitWheel();
requestAnimationFrame(fitWheel); // re-fit once layout/fonts have settled
init();
