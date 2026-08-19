/**
 * Business context: downloads the official FOT public-transport stop source used
 * by the offline catalog pipeline. GeoAdmin STAC is used for asset discovery so
 * maintenance does not depend on copying a mutable download URL from a browser.
 * The untouched ZIP and extracted CSV files remain outside the repository and
 * are later fingerprinted by the catalog generator.
 */
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const COLLECTION_ID = 'ch.bav.haltestellen-oev';
const STAC_COLLECTION_URL = `https://data.geo.admin.ch/api/stac/v1/collections/${COLLECTION_ID}`;
const REQUIRED_ASSET_HOST = 'data.geo.admin.ch';
const TARGET_EPSG = 2056;
const TARGET_LANGUAGE = 'fr';
const SOURCE_ARCHIVE_NAME = 'haltestellen-oev_2056_fr.csv.zip';
const EXTRACTED_DIRECTORY_NAME = 'extracted';
const REQUIRED_TABLE_NAME = 'PointExploitation.csv';

function parseArguments(argv) {
  const args = argv.slice(2);
  let outputDirectory = null;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith('--') && outputDirectory === null) {
      outputDirectory = path.resolve(argument);
    } else {
      throw new Error(`Unexpected argument: ${argument}`);
    }
  }

  if (!outputDirectory) {
    throw new Error(
      'Usage: npm run download:public-transport-stops-source -- <output directory>',
    );
  }

  return { outputDirectory };
}

function getAssetLanguage(asset, href) {
  const explicit =
    asset?.['file:lang'] ?? asset?.lang ?? asset?.language ?? asset?.['geoadmin:lang'];
  if (typeof explicit === 'string' && explicit.trim()) {
    return explicit.trim().toLowerCase().split(/[-_]/, 1)[0];
  }

  const match = href.match(/[_-](de|fr|it|en)(?:\.|_|-)/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function getAssetEpsg(asset, href) {
  const explicit = asset?.['proj:epsg'] ?? asset?.epsg;
  if (Number.isInteger(Number(explicit))) return Number(explicit);

  const code = asset?.['proj:code'];
  if (typeof code === 'string') {
    const match = code.match(/EPSG:(\d+)/i);
    if (match) return Number(match[1]);
  }

  const match = href.match(/(?:^|[_/-])(2056)(?:[_.\/-]|$)/);
  return match ? Number(match[1]) : null;
}

function isCsvZipAsset(_asset, href) {
  // Extraction deliberately expects the complete zipped CSV export. Accepting a
  // raw CSV asset here would make STAC discovery succeed and extraction fail later.
  return href.toLowerCase().endsWith('.csv.zip');
}

/**
 * Collects STAC asset candidates while retaining enough context for diagnostics.
 * @param {unknown} document - STAC Collection, Item, or ItemCollection document.
 * @param {string} source - Human-readable document URL used in errors/logging.
 * @returns {Array<{key: string, asset: Record<string, unknown>, source: string}>}
 */
export function collectStacAssets(document, source) {
  if (!document || typeof document !== 'object') return [];

  const candidates = [];
  const addAssets = (assets, owner) => {
    if (!assets || typeof assets !== 'object') return;
    for (const [key, asset] of Object.entries(assets)) {
      if (asset && typeof asset === 'object') {
        candidates.push({ key, asset, source: owner });
      }
    }
  };

  addAssets(document.assets, source);
  if (Array.isArray(document.features)) {
    for (const feature of document.features) {
      if (!feature || typeof feature !== 'object') continue;
      addAssets(feature.assets, `${source}#${String(feature.id ?? 'item')}`);
    }
  }

  return candidates;
}

/**
 * Selects the official French LV95 CSV ZIP from STAC metadata.
 * Metadata is preferred, while filename hints keep discovery compatible with
 * older GeoAdmin STAC records that predate standardized language/projection
 * fields. Ambiguity fails loudly instead of silently changing source format.
 */
export function selectOfficialCsvAsset(candidates) {
  const matches = candidates
    .map((candidate) => {
      const rawHref = candidate.asset?.href;
      if (typeof rawHref !== 'string') return null;

      let href;
      try {
        // Absolute STAC asset hrefs must not depend on the diagnostic `source`
        // label. Tests and callers may use labels such as "collection" or
        // "item", while real STAC documents can also expose relative hrefs.
        // Resolve against the source URL only when the href is actually relative.
        try {
          href = new URL(rawHref).href;
        } catch {
          href = new URL(rawHref, candidate.source.split('#', 1)[0]).href;
        }
      } catch {
        return null;
      }

      const epsg = getAssetEpsg(candidate.asset, href);
      const language = getAssetLanguage(candidate.asset, href);
      if (
        !isCsvZipAsset(candidate.asset, href) ||
        epsg !== TARGET_EPSG ||
        language !== TARGET_LANGUAGE
      ) {
        return null;
      }

      return { ...candidate, href };
    })
    .filter(Boolean);

  if (matches.length === 0) {
    throw new Error(
      `GeoAdmin STAC does not expose a French EPSG:${TARGET_EPSG} CSV ZIP for ${COLLECTION_ID}.`,
    );
  }

  const uniqueByHref = new Map(matches.map((match) => [match.href, match]));
  if (uniqueByHref.size !== 1) {
    throw new Error(
      `GeoAdmin STAC returned multiple French EPSG:${TARGET_EPSG} CSV ZIP assets: ${[
        ...uniqueByHref.keys(),
      ].join(' | ')}`,
    );
  }

  return [...uniqueByHref.values()][0];
}

function findLink(document, relation, baseUrl) {
  if (!Array.isArray(document?.links)) return null;
  const link = document.links.find(
    (candidate) => candidate?.rel === relation && typeof candidate?.href === 'string',
  );
  if (!link) return null;
  return new URL(link.href, baseUrl).href;
}

async function fetchJson(url, fetchImplementation) {
  const response = await fetchImplementation(url, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`GeoAdmin STAC request failed (${response.status}) for ${url}.`);
  }
  return response.json();
}

/**
 * Discovers the current source asset through STAC v1.
 * Collection-level assets are supported first; item pagination is followed when
 * the publisher exposes download assets on Items instead.
 */
export async function discoverOfficialCsvAsset(fetchImplementation = fetch) {
  const collection = await fetchJson(STAC_COLLECTION_URL, fetchImplementation);
  const candidates = collectStacAssets(collection, STAC_COLLECTION_URL);

  try {
    return selectOfficialCsvAsset(candidates);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('GeoAdmin STAC does not expose')) {
      throw error;
    }
  }

  let itemsUrl =
    findLink(collection, 'items', STAC_COLLECTION_URL) ??
    `${STAC_COLLECTION_URL}/items?limit=100`;
  const visited = new Set();

  while (itemsUrl && !visited.has(itemsUrl)) {
    visited.add(itemsUrl);
    const itemCollection = await fetchJson(itemsUrl, fetchImplementation);
    candidates.push(...collectStacAssets(itemCollection, itemsUrl));

    try {
      return selectOfficialCsvAsset(candidates);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('GeoAdmin STAC does not expose')) {
        throw error;
      }
    }

    itemsUrl = findLink(itemCollection, 'next', itemsUrl);
  }

  return selectOfficialCsvAsset(candidates);
}

