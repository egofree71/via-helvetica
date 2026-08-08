/**
 * Business context: provides the only server-side bridge needed for Via
 * Helvetica's swisstopo QR hand-off. It accepts a small GPX generated in the
 * browser, stores it under an unguessable temporary R2 key, serves that exact
 * file publicly to swisstopo, and removes expired objects on a scheduled pass.
 * Routing, user state, and normal GPX export remain entirely browser-side.
 */

/** Prefix isolates temporary shares from immutable routing objects in the same bucket. */
const SHARE_PREFIX = 'swisstopo-share/';
/** GPX payloads are small; this cap blocks use as a generic file-hosting endpoint. */
const MAX_GPX_BYTES = 2 * 1024 * 1024;
/** Default lifetime is long enough to transfer a route without creating route storage. */
const DEFAULT_SHARE_TTL_SECONDS = 24 * 60 * 60;
/** A prototype share should never become multi-week persistence by configuration mistake. */
const MAX_SHARE_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Parses the comma-separated browser origins allowed to create temporary shares. */
function allowedOrigins(env) {
  return (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/** Returns the caller origin only when it is explicitly allowed. */
function resolveCorsOrigin(request, env) {
  const origin = request.headers.get('Origin');
  return origin && allowedOrigins(env).includes(origin) ? origin : null;
}

/** Adds CORS headers only to responses used by the browser upload endpoint. */
function withCors(response, corsOrigin) {
  if (!corsOrigin) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', corsOrigin);
  headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  headers.set('Access-Control-Max-Age', '86400');
  headers.append('Vary', 'Origin');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Creates a compact JSON error while preserving the upload endpoint's CORS policy. */
function jsonError(message, status, corsOrigin = null) {
  return withCors(
    Response.json({ error: message }, { status }),
    corsOrigin,
  );
}

/** Reads and bounds the configurable temporary-share lifetime. */
function shareTtlSeconds(env) {
  const configured = Number.parseInt(env.SHARE_TTL_SECONDS || '', 10);

  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_SHARE_TTL_SECONDS;
  }

  return Math.min(configured, MAX_SHARE_TTL_SECONDS);
}

/** Performs shallow GPX validation without turning the Worker into an XML parser. */
function isPlausibleGpx(document) {
  return (
    /<gpx(?:\s|>)/iu.test(document) &&
    /<trk(?:\s|>)/iu.test(document) &&
    /<trkpt(?:\s|>)/iu.test(document) &&
    !/<!DOCTYPE/iu.test(document) &&
    !/<!ENTITY/iu.test(document)
  );
}

/** Derives the stable public URL that swisstopo will fetch after QR scanning. */
function publicGpxUrl(request, env, key) {
  const configuredBase = (env.GPX_PUBLIC_BASE_URL || '').trim();
  const baseUrl = configuredBase || new URL(request.url).origin;
  return new URL(`/gpx/${key.slice(SHARE_PREFIX.length)}`, baseUrl).toString();
}

/** Rejects expired objects even if the scheduled cleanup has not run yet. */
function isExpired(object) {
  const expiresAt = object.customMetadata?.expiresAt;
  const timestamp = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}

/** Stores one explicit user-requested GPX under an unguessable temporary key. */
async function uploadGpx(request, env, corsOrigin) {
  const contentLength = Number.parseInt(
    request.headers.get('Content-Length') || '',
    10,
  );

  if (Number.isFinite(contentLength) && contentLength > MAX_GPX_BYTES) {
    return jsonError('GPX payload is too large.', 413, corsOrigin);
  }

  const bytes = new Uint8Array(await request.arrayBuffer());

  if (bytes.byteLength === 0 || bytes.byteLength > MAX_GPX_BYTES) {
    return jsonError('GPX payload is empty or too large.', 413, corsOrigin);
  }

  const document = new TextDecoder('utf-8', { fatal: false }).decode(bytes);

  if (!isPlausibleGpx(document)) {
    return jsonError('Payload is not a supported GPX track.', 400, corsOrigin);
  }

  const ttlSeconds = shareTtlSeconds(env);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const key = `${SHARE_PREFIX}${crypto.randomUUID()}.gpx`;

  await env.GPX_BUCKET.put(key, bytes, {
    httpMetadata: {
      contentType: 'application/gpx+xml; charset=utf-8',
    },
    customMetadata: {
      expiresAt,
    },
  });

  return withCors(
    Response.json(
      {
        gpxUrl: publicGpxUrl(request, env, key),
        expiresAt,
      },
      {
        headers: {
          'Cache-Control': 'no-store',
        },
      },
    ),
    corsOrigin,
  );
}

/** Serves one temporary GPX publicly because swisstopo must fetch it by URL. */
async function serveGpx(request, env, key) {
  const object = await env.GPX_BUCKET.get(key);

  if (!object) {
    return new Response('Not found', { status: 404 });
  }

  if (isExpired(object)) {
    await env.GPX_BUCKET.delete(key);
    return new Response('Expired', { status: 410 });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Content-Type', 'application/gpx+xml; charset=utf-8');
  headers.set('Cache-Control', 'public, max-age=300');
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('X-Content-Type-Options', 'nosniff');

  if (request.method === 'HEAD') {
    return new Response(null, { headers });
  }

  return new Response(object.body, { headers });
}

/** Deletes expired share objects in bounded R2 list batches. */
async function deleteExpiredShares(env) {
  let cursor;

  do {
    const listed = await env.GPX_BUCKET.list({
      prefix: SHARE_PREFIX,
      cursor,
      include: ['customMetadata'],
    });
    const expiredKeys = listed.objects
      .filter(isExpired)
      .map((object) => object.key);

    if (expiredKeys.length > 0) {
      await env.GPX_BUCKET.delete(expiredKeys);
    }

    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const corsOrigin = resolveCorsOrigin(request, env);

    if (request.method === 'OPTIONS' && url.pathname === '/gpx') {
      if (!corsOrigin) {
        return new Response(null, { status: 403 });
      }

      return withCors(new Response(null, { status: 204 }), corsOrigin);
    }

    if (request.method === 'POST' && url.pathname === '/gpx') {
      if (!corsOrigin) {
        return jsonError('Origin is not allowed.', 403);
      }

      return uploadGpx(request, env, corsOrigin);
    }

    const match = /^\/gpx\/([0-9a-f-]{36}\.gpx)$/iu.exec(url.pathname);

    if (match && (request.method === 'GET' || request.method === 'HEAD')) {
      return serveGpx(request, env, `${SHARE_PREFIX}${match[1]}`);
    }

    return new Response('Not found', { status: 404 });
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(deleteExpiredShares(env));
  },
};
