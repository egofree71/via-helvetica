/**
 * Business context: verifies one locally prepared public-transport stop release
 * before any immutable R2 upload. Verification deliberately re-checks basic
 * catalog plausibility after Brotli decoding so a generator defect cannot merely
 * certify its own output.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync } from 'node:zlib';

const MIN_EXPECTED_RECORD_COUNT = 20_000;
const DIDOK_SERVICE_NUMBER_PATTERN = /^\d{7}$/;
const PLAUSIBLE_LV95_EXTENT = [2_400_000, 1_000_000, 2_900_000, 1_400_000];
const SOURCE_TABLE_NAME = 'PointExploitation.csv';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseArguments(argv) {
  const args = argv.slice(2);
  if (args.length !== 2 || args[0] !== '--source' || !args[1]) {
    throw new Error(
      'Usage: node scripts/verify-public-transport-stops-release.mjs --source <release-directory>',
    );
  }
  return { source: path.resolve(args[1]) };
}

function assertManifestShape(manifest) {
  if (
    manifest?.version !== 1 ||
    !/^public-transport-stops-sha256-[0-9a-f]{16}$/.test(manifest.datasetId) ||
    manifest.formatId !== 'format-v3' ||
    manifest.scope !== 'ch' ||
    manifest.object !== 'stops.json' ||
    manifest.source !== 'ch.bav.haltestellen-oev' ||
    !/^sha256-[0-9a-f]{16}$/.test(manifest.sourceRelease) ||
    manifest.sourceFile !== SOURCE_TABLE_NAME ||
    !/^[0-9a-f]{64}$/.test(manifest.sourceSha256) ||
    !Number.isInteger(manifest.sourceByteLength) ||
    manifest.sourceByteLength <= 0 ||
    !Number.isInteger(manifest.recordCount) ||
    manifest.recordCount < 0 ||
    !/^[0-9a-f]{64}$/.test(manifest.catalogSha256) ||
    !Number.isInteger(manifest.catalogByteLength) ||
    manifest.catalogByteLength <= 0 ||
    !Number.isInteger(manifest.brotliByteLength) ||
    manifest.brotliByteLength <= 0
  ) {
    throw new Error('Local public-transport release manifest is incompatible.');
  }
  if (manifest.datasetId !== `public-transport-stops-${manifest.sourceRelease}`) {
    throw new Error('Release datasetId does not match sourceRelease.');
  }
  if (manifest.sourceRelease !== `sha256-${manifest.sourceSha256.slice(0, 16)}`) {
    throw new Error('Release sourceRelease does not match the source SHA-256.');
  }
}

/** Returns independent artifact-level plausibility failures. */
export function validateCatalogPlausibility(catalog) {
  const errors = [];
  if (!Array.isArray(catalog?.meansOfTransport) || catalog.meansOfTransport.length === 0) {
    errors.push('transport dictionary is empty');
  }
  if (!Array.isArray(catalog?.stopTypes) || catalog.stopTypes.length === 0) {
    errors.push('stop-type dictionary is empty');
  }
  if (!Array.isArray(catalog?.records)) {
    return [...errors, 'records are missing'];
  }
  if (catalog.records.length < MIN_EXPECTED_RECORD_COUNT) {
    errors.push(`only ${catalog.records.length.toLocaleString('en-US')} records are present`);
  }

  const [minEast, minNorth, maxEast, maxNorth] = PLAUSIBLE_LV95_EXTENT;
  for (let index = 0; index < catalog.records.length; index += 1) {
    const record = catalog.records[index];
    if (!Array.isArray(record) || record.length !== 6) {
      errors.push(`record ${index} has an incompatible tuple shape`);
      break;
    }
    const [id, name, transportIndex, stopTypeIndex, east, north] = record;
    if (!DIDOK_SERVICE_NUMBER_PATTERN.test(id)) {
      errors.push(`record ${index} has an invalid DiDok identifier`);
      break;
    }
    if (typeof name !== 'string' || name.includes('\uFFFD')) {
      errors.push(`record ${index} has an invalid stop name`);
      break;
    }
    if (
      !Number.isInteger(transportIndex) ||
      transportIndex < 0 ||
      transportIndex >= catalog.meansOfTransport.length ||
      !Number.isInteger(stopTypeIndex) ||
      stopTypeIndex < 0 ||
      stopTypeIndex >= catalog.stopTypes.length
    ) {
      errors.push(`record ${index} references an invalid dictionary index`);
      break;
    }
    if (
      !Number.isFinite(east) || !Number.isFinite(north) ||
      east < minEast || east > maxEast || north < minNorth || north > maxNorth
    ) {
      errors.push(`record ${index} has implausible LV95 coordinates`);
      break;
    }
  }

  if (catalog.meansOfTransport.some((value) => typeof value !== 'string' || value.includes('\uFFFD'))) {
    errors.push('transport dictionary contains invalid text');
  }
  if (catalog.stopTypes.some((value) => typeof value !== 'string' || value.includes('\uFFFD'))) {
    errors.push('stop-type dictionary contains invalid text');
  }
  return errors;
}

async function main() {
  const { source } = parseArguments(process.argv);
  const manifest = JSON.parse(await readFile(path.join(source, 'release.json'), 'utf8'));
  assertManifestShape(manifest);

  const compressedBytes = await readFile(path.join(source, `${manifest.object}.br`));
  if (compressedBytes.byteLength !== manifest.brotliByteLength) {
    throw new Error('Brotli catalog byte length differs from release.json.');
  }

  const decodedBytes = brotliDecompressSync(compressedBytes);
  if (decodedBytes.byteLength !== manifest.catalogByteLength) {
    throw new Error('Decoded catalog byte length differs from release.json.');
  }
  if (sha256(decodedBytes) !== manifest.catalogSha256) {
    throw new Error('Decoded catalog SHA-256 differs from release.json.');
  }

  const decodedText = decodedBytes.toString('utf8');
  if (decodedText.includes('\uFFFD')) {
    throw new Error('Prepared catalog contains Unicode replacement characters.');
  }
  const catalog = JSON.parse(decodedText);
  if (
    catalog.version !== 3 ||
    catalog.source !== manifest.source ||
    catalog.sourceRelease !== manifest.sourceRelease ||
    catalog.sourceFile !== manifest.sourceFile ||
    catalog.sourceSha256 !== manifest.sourceSha256 ||
    catalog.sourceByteLength !== manifest.sourceByteLength ||
    catalog.recordCount !== manifest.recordCount ||
    !Array.isArray(catalog.records) ||
    catalog.records.length !== manifest.recordCount
  ) {
    throw new Error('Prepared catalog provenance does not match release.json.');
  }

  const plausibilityErrors = validateCatalogPlausibility(catalog);
  if (plausibilityErrors.length > 0) {
    throw new Error(`Prepared catalog failed plausibility checks: ${plausibilityErrors.join('; ')}.`);
  }

  console.log(
    `Verified local release ${manifest.datasetId}/${manifest.formatId}/${manifest.scope}: ${manifest.recordCount.toLocaleString('en-US')} records, plausibility checks, and Brotli round trip.`,
  );
}

const invokedScript = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedScript === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