function validateAssetUrl(href) {
  const url = new URL(href);
  if (url.protocol !== 'https:' || url.hostname !== REQUIRED_ASSET_HOST) {
    throw new Error(
      `Refusing unexpected STAC asset host ${url.origin}; expected https://${REQUIRED_ASSET_HOST}.`,
    );
  }
  return url;
}

async function downloadAsset(url, destination, fetchImplementation = fetch) {
  const response = await fetchImplementation(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Source download failed (${response.status}) for ${url}.`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new Error('Downloaded public-transport source archive is empty.');
  }

  const temporaryDestination = `${destination}.part`;
  await writeFile(temporaryDestination, bytes);
  // Windows does not reliably replace an existing destination with rename().
  // Remove only after the new download is complete so an HTTP failure still
  // leaves the previous audited source archive intact.
  await rm(destination, { force: true });
  await rename(temporaryDestination, destination);
  return bytes.byteLength;
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim() || `${command} exited with code ${code}.`));
      }
    });
  });
}

async function extractZip(archivePath, destination) {
  const stagingDirectory = `${destination}.tmp`;
  await rm(stagingDirectory, { recursive: true, force: true });
  await mkdir(stagingDirectory, { recursive: true });

  try {
    try {
      await runCommand('tar', ['-xf', archivePath, '-C', stagingDirectory]);
    } catch (tarError) {
      if (process.platform !== 'win32') throw tarError;

      // Modern Windows ships bsdtar, but Expand-Archive is a safe fallback on
      // machines where tar is missing from PATH. Extraction is staged first so
      // an interruption cannot leave the previously complete source half replaced.
      const escapedArchive = archivePath.replaceAll("'", "''");
      const escapedDestination = stagingDirectory.replaceAll("'", "''");
      await runCommand('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath '${escapedArchive}' -DestinationPath '${escapedDestination}' -Force`,
      ]);
    }

    await rm(destination, { recursive: true, force: true });
    await rename(stagingDirectory, destination);
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function findNamedFile(directory, targetName) {
  const matches = [];
  const visit = async (current) => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(child);
      } else if (entry.isFile() && entry.name.toLowerCase() === targetName.toLowerCase()) {
        matches.push(child);
      }
    }
  };
  await visit(directory);
  return matches;
}

async function main() {
  const { outputDirectory } = parseArguments(process.argv);
  const selected = await discoverOfficialCsvAsset();
  const assetUrl = validateAssetUrl(selected.href);

  await mkdir(outputDirectory, { recursive: true });
  const archivePath = path.join(outputDirectory, SOURCE_ARCHIVE_NAME);
  const extractedDirectory = path.join(outputDirectory, EXTRACTED_DIRECTORY_NAME);

  console.log(`Discovered official source asset: ${assetUrl.href}`);
  const downloadedBytes = await downloadAsset(assetUrl, archivePath);
  console.log(
    `Downloaded ${downloadedBytes.toLocaleString('en-US')} bytes to ${archivePath}.`,
  );

  await extractZip(archivePath, extractedDirectory);
  const pointExploitationFiles = await findNamedFile(
    extractedDirectory,
    REQUIRED_TABLE_NAME,
  );
  if (pointExploitationFiles.length !== 1) {
    throw new Error(
      `Expected exactly one ${REQUIRED_TABLE_NAME} after extraction, found ${pointExploitationFiles.length}.`,
    );
  }

  console.log(`Extracted official source to ${extractedDirectory}.`);
  console.log(`PointExploitation.csv: ${pointExploitationFiles[0]}`);
  console.log('Next step:');
  console.log(
    `npm run prepare:public-transport-stops-release -- "${extractedDirectory}" --release-root <release-root>`,
  );
}

const invokedScript = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedScript === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
