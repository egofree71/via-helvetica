/**
 * Business context: validates a routing release through its public URL after
 * R2 publication. It checks manifest identity, HTTP metadata, optional CORS,
 * and an evenly distributed sample whose transport-decoded bytes must match
 * the local raw-cell SHA-256 inventory.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  extractRoutingDataConfigArgument,
  loadRoutingDataConfig,
} from './lib/routing-data-config.mjs';

/** Resolves public-verification inputs from CLI overrides or local config. */
async function parseOptions(argv) {
  const {
    configPath,
    configWasExplicit,
    argv: remainingArguments,
  } = extractRoutingDataConfigArgument(argv);
  const overrides = {
    baseUrl: null,
    source: null,
    sampleCount: null,
    origin: null,
  };

  for (let index = 0; index < remainingArguments.length; index += 1) {
    const name = remainingArguments[index];
    const value = remainingArguments[index + 1];
    if (name === '--base-url' && value) {
      overrides.baseUrl = value.replace(/\/+$/, '');
    } else if (name === '--source' && value) {
      overrides.source = resolve(value);
    } else if (name === '--sample-count' && value) {
      overrides.sampleCount = Number(value);
    } else if (name === '--origin' && value) {
      overrides.origin = value;
    } else {
      throw new Error(`Unknown or incomplete option: ${name}`);
    }
    index += 1;
  }

  const config = await loadRoutingDataConfig(configPath, {
    optional:
      !configWasExplicit &&
      overrides.baseUrl !== null &&
      overrides.source !== null,
  });
  const publication = config.publication ?? {};
  const options = {
    baseUrl: overrides.baseUrl ?? publication.publicBaseUrl ?? null,
    source: overrides.source ?? config.binaryReleaseRoot ?? null,
    sampleCount:
      overrides.sampleCount ?? publication.publicSampleCount ?? 50,
    origin: overrides.origin ?? publication.publicOrigin ?? null,
  };

  if (
    typeof options.baseUrl !== 'string' ||
    options.baseUrl.trim() === '' ||
    typeof options.source !== 'string' ||
    options.source.trim() === '' ||
    !Number.isInteger(options.sampleCount) ||
    options.sampleCount <= 0 ||
    (options.origin !== null &&
      (typeof options.origin !== 'string' || options.origin.trim() === ''))
  ) {
    throw new Error(
      'Configure datasetId, formatId, scope, dataRoot, and publication.publicRootUrl, or use ' +
        '--base-url <url> --source <dataset> [--sample-count <count>] [--origin <origin>].',
    );
  }

  return {
    ...options,
    baseUrl: options.baseUrl.replace(/\/+$/, ''),
    source: resolve(options.source),
    origin: options.origin?.trim() || null,
  };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function rawPathForKey(key) {
  const [column, row] = key.split(':');
  return `cells/${column}_${row}.bin`;
}

function selectedKeys(keys, count) {
  const selected = [];
  const actualCount = Math.min(count, keys.length);
  for (let index = 0; index < actualCount; index += 1) {
    const sourceIndex = Math.floor(
      (index * (keys.length - 1)) / Math.max(1, actualCount - 1),
    );
    selected.push(keys[sourceIndex]);
  }
  return [...new Set(selected)];
}

function assertCors(response, origin, label) {
  if (!origin) {
    return;
  }
  const allowed = response.headers.get('access-control-allow-origin');
  if (allowed !== '*' && allowed !== origin) {
    throw new Error(`${label} does not expose a compatible CORS header.`);
  }
}

function requestHeaders(origin) {
  return origin ? { Origin: origin } : undefined;
}

/** Waits before retrying a transient public-object-storage response. */
function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

/**
 * Fetches one immutable publication object with bounded retries.
 * The r2.dev endpoint can briefly return 404, 429, or 5xx immediately after a
 * release, even though the uploaded object and its checksum are already valid.
 */
async function fetchWithRetry(url, init, label) {
  const delays = [0, 1_000, 2_000, 4_000];
  let lastError = null;

  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt] > 0) {
      await delay(delays[attempt]);
    }

    try {
      const response = await fetch(url, init);
      if (
        response.ok ||
        (![404, 408, 429].includes(response.status) &&
          response.status < 500)
      ) {
        return response;
      }
      lastError = new Error(`${label} request failed (${response.status}).`);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`${label} remained unavailable after retries: ${lastError}`);
}

function assertImmutableJsonHeaders(response, label) {
  const contentType = response.headers.get('content-type') ?? '';
  const cacheControl = response.headers.get('cache-control') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new Error(`${label} has an unexpected Content-Type.`);
  }
  if (
    !cacheControl.toLowerCase().includes('immutable') ||
    !cacheControl.toLowerCase().includes('max-age=31536000')
  ) {
    throw new Error(`${label} has incomplete immutable cache metadata.`);
  }
}

