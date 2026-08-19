/**
 * Business context: verifies one immutable public-transport stop release through
 * its public URL after object-storage publication. It checks provenance identity,
 * CORS/cache/content metadata, Brotli transport decoding, and the SHA-256 of the
 * browser-visible JSON bytes against the locally prepared release manifest.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Public CORS origin must be a valid HTTP(S) origin.');
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('Public CORS origin must be an HTTP(S) origin without path, query, or fragment.');
  }
  return parsed.origin;
}

function parseArguments(argv) {
  const args = argv.slice(2);
  const options = { baseUrl: '', source: '', origin: '' };
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!value) throw new Error(`Missing value after ${name}.`);
    if (name === '--base-url') options.baseUrl = value.replace(/\/+$/, '');
    else if (name === '--source') options.source = path.resolve(value);
    else if (name === '--origin') options.origin = normalizeOrigin(value);
    else throw new Error(`Unknown option: ${name}`);
  }
  if (!options.baseUrl || !options.source || !options.origin) {
    throw new Error(
      'Usage: node scripts/verify-published-public-transport-stops.mjs --base-url <url> --source <release-directory> --origin <origin>',
    );
  }
  return options;
}

function assertCors(response, origin, label) {
  const allowed = response.headers.get('access-control-allow-origin');
  if (allowed !== '*' && allowed !== origin) {
    throw new Error(`${label} does not expose a compatible CORS header.`);
  }
}

function assertImmutableJsonHeaders(response, origin, label, { brotli = false } = {}) {
  assertCors(response, origin, label);
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new Error(`${label} is not served as application/json.`);
  }
  const cacheControl = response.headers.get('cache-control') ?? '';
  const normalizedCacheControl = cacheControl.toLowerCase();
  if (
    !normalizedCacheControl.includes('max-age=31536000') ||
    !normalizedCacheControl.includes('immutable')
  ) {
    throw new Error(`${label} has incomplete immutable cache metadata.`);
  }
  if (brotli) {
    const contentEncoding = response.headers.get('content-encoding') ?? '';
    if (!contentEncoding.toLowerCase().split(',').map((value) => value.trim()).includes('br')) {
      throw new Error(`${label} is not served with Content-Encoding: br.`);
    }
  }
}

async function fetchChecked(url, origin, label) {
  const delays = [0, 1_000, 2_000, 4_000];
  let lastError = null;
  for (const delay of delays) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      const response = await fetch(url, {
        headers: { Origin: origin, 'Accept-Encoding': 'br' },
      });
      if (response.ok) return response;
      lastError = new Error(`${label} request failed (${response.status}).`);
      if (![404, 408, 429].includes(response.status) && response.status < 500) break;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error(`${label} request failed.`);
}

function assertManifestShape(manifest) {
  if (
    manifest?.version !== 1 ||
    typeof manifest.datasetId !== 'string' ||
    typeof manifest.formatId !== 'string' ||
    manifest.scope !== 'ch' ||
    manifest.object !== 'stops.json' ||
    typeof manifest.sourceRelease !== 'string' ||
    typeof manifest.sourceSha256 !== 'string' ||
    typeof manifest.catalogSha256 !== 'string' ||
    !Number.isInteger(manifest.recordCount) ||
    manifest.recordCount < 0
  ) {
    throw new Error('Local public-transport release manifest is incompatible.');
  }
}

async function main() {
  const options = parseArguments(process.argv);
  const localManifest = JSON.parse(
    await readFile(path.join(options.source, 'release.json'), 'utf8'),
  );
  assertManifestShape(localManifest);

  const releaseResponse = await fetchChecked(
    `${options.baseUrl}/release.json`,
    options.origin,
    'release.json',
  );
  assertImmutableJsonHeaders(releaseResponse, options.origin, 'release.json');
  const publicManifest = await releaseResponse.json();
  assertManifestShape(publicManifest);

  const identityFields = [
    'datasetId',
    'formatId',
    'scope',
    'object',
    'source',
    'sourceRelease',
    'sourceFile',
    'sourceSha256',
    'sourceByteLength',
    'recordCount',
    'catalogSha256',
    'catalogByteLength',
    'brotliByteLength',
  ];
  for (const field of identityFields) {
    if (publicManifest[field] !== localManifest[field]) {
      throw new Error(`Public release manifest differs for ${field}.`);
    }
  }

  const catalogResponse = await fetchChecked(
    `${options.baseUrl}/${localManifest.object}`,
    options.origin,
    localManifest.object,
  );
  assertImmutableJsonHeaders(catalogResponse, options.origin, localManifest.object, {
    brotli: true,
  });
  const catalogBytes = Buffer.from(await catalogResponse.arrayBuffer());
  if (catalogBytes.byteLength !== localManifest.catalogByteLength) {
    throw new Error('Public catalog decoded byte length differs from the local release.');
  }
  if (sha256(catalogBytes) !== localManifest.catalogSha256) {
    throw new Error('Public catalog decoded SHA-256 differs from the local release.');
  }

  const catalog = JSON.parse(catalogBytes.toString('utf8'));
  if (
    catalog.sourceRelease !== localManifest.sourceRelease ||
    catalog.sourceSha256 !== localManifest.sourceSha256 ||
    catalog.recordCount !== localManifest.recordCount ||
    !Array.isArray(catalog.records) ||
    catalog.records.length !== localManifest.recordCount
  ) {
    throw new Error('Public catalog provenance does not match the release manifest.');
  }

  console.log(
    `Verified ${options.baseUrl}: ${localManifest.recordCount.toLocaleString('en-US')} stops, Brotli transport, immutable cache, CORS, and SHA-256.`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
