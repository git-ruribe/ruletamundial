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
  // Tags that are NOT 1-X-2 matches (outrights/props) — discarded.
  excludeKeywords: [
    'winner', 'group', 'top scorer', 'golden', 'player to', 'to advance',
    'to win the', 'champion', 'golden boot', 'to qualify', 'to reach',
  ],
};

// Only treat an event as a match when its title looks like "A vs B".
const MATCH_TITLE_RE = /\s+v(?:s)?\.?\s+/i;
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
  result: document.getElementById('result'),
  resultText: document.getElementById('result-text'),
  oddsSource: document.getElementById('odds-source'),
  loading: document.getElementById('loading'),
  canvas: document.getElementById('wheel'),
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
  // Keep only head-to-head matches ("A vs B"), not outrights/props.
  if (!MATCH_TITLE_RE.test(title) || excluded(title)) return null;

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
    return { label: s.label, prob, color };
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
  el.legend.hidden = false;
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
  el.result.hidden = false;
}

function hideResult() {
  el.result.hidden = true;
}

/* ------------------------------ STARTUP ---------------------------------- */
async function init() {
  drawPlaceholder();
  hideResult();
  el.legend.hidden = true;
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
    setStatus(`${matches.length} match(es) available.`, 'ok');
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

/* ------------------------------- EVENTS ---------------------------------- */
el.select.addEventListener('change', (e) => selectMatch(Number(e.target.value)));
el.spin.addEventListener('click', spin);
el.refresh.addEventListener('click', () => {
  if (state.spinning) return;
  init();
});

init();
