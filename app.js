/* ===========================================================================
 * Ruleta Mundial — odds de Polymarket
 * App vanilla (HTML + CSS + JS). Sin build, sin dependencias.
 *
 * Flujo:
 *   1. Descubre partidos del Mundial vía la Gamma API de Polymarket (CORS ok).
 *   2. Normaliza cada partido a secciones {label, prob} quitando el "vig"
 *      (las probabilidades se reescalan para sumar 1).
 *   3. Dibuja una ruleta donde el ángulo de cada sección = prob * 360°.
 *   4. Al girar, aterriza de forma uniforme: como los sectores ya están
 *      dimensionados por probabilidad, el resultado queda ponderado por los odds.
 * ===========================================================================*/

'use strict';

/* ----------------------------- CONFIGURACIÓN ----------------------------- */
const CONFIG = {
  gamma: 'https://gamma-api.polymarket.com',
  // Slugs de etiqueta candidatos para el Mundial (se prueban en orden).
  worldCupTagSlugs: ['world-cup', '2026-fifa-world-cup', 'fifa-world-cup'],
  // Palabras clave de respaldo para reconocer el Mundial en tags/título/slug.
  worldCupKeywords: ['world cup', 'fifa world cup', 'mundial', 'wc 2026'],
  // Cuántos eventos pedir por etiqueta.
  eventLimit: 300,
  // Etiquetas que NO son partidos 1-X-2 (outrights/props) — se descartan.
  excludeKeywords: [
    'winner', 'group', 'top scorer', 'golden', 'player to', 'to advance',
    'to win the', 'champion', 'golden boot', 'ganador', 'grupo',
  ],
};

// Reconocer la sección de "empate".
const DRAW_RE = /\b(draw|tie|empate|x)\b/i;
// Reconocer outcomes binarios Sí/No.
const YES_RE = /^\s*(yes|s[ií])\s*$/i;
const NO_RE = /^\s*(no)\s*$/i;

const COLORS = {
  team1: '#2f81f7',
  draw: '#6e7681',
  team2: '#f85149',
};

/* ------------------------------- ESTADO ---------------------------------- */
const state = {
  matches: [],
  current: null, // { title, sections: [{label, prob, color}], source }
  rotation: 0, // radianes
  spinning: false,
};

/* ------------------------------ ELEMENTOS -------------------------------- */
const el = {
  select: document.getElementById('match-select'),
  refresh: document.getElementById('refresh-btn'),
  status: document.getElementById('status'),
  spin: document.getElementById('spin-btn'),
  legend: document.getElementById('legend'),
  result: document.getElementById('result'),
  resultText: document.getElementById('result-text'),
  oddsSource: document.getElementById('odds-source'),
  canvas: document.getElementById('wheel'),
};
const ctx = el.canvas.getContext('2d');

/* ------------------------------- HELPERS --------------------------------- */
function setStatus(msg, kind = '') {
  el.status.textContent = msg || '';
  el.status.className = 'status' + (kind ? ` status--${kind}` : '');
}

async function getJSON(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
  return res.json();
}

// Los campos outcomes / outcomePrices llegan como string JSON o ya como array.
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

/* --------------------------- CAPA DE DATOS ------------------------------- */

// Resuelve los ids de las etiquetas del Mundial a partir de sus slugs.
async function resolveTagIds() {
  const ids = [];
  for (const slug of CONFIG.worldCupTagSlugs) {
    try {
      const tag = await getJSON(`${CONFIG.gamma}/tags/slug/${slug}`);
      if (tag && tag.id) ids.push(String(tag.id));
    } catch {
      /* la etiqueta puede no existir; seguimos con las demás */
    }
  }
  return [...new Set(ids)];
}

async function fetchEventsByTag(tagId) {
  const qs = new URLSearchParams({
    closed: 'false',
    limit: String(CONFIG.eventLimit),
    order: 'startDate',
    ascending: 'true',
    related_tags: 'true',
    tag_id: tagId,
  });
  return getJSON(`${CONFIG.gamma}/events?${qs.toString()}`);
}

