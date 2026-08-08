/**
 * Business context: provides the only server-side bridge needed for Via
 * Helvetica's swisstopo hand-off. It accepts the current GPX document supplied
 * by the browser, whether generated locally or retained from a read-only import,
 * stores it under an unguessable temporary R2 key, serves that exact file
 * publicly to swisstopo, and removes expired objects on a scheduled pass.
 * Routing, user state, and normal GPX export remain entirely browser-side.
 */

/** Prefix keeps temporary shares grouped inside the dedicated GPX share bucket. */
const SHARE_PREFIX = 'swisstopo-share/';
/** GPX payloads are small; keep this in sync with the browser-side share limit. */
const MAX_GPX_BYTES = 2 * 1024 * 1024;
/** Official swisstopo hand-off prefix encoded into the browser QR code. */
const SWISSTOPO_IMPORT_URL_PREFIX = 'https://swisstopo.app/u/';
/** Built-in QR encoder capacity in UTF-8 bytes for its fixed Version 8 symbol. */
const QR_MAX_TEXT_BYTES = 192;
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

/**
 * Applies the optional Cloudflare Rate Limiting binding before any GPX body is
 * buffered. The anonymous service has no user identifier, so the Cloudflare
 * client IP is used with a deliberately generous limit to reduce NAT collisions.
 *
 * @param {Request} request - Incoming upload request.
 * @param {object} env - Worker bindings; the limiter is optional for local use.
 * @returns {Promise<boolean>} True when the request may continue.
 */
async function isUploadAllowedByRateLimit(request, env) {
  if (!env.GPX_RATE_LIMITER) {
    return true;
  }

  const clientKey =
    request.headers.get('CF-Connecting-IP') || 'unknown-client';
  const { success } = await env.GPX_RATE_LIMITER.limit({ key: clientKey });
  return success;
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

/**
 * Performs shallow GPX validation without turning the Worker into an XML parser.
 * Optional namespace prefixes are accepted because the browser importer is
 * namespace-agnostic and the Worker must not reject GPX already accepted there.
 *
 * @param {string} document - Decoded GPX XML text.
 * @returns {boolean} True when supported track or route geometry is present.
 */
function isPlausibleGpx(document) {
  const hasTrack =
    /<(?:[\w.-]+:)?trk(?:\s|\/|>)/iu.test(document) &&
    /<(?:[\w.-]+:)?trkpt(?:\s|\/|>)/iu.test(document);
  const hasRoute =
    /<(?:[\w.-]+:)?rte(?:\s|\/|>)/iu.test(document) &&
    /<(?:[\w.-]+:)?rtept(?:\s|\/|>)/iu.test(document);

  return (
    /<(?:[\w.-]+:)?gpx(?:\s|\/|>)/iu.test(document) &&
    (hasTrack || hasRoute) &&
    !/<!DOCTYPE/iu.test(document) &&
    !/<!ENTITY/iu.test(document)
  );
}

/** Derives the stable public URL that swisstopo will fetch after QR scanning. */
function publicGpxUrl(request, env, key) {
  const configuredBase = (env.GPX_PUBLIC_BASE_URL || '').trim();
  const baseUrl = configuredBase || new URL(request.url).origin;
  const publicUrl = new URL(
    `/gpx/${key.slice(SHARE_PREFIX.length)}`,
    baseUrl,
  );

  if (publicUrl.protocol !== 'https:') {
    throw new Error('The public GPX base URL must use HTTPS.');
  }

  return publicUrl.toString();
}

/**
 * Checks whether the resulting swisstopo hand-off still fits the built-in QR.
 * Base64url expands arbitrary UTF-8 bytes to ceil(n * 8 / 6) ASCII characters,
 * so the Worker can reject an unsuitable public origin before writing to R2.
 *
 * @param {string} gpxUrl - Public HTTPS URL that swisstopo will fetch.
 * @returns {boolean} True when the complete `/u/` hand-off fits Version 8-L.
 */
function fitsBuiltInQr(gpxUrl) {
  const gpxUrlBytes = new TextEncoder().encode(gpxUrl).length;
  const base64UrlBytes = Math.ceil((gpxUrlBytes * 8) / 6);
  return (
    SWISSTOPO_IMPORT_URL_PREFIX.length + base64UrlBytes <= QR_MAX_TEXT_BYTES
  );
}

/**
 * Rejects expired objects even if the scheduled cleanup has not run yet.
 *
 * @param {object} object - R2 object or listing entry with custom metadata.
 * @returns {boolean} True when expiry is reached, absent, or not parseable.
 */
function isExpired(object) {
  const expiresAt = object.customMetadata?.expiresAt;
  const timestamp = expiresAt ? Date.parse(expiresAt) : Number.NaN;

  // A temporary object without trustworthy expiry metadata must never become
  // permanent merely because metadata is absent or malformed.
  return !Number.isFinite(timestamp) || timestamp <= Date.now();
}

/**
 * Stores one explicit user-requested GPX under an unguessable temporary key.
 * Size and shallow GPX checks keep the endpoint focused on route transfer rather
 * than general-purpose object hosting.
 *
 * @param {Request} request - Browser upload request containing the GPX bytes.
 * @param {object} env - Worker bindings and configuration variables.
 * @param {string|null} corsOrigin - Validated browser origin for the response.
 * @returns {Promise<Response>} Upload result containing the public URL and expiry.
 */
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

  let gpxUrl;

  try {
    gpxUrl = publicGpxUrl(request, env, key);
  } catch {
    return jsonError('Public GPX URL configuration is invalid.', 500, corsOrigin);
  }

  if (!fitsBuiltInQr(gpxUrl)) {
    return jsonError(
      'Public GPX URL is too long for the built-in QR encoder.',
      500,
      corsOrigin,
    );
  }

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
        gpxUrl,
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

/**
 * Serves one temporary GPX publicly because swisstopo must fetch it by URL.
 * Expiration is checked on every read so an object cannot remain usable merely
 * because the scheduled cleanup has not run yet.
 *
 * @param {Request} request - Public GET or HEAD request from a client.
 * @param {object} env - Worker bindings containing the GPX R2 bucket.
 * @param {string} key - Full R2 object key below the temporary share prefix.
 * @returns {Promise<Response>} GPX response, or 404/410 when unavailable.
 */
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
  headers.set('Content-Disposition', 'attachment; filename="route.gpx"');
  headers.set('Cache-Control', 'private, no-store');
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Content-Security-Policy', "sandbox; default-src 'none'");
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');

  if (request.method === 'HEAD') {
    return new Response(null, { headers });
  }

  return new Response(object.body, { headers });
}

/**
 * Deletes expired share objects in bounded R2 list batches.
 * Pagination keeps cleanup independent from the number of shares accumulated
 * between scheduled runs.
 *
 * @param {object} env - Worker bindings containing the GPX R2 bucket.
 * @returns {Promise<void>} Resolves after every expired object has been deleted.
 */
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

      if (!(await isUploadAllowedByRateLimit(request, env))) {
        return jsonError('Too many GPX share requests.', 429, corsOrigin);
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
    ctx.waitUntil(
      deleteExpiredShares(env).catch((error) => {
        console.error('Unable to clean expired swisstopo GPX shares.', error);
      }),
    );
  },
};

export {
  isExpired,
  isPlausibleGpx,
  shareTtlSeconds,
};