async function main() {
  const options = await parseOptions(process.argv.slice(2));
  const [localManifest, localIntegrity] = await Promise.all([
    readJson(join(options.source, 'manifest.json')),
    readJson(join(options.source, 'integrity.json')),
  ]);
  const rawHashes = new Map(
    localIntegrity.files
      .filter((entry) => entry.path.endsWith('.bin'))
      .map((entry) => [entry.path, entry.sha256]),
  );

  const manifestResponse = await fetchWithRetry(
    `${options.baseUrl}/manifest.json`,
    {
      cache: 'no-store',
      headers: requestHeaders(options.origin),
    },
    'Public manifest',
  );
  if (!manifestResponse.ok) {
    throw new Error(`Public manifest request failed (${manifestResponse.status}).`);
  }
  assertCors(manifestResponse, options.origin, 'Public manifest');
  assertImmutableJsonHeaders(manifestResponse, 'Public manifest');
  const publicManifest = await manifestResponse.json();
  if (
    publicManifest.version !== 3 ||
    publicManifest.datasetBuildId !== localManifest.datasetBuildId ||
    publicManifest.nonEmptyCellCount !== localManifest.nonEmptyCellCount ||
    publicManifest.cellPathTemplate !== 'cells/{column}_{row}.bin.br' ||
    publicManifest.deliveryEncoding !== 'br'
  ) {
    throw new Error('Public manifest does not match the local v3 release.');
  }

  const integrityResponse = await fetchWithRetry(
    `${options.baseUrl}/integrity.json`,
    {
      cache: 'no-store',
      headers: requestHeaders(options.origin),
    },
    'Public integrity inventory',
  );
  if (!integrityResponse.ok) {
    throw new Error(
      `Public integrity inventory request failed (${integrityResponse.status}).`,
    );
  }
  assertCors(integrityResponse, options.origin, 'Public integrity inventory');
  assertImmutableJsonHeaders(
    integrityResponse,
    'Public integrity inventory',
  );
  const publicIntegrity = await integrityResponse.json();
  const localCompressedFiles = localIntegrity.files
    .filter((entry) => entry.path.endsWith('.bin.br'))
    .map((entry) => ({
      path: entry.path,
      sizeBytes: entry.sizeBytes,
      sha256: entry.sha256,
    }));
  if (
    publicIntegrity.version !== 1 ||
    publicIntegrity.algorithm !== 'sha256' ||
    publicIntegrity.datasetBuildId !== localManifest.datasetBuildId ||
    publicIntegrity.nonEmptyCellCount !== localManifest.nonEmptyCellCount ||
    publicIntegrity.fileCount !== localCompressedFiles.length ||
    publicIntegrity.deliveryEncoding !== 'br' ||
    JSON.stringify(publicIntegrity.files) !== JSON.stringify(localCompressedFiles)
  ) {
    throw new Error(
      'Public integrity inventory does not match the local compressed release.',
    );
  }

  const keys = selectedKeys(localManifest.nonEmptyCellKeys, options.sampleCount);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const rawPath = rawPathForKey(key);
    const remotePath = `${rawPath}.br`;
    const response = await fetchWithRetry(
      `${options.baseUrl}/${remotePath}`,
      {
        cache: 'no-store',
        headers: requestHeaders(options.origin),
      },
      remotePath,
    );
    if (!response.ok) {
      throw new Error(`${remotePath} request failed (${response.status}).`);
    }
    assertCors(response, options.origin, remotePath);

    const contentEncoding = response.headers.get('content-encoding') ?? '';
    const contentType = response.headers.get('content-type') ?? '';
    const cacheControl = response.headers.get('cache-control') ?? '';
    if (!contentEncoding.toLowerCase().includes('br')) {
      throw new Error(`${remotePath} is missing Content-Encoding: br.`);
    }
    if (!contentType.toLowerCase().includes('application/octet-stream')) {
      throw new Error(`${remotePath} has an unexpected Content-Type.`);
    }
    if (
      !cacheControl.toLowerCase().includes('immutable') ||
      !cacheControl.toLowerCase().includes('max-age=31536000')
    ) {
      throw new Error(`${remotePath} has incomplete immutable cache metadata.`);
    }

    const decoded = Buffer.from(await response.arrayBuffer());
    if (sha256(decoded) !== rawHashes.get(rawPath)) {
      throw new Error(`${remotePath} does not decode to the local raw cell.`);
    }
    if ((index + 1) % 10 === 0 || index + 1 === keys.length) {
      console.log(`Verified ${index + 1}/${keys.length} public routing cells...`);
    }
  }

  console.log(
    `Public routing release ${localManifest.datasetBuildId} passed ` +
      `${keys.length} transport and integrity checks.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
