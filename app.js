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
  // Candidate World Cup tag slugs (tried in order).
  worldCupTagSlugs: ['world-cup', '2026-fifa-world-cup', 'fifa-world-cup'],
  // Fallback keywords to recognize the World Cup in tags/title/slug.
  worldCupKeywords: ['world cup', 'fifa world cup', 'mundial', 'wc 2026'],
  // How many events to request per tag.
  eventLimit: 300,
  // Titles that are NOT a full-time match result (props / outrights / sub-markets)
  // — discarded. The real 1-X-2 event is titled plainly "Team A vs. Team B".
  excludeKeywords: [
    'h2h', 'goals', 'goal contribution', 'contribution', 'to score', 'scorer',
    'winner', 'group', 'golden', 'player', 'to advance', 'to win the',
    'champion', 'to qualify', 'to reach', 'mvp', 'assist', 'clean sheet',
    'booking', 'exact score', 'halftime', 'half-time', 'more markets',
    'both teams', 'total goals',
  ],
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

// Only treat an event as a match when its title looks like "A vs B".
const MATCH_TITLE_RE = /\s+v(?:s)?\.?\s+/i;
// Polymarket splits each game into sub-markets via a " - <suffix>" title
// ("- Exact Score", "- Halftime Result", "- More Markets", …). The plain
// "Team A vs. Team B" event (no such suffix) is the full-time 1-X-2 result.
const SUBMARKET_RE = / - \S/;
// Recognize the "draw" section.
const DRAW_RE = /\b(draw|tie|empate|x)\b/i;
// Recognize binary Yes/No outcomes.
const YES_RE = /^\s*(yes|s[ií])\s*$/i;
const NO_RE = /^\s*(no)\s*$/i;

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
};

