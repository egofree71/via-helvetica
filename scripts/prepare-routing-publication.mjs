/**
 * Business context: creates the small metadata view published beside Brotli
 * routing objects. Local releases retain both raw and compressed files for
 * verification; R2 serves only `.bin.br` objects with HTTP Content-Encoding so
 * browsers receive decoded v3 bytes through the standard Fetch API.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

function parseOptions(argv) {
  const options = { source: null, output: null, expectedCellCount: null };
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!value) {
      throw new Error(`Missing value for ${name}.`);
    }
    if (name === '--source') {
      options.source = resolve(value);
    } else if (name === '--output') {
      options.output = resolve(value);
    } else if (name === '--expected-cell-count') {
      options.expectedCellCount = Number(value);
    } else {
      throw new Error(`Unknown option: ${name}`);
    }
  }

  if (
    !options.source ||
    !options.output ||
    !Number.isInteger(options.expectedCellCount) ||
    options.expectedCellCount <= 0
  ) {
    throw new Error(
      'Usage: node prepare-routing-publication.mjs --source <dataset> ' +
        '--output <directory> --expected-cell-count <count>',
    );
  }
  return options;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const [manifest, integrity] = await Promise.all([
    readJson(join(options.source, 'manifest.json')),
    readJson(join(options.source, 'integrity.json')),
  ]);

  if (
    manifest.version !== 3 ||
    manifest.auditSubset === true ||
    manifest.nonEmptyCellCount !== options.expectedCellCount ||
    !Array.isArray(manifest.nonEmptyCellKeys) ||
    manifest.nonEmptyCellKeys.length !== options.expectedCellCount ||
    typeof manifest.datasetBuildId !== 'string' ||
    !/^[0-9a-f]{64}$/.test(manifest.datasetBuildId)
  ) {
    throw new Error(
      'Publication requires a complete v3 release with the expected cell count.',
    );
  }
  if (!Array.isArray(integrity.files)) {
    throw new Error('Local integrity inventory is missing or incompatible.');
  }

  const compressedFiles = integrity.files.filter(
    (entry) => typeof entry?.path === 'string' && entry.path.endsWith('.bin.br'),
  );
  if (compressedFiles.length !== options.expectedCellCount) {
    throw new Error('Compressed publication inventory is incomplete.');
  }

  const publishedManifest = {
    ...manifest,
    cellPathTemplate: 'cells/{column}_{row}.bin.br',
    deliveryEncoding: 'br',
    publishedCellBytes: manifest.brotliCellBytes,
    publishedFileCount: compressedFiles.length,
  };
  const publishedIntegrity = {
    version: integrity.version,
    algorithm: integrity.algorithm,
    datasetManifest: 'manifest.json',
    datasetBuildId: manifest.datasetBuildId,
    nonEmptyCellCount: manifest.nonEmptyCellCount,
    fileCount: compressedFiles.length,
    deliveryEncoding: 'br',
    files: compressedFiles,
  };

  await rm(options.output, { recursive: true, force: true });
  await mkdir(options.output, { recursive: true });
  await Promise.all([
    writeFile(
      join(options.output, 'manifest.json'),
      `${JSON.stringify(publishedManifest, null, 2)}\n`,
    ),
    writeFile(
      join(options.output, 'integrity.json'),
      `${JSON.stringify(publishedIntegrity, null, 2)}\n`,
    ),
  ]);

  console.log(
    `Prepared publication metadata for ${compressedFiles.length} Brotli cells ` +
      `(${manifest.datasetBuildId}).`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