// Respaldo: si no hay etiqueta, traer eventos y filtrar por palabras clave.
async function fetchEventsFallback() {
  const qs = new URLSearchParams({
    closed: 'false',
    limit: '500',
    order: 'startDate',
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

// Extrae las secciones {label, prob} de un evento-partido, o null si no aplica.
function eventToMatch(ev) {
  const title = (ev.title || '').trim();
  if (excluded(title)) return null;

  const markets = (ev.markets || []).filter(
    (m) => m && m.outcomes && (m.active !== false) && (m.closed !== true)
  );
  if (!markets.length) return null;

  let sections = fromSingleMarket(markets) || fromGroupedMarkets(markets);
  if (!sections || sections.length < 2) return null;

  sections = normalize(orderSections(sections));
  return { title: title || 'Partido', sections, source: 'Polymarket' };
}

function excluded(title) {
  const t = (title || '').toLowerCase();
  return CONFIG.excludeKeywords.some((k) => t.includes(k));
}

// Patrón 1: un único mercado con 2-3 outcomes que NO son Sí/No (moneyline 1X2).
function fromSingleMarket(markets) {
  const candidates = markets
    .map((m) => ({ m, outs: parseList(m.outcomes), prices: parseList(m.outcomePrices) }))
    .filter(({ outs }) => outs.length >= 2 && outs.length <= 3)
    .filter(({ outs }) => !outs.every((o) => YES_RE.test(o) || NO_RE.test(o)));

  if (!candidates.length) return null;
  // Preferir el de 3 outcomes (incluye empate).
  candidates.sort((a, b) => b.outs.length - a.outs.length);
  const { outs, prices } = candidates[0];

  return outs.map((label, i) => ({
    label: String(label).trim(),
    prob: Number(prices[i]) || 0,
  }));
}

// Patrón 2: varios mercados binarios Sí/No agrupados (groupItemTitle por sección).
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

// Ordena como [equipo1, empate, equipo2] cuando hay empate.
function orderSections(sections) {
  const draw = sections.filter((s) => DRAW_RE.test(s.label));
  const teams = sections.filter((s) => !DRAW_RE.test(s.label));
  if (draw.length === 1 && teams.length === 2) {
    return [teams[0], draw[0], teams[1]];
  }
  return sections;
}

// Quita el "vig": reescala las probabilidades para que sumen 1 y asigna color.
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

async function loadMatches() {
  setStatus('Consultando Polymarket…');
  el.select.disabled = true;
  el.spin.disabled = true;

  let events = [];
  const tagIds = await resolveTagIds();
  for (const id of tagIds) {
    try {
      events.push(...(await fetchEventsByTag(id)));
    } catch (e) {
      console.warn('tag fetch falló', id, e);
    }
  }
  if (!events.length) events = await fetchEventsFallback();

  // Dedupe por id de evento.
  const seen = new Set();
  const matches = [];
  for (const ev of events) {
    if (seen.has(ev.id)) continue;
    seen.add(ev.id);
    const match = eventToMatch(ev);
    if (match) matches.push(match);
  }

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
  hideResult();
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

/* ---------------------------- RENDER RULETA ------------------------------ */
// Ángulos en sentido horario desde arriba (12 en punto).
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
  const TOP = -Math.PI / 2; // 12 en punto en coordenadas de canvas

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

  // Borde y centro.
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.lineWidth = 6;
  ctx.strokeStyle = '#0d1117';
  ctx.stroke();
  ctx.restore();

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
  // Mantener texto legible (no de cabeza) en la mitad izquierda.
  if (mid > Math.PI / 2 || mid < -Math.PI / 2) ctx.rotate(Math.PI);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '600 19px system-ui, sans-serif';
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 4;
  // Solo mostrar etiqueta si el sector es suficientemente grande.
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

/* ------------------------------- GIRO ------------------------------------ */
function spin() {
  if (state.spinning || !state.current) return;
  state.spinning = true;
  el.spin.disabled = true;
  el.select.disabled = true;
  hideResult();

  // Aterrizaje uniforme: ángulo final aleatorio sobre toda la circunferencia.
  // Como los sectores están dimensionados por probabilidad, el resultado
  // queda ponderado por los odds de forma natural.
  const extraTurns = 5 + Math.floor(Math.random() * 4); // 5–8 vueltas
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

// Determina qué sector quedó bajo el puntero (arriba) tras detenerse.
function winnerAtPointer() {
  const TWO_PI = Math.PI * 2;
  // Un punto a ángulo local `a` aparece en pantalla a `a + rotation`.
  // El puntero está en 0 (arriba) → a = -rotation (mod 2π).
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

/* ------------------------------ ARRANQUE --------------------------------- */
async function init() {
  drawPlaceholder();
  try {
    const matches = await loadMatches();
    if (!matches.length) {
      el.select.innerHTML = '<option>Sin partidos disponibles</option>';
      setStatus(
        'No se encontraron partidos del Mundial con mercado 1-X-2 en Polymarket.',
        'error'
      );
      return;
    }
    populateSelect();
    setStatus(`${matches.length} partido(s) disponibles.`, 'ok');
    selectMatch(0);
  } catch (err) {
    console.error(err);
    el.select.innerHTML = '<option>Error</option>';
    setStatus(
      `No se pudo consultar Polymarket: ${err.message}. Revisa tu conexión e intenta refrescar.`,
      'error'
    );
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

/* ------------------------------- EVENTOS --------------------------------- */
el.select.addEventListener('change', (e) => selectMatch(Number(e.target.value)));
el.spin.addEventListener('click', spin);
el.refresh.addEventListener('click', () => {
  if (state.spinning) return;
  init();
});

init();