/* ------------------------------ ELEMENTS --------------------------------- */
const el = {
  select: document.getElementById('match-select'),
  refresh: document.getElementById('refresh-btn'),
  status: document.getElementById('status'),
  spin: document.getElementById('spin-btn'),
  legend: document.getElementById('legend'),
  matchDesc: document.getElementById('match-desc'),
  result: document.getElementById('result'),
  resultText: document.getElementById('result-text'),
  oddsSource: document.getElementById('odds-source'),
  loading: document.getElementById('loading'),
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

async function getJSON(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} at ${url}`);
  return res.json();
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

// Resolve the World Cup tag ids from their slugs.
async function resolveTagIds() {
  const ids = [];
  for (const slug of CONFIG.worldCupTagSlugs) {
    try {
      const tag = await getJSON(`${CONFIG.gamma}/tags/slug/${slug}`);
      if (tag && tag.id) ids.push(String(tag.id));
    } catch {
      /* the tag may not exist; keep trying the rest */
    }
  }
  return [...new Set(ids)];
}

async function fetchEventsByTag(tagId) {
  const qs = new URLSearchParams({
    closed: 'false',
    limit: String(CONFIG.eventLimit),
    order: 'endDate',
    ascending: 'true',
    related_tags: 'true',
    tag_id: tagId,
  });
  return getJSON(`${CONFIG.gamma}/events?${qs.toString()}`);
}

// Fallback: if no tag is found, fetch events and filter by keywords.
async function fetchEventsFallback() {
  const qs = new URLSearchParams({
    closed: 'false',
    limit: '500',
    order: 'endDate',
    ascending: 'true',
  });
  const events = await getJSON(`${CONFIG.gamma}/events?${qs.toString()}`);
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

// Extract {label, prob} sections from a match event, or null if not a match.
function eventToMatch(ev) {
  const title = (ev.title || '').trim();
  // Keep only the full-time match result event: "Team A vs. Team B" with no
  // " - <suffix>" sub-market and no prop/outright keyword.
  if (!MATCH_TITLE_RE.test(title) || SUBMARKET_RE.test(title) || excluded(title)) return null;

  const markets = (ev.markets || []).filter(
    (m) => m && m.outcomes && (m.active !== false) && (m.closed !== true)
  );
  if (!markets.length) return null;

  let sections = fromSingleMarket(markets) || fromGroupedMarkets(markets);
  if (!sections || sections.length < 2) return null;

  sections = normalize(orderSections(sections));
  return {
    title: title || 'Match',
    sections,
    endDate: ev.endDate || (markets[0] && markets[0].endDate) || null,
    description: (ev.description || (markets[0] && markets[0].description) || '').trim(),
  };
}

function excluded(title) {
  const t = (title || '').toLowerCase();
  return CONFIG.excludeKeywords.some((k) => t.includes(k));
}

// Pattern 1: a single market with 2-3 outcomes that are NOT Yes/No (1X2).
function fromSingleMarket(markets) {
  const candidates = markets
    .map((m) => ({ m, outs: parseList(m.outcomes), prices: parseList(m.outcomePrices) }))
    .filter(({ outs }) => outs.length >= 2 && outs.length <= 3)
    .filter(({ outs }) => !outs.every((o) => YES_RE.test(o) || NO_RE.test(o)));

  if (!candidates.length) return null;
  // Prefer the one with 3 outcomes (includes the draw).
  candidates.sort((a, b) => b.outs.length - a.outs.length);
  const { outs, prices } = candidates[0];

  return outs.map((label, i) => ({
    label: String(label).trim(),
    prob: Number(prices[i]) || 0,
  }));
}

// Pattern 2: several binary Yes/No markets grouped (groupItemTitle per side).
function fromGroupedMarkets(markets) {
  const sections = [];
  for (const m of markets) {
    const outs = parseList(m.outcomes);
    const prices = parseList(m.outcomePrices);
    if (outs.length !== 2) continue;
    const yesIdx = outs.findIndex((o) => YES_RE.test(o));
    if (yesIdx === -1) continue;
    const label = (m.groupItemTitle || m.question || '').trim();
    if (!label) continue;
    sections.push({ label, prob: Number(prices[yesIdx]) || 0 });
  }
  return sections.length >= 2 ? sections : null;
}

// Order as [team1, draw, team2] when a draw is present.
function orderSections(sections) {
  const draw = sections.filter((s) => DRAW_RE.test(s.label));
  const teams = sections.filter((s) => !DRAW_RE.test(s.label));
  if (draw.length === 1 && teams.length === 2) {
    return [teams[0], draw[0], teams[1]];
  }
  return sections;
}

// Remove the "vig": rescale probabilities to sum to 1 and assign colors.
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
    return { label, prob, color };
  });
}

function endTime(match) {
  const t = match.endDate ? Date.parse(match.endDate) : NaN;
  return Number.isNaN(t) ? Infinity : t;
}

async function loadMatches() {
  let events = [];
  const tagIds = await resolveTagIds();
  for (const id of tagIds) {
    try {
      events.push(...(await fetchEventsByTag(id)));
    } catch (e) {
      console.warn('tag fetch failed', id, e);
    }
  }
  if (!events.length) events = await fetchEventsFallback();

  // Dedupe by event id.
  const seen = new Set();
  const matches = [];
  for (const ev of events) {
    if (seen.has(ev.id)) continue;
    seen.add(ev.id);
    const match = eventToMatch(ev);
    if (match) matches.push(match);
  }

  // Sort by closing date — soonest (next up) first.
  matches.sort((a, b) => endTime(a) - endTime(b));

  state.matches = matches;
  return matches;
}

/* ----------------------------- DROPDOWN ---------------------------------- */
function populateSelect() {
  el.select.innerHTML = '';
  state.matches.forEach((m, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = m.title;
    el.select.appendChild(opt);
  });
  el.select.disabled = false;
}

function selectMatch(index) {
  state.current = state.matches[index];
  state.rotation = 0;
  hideResult(); // clear any previous result on a different selection
  renderLegend();
  renderDescription();
  drawWheel();
  el.spin.disabled = false;
  el.oddsSource.textContent = `Odds: Polymarket · ${state.current.title}`;
}

function renderLegend() {
  const m = state.current;
  el.legend.innerHTML = '';
  m.sections.forEach((s) => {
    const item = document.createElement('span');
    item.className = 'legend__item';
    item.innerHTML =
      `<span class="legend__swatch" style="background:${s.color}"></span>` +
      `<span>${escapeHtml(s.label)}</span>` +
      `<span class="legend__pct">${pct(s.prob)}</span>`;
    el.legend.appendChild(item);
  });
  reserve(el.legend, true);
}

function renderDescription() {
  const desc = state.current && state.current.description;
  el.matchDesc.textContent = desc || '';
  el.matchDesc.scrollTop = 0;
  reserve(el.matchDesc, !!desc);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
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

function drawSectorLabel(r, start, end, section) {
  const sweep = end - start;
  const mid = -Math.PI / 2 + start + sweep / 2;
  const dist = r * 0.62;
  ctx.save();
  ctx.rotate(mid);
  ctx.translate(dist, 0);
  // Keep text upright on the left half.
  if (mid > Math.PI / 2 || mid < -Math.PI / 2) ctx.rotate(Math.PI);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '600 19px system-ui, sans-serif';
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 4;
  // Only show the label if the sector is large enough.
  if (sweep > 0.18) {
    const label = fit(section.label, 14);
    ctx.fillText(label, 0, -9);
    ctx.font = '700 16px system-ui, sans-serif';
    ctx.fillText(pct(section.prob), 0, 12);
  }
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

function announceWinner() {
  const winner = winnerAtPointer();
  el.resultText.textContent = `${winner.label} · ${pct(winner.prob)}`;
  el.resultText.style.color = winner.color;
  reserve(el.result, true);
}

function hideResult() {
  reserve(el.result, false);
}

/* ------------------------------ STARTUP ---------------------------------- */
async function init() {
  fitWheel();
  drawPlaceholder();
  hideResult();
  reserve(el.legend, false);
  reserve(el.matchDesc, false);
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
    setStatus(
      `Loaded ${matches.length} World Cup match(es) — pick one and spin.`,
      'ok'
    );
    selectMatch(0);
  } catch (err) {
    console.error(err);
    el.select.innerHTML = '<option>Error</option>';
    setStatus(
      `Could not reach Polymarket: ${err.message}. Check your connection and refresh.`,
      'error'
    );
  } finally {
    showLoading(false);
  }
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
    body.replaceChildren(link, privacy);
  } else {
    body.innerHTML =
      '<p class="stats-setup">To show visits and countries here:<br>' +
      '1. Create a free counter at ' +
      '<a href="https://flagcounter.com" target="_blank" rel="noopener">flagcounter.com</a>.<br>' +
      '2. Copy your counter <strong>code</strong> (the part of the image URL ' +
      'after <code>/count2/</code>).<br>' +
      '3. Paste it into <code>CONFIG.analytics.flagCounter.code</code> in ' +
      '<code>app.js</code>.</p>';
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

/* ------------------------------- EVENTS ---------------------------------- */
el.select.addEventListener('change', (e) => selectMatch(Number(e.target.value)));
el.spin.addEventListener('click', spin);
el.refresh.addEventListener('click', () => {
  if (state.spinning) return;
  init();
});

window.addEventListener('resize', fitWheel);

buildStats();
wireStatsWidget();

fitWheel();
requestAnimationFrame(fitWheel); // re-fit once layout/fonts have settled
init();
