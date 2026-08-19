/**
 * Business context: verifies one locally prepared public-transport stop release
 * before any immutable R2 upload. It proves that decoded JSON, Brotli bytes,
 * provenance metadata, record counts, byte lengths, and SHA-256 inventory agree
 * so publication never exposes a manifest for locally inconsistent artifacts.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { brotliDecompressSync } from 'node:zlib';

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
    typeof manifest.sourceFile !== 'string' ||
    manifest.sourceFile.trim() === '' ||
    !/^[0-9a-f]{64}$/.test(manifest.sourceSha256) ||
    !Number.isInteger(manifest.sourceByteLength) ||
    manifest.sourceByteLength <= 0 ||
    typeof manifest.generatedAt !== 'string' ||
    !Number.isFinite(Date.parse(manifest.generatedAt)) ||
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

async function main() {
  const { source } = parseArguments(process.argv);
  const manifest = JSON.parse(await readFile(path.join(source, 'release.json'), 'utf8'));
  assertManifestShape(manifest);

  const rawBytes = await readFile(path.join(source, manifest.object));
  const compressedBytes = await readFile(path.join(source, `${manifest.object}.br`));
  if (rawBytes.byteLength !== manifest.catalogByteLength) {
    throw new Error('Decoded catalog byte length differs from release.json.');
  }
  if (compressedBytes.byteLength !== manifest.brotliByteLength) {
    throw new Error('Brotli catalog byte length differs from release.json.');
  }
  if (sha256(rawBytes) !== manifest.catalogSha256) {
    throw new Error('Decoded catalog SHA-256 differs from release.json.');
  }
  const decodedBrotli = brotliDecompressSync(compressedBytes);
  if (!decodedBrotli.equals(rawBytes)) {
    throw new Error('Brotli catalog does not decode to the prepared JSON bytes.');
  }

  const catalog = JSON.parse(rawBytes.toString('utf8'));
  if (
    catalog.version !== 3 ||
    catalog.source !== manifest.source ||
    catalog.sourceRelease !== manifest.sourceRelease ||
    catalog.sourceFile !== manifest.sourceFile ||
    catalog.sourceSha256 !== manifest.sourceSha256 ||
    catalog.sourceByteLength !== manifest.sourceByteLength ||
    catalog.generatedAt !== manifest.generatedAt ||
    catalog.recordCount !== manifest.recordCount ||
    !Array.isArray(catalog.records) ||
    catalog.records.length !== manifest.recordCount
  ) {
    throw new Error('Prepared catalog provenance does not match release.json.');
  }

  console.log(
    `Verified local release ${manifest.datasetId}/${manifest.formatId}/${manifest.scope}: ${manifest.recordCount.toLocaleString('en-US')} records and Brotli round trip.`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
