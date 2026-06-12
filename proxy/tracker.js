// Cloudflare Worker — first-party visit tracker for gonnafind.com (Capa 2).
//
// Two endpoints, one Worker, mounted on the route `gonnafind.com/t*`:
//
//   POST /t        records a hit. The page sends a tiny beacon with
//                  {page, ref, evt}; the visitor's country comes from
//                  Cloudflare's own edge geo (request.cf.country) — no IP,
//                  no user-agent, no cookie is ever stored.
//   GET  /t/stats  public aggregated JSON (totals, per-country medal table,
//                  per-channel and per-page counts). Edge-cached 60s so the
//                  /flags medal board can poll it freely without hammering D1.
//
// ── One-time setup (Cloudflare dashboard) ──────────────────────────────────
// 1. Workers & Pages → D1 → Create database → name: `gonnafind`
// 2. In the database's Console tab, run the schema below (once):
//
//      CREATE TABLE IF NOT EXISTS hits (
//        id      INTEGER PRIMARY KEY AUTOINCREMENT,
//        ts      INTEGER NOT NULL,            -- unix seconds
//        country TEXT    NOT NULL DEFAULT 'XX',
//        page    TEXT    NOT NULL DEFAULT '/',
//        ref     TEXT    NOT NULL DEFAULT '',  -- channel: tk / ig / tw / …
//        evt     TEXT    NOT NULL DEFAULT 'view'
//      );
//      CREATE INDEX IF NOT EXISTS hits_ts      ON hits (ts);
//      CREATE INDEX IF NOT EXISTS hits_country ON hits (country);
//
// 3. Workers & Pages → Create Worker → name: `gf-tracker` → paste this file.
// 4. Worker → Settings → Bindings → Add → D1 database:
//      variable name `DB`  →  database `gonnafind`   (the name must be DB).
// 5. Worker → Settings → Domains & Routes → Add route:
//      `gonnafind.com/t*`  (zone gonnafind.com).
//
// The page beacons fail silently while any of this is missing, so deploy
// order never breaks the site.

const ALLOW_ORIGINS = [
  'https://gonnafind.com',
  'https://www.gonnafind.com',
  'https://git-ruribe.github.io',
];

const EVENTS = new Set(['view', 'spin', 'bracket']);

function corsHeaders(origin) {
  const allow = ALLOW_ORIGINS.includes(origin) ? origin : ALLOW_ORIGINS[0];
  return {
    'access-control-allow-origin': allow,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'vary': 'Origin',
  };
}

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request.headers.get('Origin') || '');
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === '/t' && request.method === 'POST') {
      return recordHit(request, env, cors);
    }
    if (url.pathname === '/t/stats' && request.method === 'GET') {
      return stats(request, env, ctx, cors);
    }
    return new Response('Not Found', { status: 404, headers: cors });
  },
};

async function recordHit(request, env, cors) {
  // Crawlers and link-preview fetchers would pollute the medal table.
  const ua = request.headers.get('user-agent') || '';
  if (/bot|crawl|spider|preview|scrape|curl|wget|python|monitor/i.test(ua)) {
    return new Response(null, { status: 204, headers: cors });
  }

  let body = {};
  try { body = JSON.parse(await request.text()); } catch { /* beacon noise */ }

  // Country is taken from Cloudflare's edge, never from the client.
  const country = (request.cf && request.cf.country) || 'XX';
  const page = typeof body.page === 'string' && body.page.startsWith('/')
    ? body.page.slice(0, 64) : '/';
  const ref = typeof body.ref === 'string' && /^[a-z0-9_-]{1,24}$/i.test(body.ref)
    ? body.ref.toLowerCase() : '';
  const evt = EVENTS.has(body.evt) ? body.evt : 'view';

  try {
    await env.DB.prepare(
      'INSERT INTO hits (ts, country, page, ref, evt) VALUES (?1, ?2, ?3, ?4, ?5)'
    ).bind(Math.floor(Date.now() / 1000), country, page, ref, evt).run();
  } catch (e) {
    // Missing table/binding must never surface to the visitor.
    return new Response(null, { status: 204, headers: cors });
  }
  return new Response(null, { status: 204, headers: cors });
}

async function stats(request, env, ctx, cors) {
  // Serve from the edge cache when fresh — D1 is only queried once a minute
  // per colo no matter how many people watch the medal board.
  const cacheKey = new Request(new URL('/t/stats', request.url).toString());
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) {
    const res = new Response(hit.body, hit);
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  }

  const dayAgo = Math.floor(Date.now() / 1000) - 86400;
  let payload;
  try {
    const [total, last24, countries, refs, pages] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) n FROM hits WHERE evt = 'view'").first(),
      env.DB.prepare("SELECT COUNT(*) n FROM hits WHERE evt = 'view' AND ts >= ?1")
        .bind(dayAgo).first(),
      env.DB.prepare(
        "SELECT country c, COUNT(*) n, SUM(ts >= ?1) d FROM hits WHERE evt = 'view' " +
        'GROUP BY country ORDER BY n DESC LIMIT 150'
      ).bind(dayAgo).all(),
      env.DB.prepare(
        "SELECT ref r, COUNT(*) n FROM hits WHERE evt = 'view' AND ref != '' " +
        'GROUP BY ref ORDER BY n DESC LIMIT 30'
      ).all(),
      env.DB.prepare(
        "SELECT page p, COUNT(*) n FROM hits WHERE evt = 'view' " +
        'GROUP BY page ORDER BY n DESC LIMIT 30'
      ).all(),
    ]);
    payload = {
      total: total ? total.n : 0,
      last24h: last24 ? last24.n : 0,
      countries: countries.results || [],   // [{c:'MX', n: all-time, d: last 24h}]
      refs: refs.results || [],
      pages: pages.results || [],
      generatedAt: new Date().toISOString(),
    };
  } catch (e) {
    return new Response(JSON.stringify({ error: 'stats_unavailable' }), {
      status: 503,
      headers: { ...cors, 'content-type': 'application/json' },
    });
  }

  const res = new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      ...cors,
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=60',
    },
  });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}
