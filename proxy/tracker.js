// Cloudflare Worker — first-party visit tracker for gonnafind.com (Capa 2).
//
// Two endpoints, one Worker, mounted on the route `gonnafind.com/t*`:
//
//   POST /t        records a hit. The page sends a tiny beacon with
//                  {page, ref, evt}; country, region and city come from
//                  Cloudflare's own edge geo (request.cf) — no IP,
//                  no user-agent, no cookie is ever stored.
//   GET  /t/stats  public aggregated JSON (totals, per-country medal table,
//                  per-region, per-channel and per-page counts). Edge-cached
//                  60s so the /flags medal board can poll it without
//                  hammering D1.
//
// ── One-time setup (Cloudflare dashboard) ──────────────────────────────────
// 1. Workers & Pages → D1 → Create database → name: `gonnafind`
// 2. In the database's Console tab, run the schema below (once):
//
//      CREATE TABLE IF NOT EXISTS hits (
//        id      INTEGER PRIMARY KEY AUTOINCREMENT,
//        ts      INTEGER NOT NULL,            -- unix seconds
//        country TEXT    NOT NULL DEFAULT 'XX',
//        region  TEXT    NOT NULL DEFAULT '',  -- state/province ("Texas")
//        city    TEXT    NOT NULL DEFAULT '',
//        page    TEXT    NOT NULL DEFAULT '/',
//        ref     TEXT    NOT NULL DEFAULT '',  -- channel: tk / ig / tw / …
//        evt     TEXT    NOT NULL DEFAULT 'view'
//      );
//      CREATE INDEX IF NOT EXISTS hits_ts      ON hits (ts);
//      CREATE INDEX IF NOT EXISTS hits_country ON hits (country);
//
//    (If the table predates the region/city columns, migrate with:
//      ALTER TABLE hits ADD COLUMN region TEXT NOT NULL DEFAULT '';
//      ALTER TABLE hits ADD COLUMN city   TEXT NOT NULL DEFAULT '';  )
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

const EVENTS = new Set(['view', 'spin', 'share', 'bracket']);

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

  // Geo is taken from Cloudflare's edge, never from the client.
  const cf = request.cf || {};
  const country = cf.country || 'XX';
  const region = String(cf.region || cf.regionCode || '').slice(0, 48);
  const city = String(cf.city || '').slice(0, 48);
  const page = typeof body.page === 'string' && body.page.startsWith('/')
    ? body.page.slice(0, 64) : '/';
  const ref = typeof body.ref === 'string' && /^[a-z0-9_-]{1,24}$/i.test(body.ref)
    ? body.ref.toLowerCase() : '';
  const evt = EVENTS.has(body.evt) ? body.evt : 'view';

  const ts = Math.floor(Date.now() / 1000);
  try {
    await env.DB.prepare(
      'INSERT INTO hits (ts, country, region, city, page, ref, evt) ' +
      'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)'
    ).bind(ts, country, region, city, page, ref, evt).run();
  } catch (e) {
    // Pre-migration table without region/city columns: don't drop the hit.
    try {
      await env.DB.prepare(
        'INSERT INTO hits (ts, country, page, ref, evt) VALUES (?1, ?2, ?3, ?4, ?5)'
      ).bind(ts, country, page, ref, evt).run();
    } catch (e2) {
      // Missing table/binding must never surface to the visitor.
    }
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
    // Legacy FlagCounter totals imported into a `baseline` table merge into
    // the all-time numbers so the medal board doesn't start from zero. The
    // table is optional — without it, live hits alone are served.
    //   CREATE TABLE IF NOT EXISTS baseline (country TEXT PRIMARY KEY, n INTEGER NOT NULL);
    let baseTotal = 0; const baseByCountry = new Map();
    try {
      const base = await env.DB.prepare('SELECT country c, n FROM baseline').all();
      for (const r of base.results || []) { baseByCountry.set(r.c, r.n); baseTotal += r.n; }
    } catch { /* no baseline table yet */ }

    const [total, last24, countries, refs, pages, events, funnel] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) n FROM hits WHERE evt = 'view'").first(),
      env.DB.prepare("SELECT COUNT(*) n FROM hits WHERE evt = 'view' AND ts >= ?1")
        .bind(dayAgo).first(),
      env.DB.prepare(
        "SELECT country c, COUNT(*) n, SUM(ts >= ?1) d FROM hits WHERE evt = 'view' " +
        'GROUP BY country ORDER BY n DESC LIMIT 250'
      ).bind(dayAgo).all(),
      env.DB.prepare(
        "SELECT ref r, COUNT(*) n FROM hits WHERE evt = 'view' AND ref != '' " +
        'GROUP BY ref ORDER BY n DESC LIMIT 30'
      ).all(),
      env.DB.prepare(
        "SELECT page p, COUNT(*) n FROM hits WHERE evt = 'view' " +
        'GROUP BY page ORDER BY n DESC LIMIT 30'
      ).all(),
      // Funnel: per-event totals (all-time + last 24h) across every event type
      // — view / spin / share / bracket. This is what makes the funnel visible.
      env.DB.prepare(
        'SELECT evt e, COUNT(*) n, SUM(ts >= ?1) d FROM hits GROUP BY evt ORDER BY n DESC'
      ).bind(dayAgo).all(),
      // Same funnel broken down by acquisition channel (?ref=), so reach can be
      // judged per source: which channel turns views into spins/shares.
      env.DB.prepare(
        "SELECT ref r, evt e, COUNT(*) n FROM hits WHERE ref != '' " +
        'GROUP BY ref, evt ORDER BY r, n DESC LIMIT 200'
      ).all(),
    ]);

    // Region/city breakdowns are best-effort: a pre-migration table without
    // those columns just yields empty lists.
    let regions = [], cities = [];
    try {
      const [rg, ci] = await Promise.all([
        env.DB.prepare(
          "SELECT country c, region rg, COUNT(*) n FROM hits " +
          "WHERE evt = 'view' AND region != '' " +
          'GROUP BY country, region ORDER BY n DESC LIMIT 100'
        ).all(),
        env.DB.prepare(
          "SELECT country c, city ci, COUNT(*) n FROM hits " +
          "WHERE evt = 'view' AND city != '' " +
          'GROUP BY country, city ORDER BY n DESC LIMIT 100'
        ).all(),
      ]);
      regions = rg.results || [];
      cities = ci.results || [];
    } catch { /* region/city columns not migrated yet */ }

    const merged = new Map();
    for (const r of countries.results || []) merged.set(r.c, { c: r.c, n: r.n, d: r.d || 0 });
    for (const [c, n] of baseByCountry) {
      const row = merged.get(c) || { c, n: 0, d: 0 };
      row.n += n;
      merged.set(c, row);
    }
    const list = [...merged.values()].sort((a, b) => b.n - a.n).slice(0, 150);

    payload = {
      total: (total ? total.n : 0) + baseTotal,
      last24h: last24 ? last24.n : 0,
      countries: list,                      // [{c:'MX', n: all-time, d: last 24h}]
      regions,                              // [{c:'US', rg:'Texas', n}]
      cities,                               // [{c:'MX', ci:'Monterrey', n}]
      refs: refs.results || [],
      pages: pages.results || [],
      events: events.results || [],         // [{e:'view'|'spin'|'share'|'bracket', n, d}]
      funnelByRef: funnel.results || [],    // [{r:'ig', e:'spin', n}]
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
