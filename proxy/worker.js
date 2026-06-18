// Cloudflare Worker — read-only proxy for Polymarket's public Gamma API.
//
// Why: in regions where Polymarket is geo-blocked (e.g. Switzerland), the
// visitor's IP can't reach gamma-api.polymarket.com. This Worker runs on
// Cloudflare's network, so it fetches the data from a non-blocked IP and
// returns it to the browser with CORS headers.
//
// It is NOT an open proxy: it only forwards GET requests to the two read-only
// endpoints the app uses (/events and /tags/...), and only accepts the app's
// own origins via CORS.

const UPSTREAM = 'https://gamma-api.polymarket.com';

const ALLOW_ORIGINS = [
  'https://gonnafind.com',
  'https://www.gonnafind.com',
  'https://git-ruribe.github.io',
];

function corsHeaders(origin) {
  const allow = ALLOW_ORIGINS.includes(origin) ? origin : ALLOW_ORIGINS[0];
  return {
    'access-control-allow-origin': allow,
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'accept',
    'vary': 'Origin',
  };
}

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'GET') {
      return new Response('Method Not Allowed', { status: 405, headers: cors });
    }

    const url = new URL(request.url);

    // Image passthrough: the share-card canvas needs team flags to be CORS-clean
    // or toBlob() throws on a tainted canvas. Polymarket's logo CDNs send no CORS
    // header, so the browser asks us to refetch the image and return it with one.
    // Constrained on purpose: GET only, HTTPS only, image content-types only and
    // a size cap — it forwards pictures, not arbitrary data.
    if (url.pathname === '/img') {
      const src = url.searchParams.get('url');
      let imgUrl;
      try {
        imgUrl = new URL(src);
      } catch {
        return new Response('Bad url', { status: 400, headers: cors });
      }
      if (imgUrl.protocol !== 'https:') {
        return new Response('Bad scheme', { status: 400, headers: cors });
      }
      let img;
      try {
        img = await fetch(imgUrl.toString(), {
          cf: { cacheTtl: 86400, cacheEverything: true },
        });
      } catch {
        return new Response('upstream_unreachable', { status: 502, headers: cors });
      }
      const ct = img.headers.get('content-type') || '';
      const len = Number(img.headers.get('content-length') || 0);
      if (!img.ok || !ct.startsWith('image/') || len > 8 * 1024 * 1024) {
        return new Response('Not an image', { status: 415, headers: cors });
      }
      return new Response(img.body, {
        status: 200,
        headers: { ...cors, 'content-type': ct, 'cache-control': 'public, max-age=86400' },
      });
    }

    const ok = url.pathname === '/events' || url.pathname.startsWith('/tags/');
    if (!ok) {
      return new Response('Not Found', { status: 404, headers: cors });
    }

    const target = UPSTREAM + url.pathname + url.search;
    let upstream;
    try {
      upstream = await fetch(target, {
        headers: { accept: 'application/json' },
        cf: { cacheTtl: 20, cacheEverything: true },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: 'upstream_unreachable' }), {
        status: 502,
        headers: { ...cors, 'content-type': 'application/json' },
      });
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        ...cors,
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'public, max-age=20',
      },
    });
  },
};
