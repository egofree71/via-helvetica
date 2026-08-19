/**
 * Business context: prepares the browser-readable public-transport stop catalog
 * from the manually downloaded and extracted FOT GeoAdmin CSV asset. The same
 * validated conversion supports local development and immutable R2 releases.
 * Local mode writes readable JSON for Vite; release mode writes only the Brotli
 * transport representation plus provenance, avoiding a redundant decoded copy.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIRECTORY, '..');
const DEFAULT_OUTPUT = path.join(
  PROJECT_ROOT,
  'public',
  'local-data',
  'public-transport-stops.json',
);

/** Source collection kept in the artifact for traceability. */
const SOURCE_DATASET_ID = 'ch.bav.haltestellen-oev';

/** Current compact artifact schema understood by the browser-side loader. */
const OUTPUT_FORMAT_VERSION = 3;

/** Publication scope used in immutable release paths. */
const OUTPUT_SCOPE = 'ch';

/** Short source fingerprint length used in human-readable immutable paths. */
const SOURCE_RELEASE_HASH_LENGTH = 16;

/** Publication manifest schema kept separate from the browser catalog schema. */
const RELEASE_MANIFEST_VERSION = 1;

/** Canonical official table name; it is part of the immutable provenance contract. */
const SOURCE_TABLE_NAME = 'PointExploitation.csv';

/** Maximum accepted annual record-count drift relative to the previous release. */
const MAX_RECORD_COUNT_CHANGE_RATIO = 0.05;

/**
 * Minimum plausible operating-point count for the national FOT publication.
 * A much smaller compatible table usually means the exporter schema changed or
 * the wrong CSV table was selected, so publication must fail rather than emit a
 * syntactically valid but incomplete national catalog.
 */
const MIN_EXPECTED_RECORD_COUNT = 20_000;

/**
 * Minimum fraction of rows carrying useful transport metadata.
 * The FOT operating-point table includes technical records, but passenger and
 * transport-bearing rows still form the majority of the national publication.
 */
const MIN_TRANSPORT_METADATA_RATIO = 0.5;

/** Official DiDok service number: two-digit UIC country code plus five digits. */
const DIDOK_SERVICE_NUMBER_PATTERN = /^\d{7}$/;

/**
 * Broad LV95 plausibility envelope in metres.
 * It deliberately includes a margin around Switzerland and nearby foreign
 * operating points while rejecting WGS84 or LV03 columns selected by mistake.
 */
const PLAUSIBLE_LV95_EXTENT = [2_400_000, 1_000_000, 2_900_000, 1_400_000];

/** Candidate delimiters used by the official CSV exporter. */
const CSV_DELIMITERS = [';', ',', '\t'];

/** Returns a stable dictionary index while preserving the provider text verbatim. */
function internString(value, indexes, values) {
  const normalized = value.trim();
  const existing = indexes.get(normalized);
  if (existing !== undefined) return existing;

  const index = values.length;
  indexes.set(normalized, index);
  values.push(normalized);
  return index;
}

/** Formats generated artifact sizes for human-readable preparation diagnostics. */
function formatBytes(bytes) {
  return `${bytes.toLocaleString('en-US')} bytes`;
}


/** Returns a lowercase SHA-256 digest used for source and artifact identity. */
function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** Derives a stable path-safe release id directly from the downloaded source bytes. */
export function createSourceReleaseId(sourceSha256) {
  if (!/^[0-9a-f]{64}$/.test(sourceSha256)) {
    throw new Error('Source SHA-256 must contain 64 lowercase hexadecimal characters.');
  }
  return `sha256-${sourceSha256.slice(0, SOURCE_RELEASE_HASH_LENGTH)}`;
}

/** Returns the immutable publication path for one source fingerprint and schema. */
export function createPublicTransportReleasePath(sourceRelease) {
  if (!/^sha256-[0-9a-f]{16}$/.test(sourceRelease)) {
    throw new Error('Invalid public-transport source release id.');
  }
  return `public-transport-stops-${sourceRelease}/format-v${OUTPUT_FORMAT_VERSION}/${OUTPUT_SCOPE}`;
}

/** Decodes the official source strictly so encoding drift cannot corrupt stop names silently. */
export function decodeOfficialCsvUtf8(sourceBytes, label = SOURCE_TABLE_NAME) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8.`);
  }
  if (text.includes('\uFFFD')) {
    throw new Error(
      `${label} contains Unicode replacement characters; check the official export before publishing.`,
    );
  }
  return text;
}

/** Protects the immutable path contract from basename-dependent artifact changes. */
export function assertCanonicalSourceFile(filePath) {
  const basename = path.basename(filePath);
  if (basename !== SOURCE_TABLE_NAME) {
    throw new Error(
      `Expected ${SOURCE_TABLE_NAME}, got ${basename}. Do not rename the official table.`,
    );
  }
}

/** Fails when an annual source changes implausibly relative to the previous release. */
export function validateRecordCountAgainstPrevious(currentCount, previousCount) {
  if (!Number.isInteger(previousCount) || previousCount <= 0) {
    throw new Error('Previous release has an invalid recordCount.');
  }
  const ratio = Math.abs(currentCount - previousCount) / previousCount;
  if (ratio > MAX_RECORD_COUNT_CHANGE_RATIO) {
    const percent = (ratio * 100).toFixed(1);
    throw new Error(
      `Record count changed by ${percent}% (${previousCount.toLocaleString('en-US')} -> ${currentCount.toLocaleString('en-US')}), above the ${(MAX_RECORD_COUNT_CHANGE_RATIO * 100).toFixed(0)}% safety threshold.`,
    );
  }
}

async function readPreviousReleaseRecordCount(releaseDirectory) {
  const manifest = JSON.parse(
    await readFile(path.join(releaseDirectory, 'release.json'), 'utf8'),
  );
  if (!Number.isInteger(manifest?.recordCount) || manifest.recordCount <= 0) {
    throw new Error(
      `Previous release manifest under ${releaseDirectory} has an invalid recordCount.`,
    );
  }
  return manifest.recordCount;
}

function normalizeText(value) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeHeader(value) {
  return normalizeText(value).replaceAll(' ', '');
}

function parseArguments(argv) {
  const args = argv.slice(2);
  let input = null;
  let output = DEFAULT_OUTPUT;
  let releaseRoot = null;
  let previousRelease = null;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--output') {
      const outputArgument = args[index + 1];
      if (!outputArgument) {
        throw new Error('Missing value after --output.');
      }
      output = path.resolve(outputArgument);
      index += 1;
    } else if (argument === '--release-root') {
      const releaseRootArgument = args[index + 1];
      if (!releaseRootArgument) {
        throw new Error('Missing value after --release-root.');
      }
      releaseRoot = path.resolve(releaseRootArgument);
      index += 1;
    } else if (argument === '--previous-release') {
      const previousReleaseArgument = args[index + 1];
      if (!previousReleaseArgument) {
        throw new Error('Missing value after --previous-release.');
      }
      previousRelease = path.resolve(previousReleaseArgument);
      index += 1;
    } else if (!argument.startsWith('--') && input === null) {
      input = argument;
    } else {
      throw new Error(`Unexpected argument: ${argument}`);
    }
  }

  if (!input) {
    throw new Error(
      'Usage: npm run prepare:public-transport-stops-local -- <extracted CSV file or directory> [--output <file> | --release-root <directory>] [--previous-release <release-directory>]',
    );
  }
  if (releaseRoot && output !== DEFAULT_OUTPUT) {
    throw new Error('--output and --release-root cannot be used together.');
  }

  return { input: path.resolve(input), output, releaseRoot, previousRelease };
}

async function collectCsvFiles(inputPath) {
  const entries = await readdir(inputPath, { withFileTypes: true }).catch(
    () => null,
  );

  if (!entries) {
    return inputPath.toLowerCase().endsWith('.csv') ? [inputPath] : [];
  }

  const files = [];
  for (const entry of entries) {
    const child = path.join(inputPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectCsvFiles(child)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.csv')) {
      files.push(child);
    }
  }
  return files;
}

function countDelimiterOutsideQuotes(line, delimiter) {
  let count = 0;
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && character === delimiter) {
      count += 1;
    }
  }

  return count;
}

function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  return CSV_DELIMITERS.reduce((best, candidate) =>
    countDelimiterOutsideQuotes(firstLine, candidate) >
    countDelimiterOutsideQuotes(firstLine, best)
      ? candidate
      : best,
  );
}

function parseCsv(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"') {
      quoted = true;
    } else if (character === delimiter) {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }

  if (field || row.length > 0) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }

  return rows;
}

function findColumn(headers, candidates, { required = true } = {}) {
  const normalizedHeaders = headers.map(normalizeHeader);
  const normalizedCandidates = candidates.map(normalizeHeader);

  for (const candidate of normalizedCandidates) {
    const exact = normalizedHeaders.findIndex((header) => header === candidate);
    if (exact >= 0) return exact;
  }

  if (!required) return -1;
  throw new Error(
    `Missing CSV column (${candidates.join(', ')}). Available headers: ${headers.join(' | ')}`,
  );
}

export function parsePointGeometry(value) {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const wkt = trimmed.match(
    /^POINT(?:\s+Z)?\s*\(\s*([+-]?[\d.]+)\s+([+-]?[\d.]+)/i,
  );
  if (wkt) {
    return [Number(wkt[1]), Number(wkt[2])];
  }

  if (trimmed.startsWith('{')) {
    try {
      const geometry = JSON.parse(trimmed);
      const coordinates = geometry?.coordinates;
      if (
        geometry?.type === 'Point' &&
        Array.isArray(coordinates) &&
        Number.isFinite(Number(coordinates[0])) &&
        Number.isFinite(Number(coordinates[1]))
      ) {
        return [Number(coordinates[0]), Number(coordinates[1])];
      }
    } catch {
      return null;
    }
  }

  // Some CSV exporters flatten an INTERLIS coordinate as plain numeric tokens
  // instead of WKT. Accepting that representation keeps the manual prototype
  // independent from exporter formatting while still requiring LV95 numbers.
  const numericTokens = trimmed.match(/[+-]?\d+(?:[.,]\d+)?/g);
  if (numericTokens && numericTokens.length >= 2) {
    const east = Number(numericTokens[0].replace(',', '.'));
    const north = Number(numericTokens[1].replace(',', '.'));
    if (Number.isFinite(east) && Number.isFinite(north)) {
      return [east, north];
    }
  }

  return null;
}

export function resolveColumns(headers) {
  const id = findColumn(headers, [
    'Betriebspunkt.Nummer',
    'Betriebspunkt_Nummer',
    'Nummer',
    'Numero',
    'Number',
  ]);
  const name = findColumn(headers, [
    'Betriebspunkt.Name',
    'Betriebspunkt_Name',
    'Name',
    'Nom',
  ]);
  const meansOfTransport = findColumn(headers, [
    'Betriebspunkt.Verkehrsmittel',
    'Betriebspunkt_Verkehrsmittel',
    'Verkehrsmittel',
    'MoyenDeTransport',
    'MoyenTransport_Designation',
    'MoyenTransport.Designation',
    'MoyenTransport',
    'MoyenTransport_Code',
    'MoyenTransport.Code',
    'MeansOfTransport',
  ]);
  const stopType = findColumn(
    headers,
    [
      'Betriebspunkt.Betriebspunkttyp',
      'Betriebspunkt_Betriebspunkttyp',
      'Betriebspunkttyp',
      'TypePointExploitation_Designation',
      'TypePointExploitation.Designation',
      'TypePointExploitation',
      'TypePointExploitation_Code',
      'TypePointExploitation.Code',
      'Type',
    ],
    { required: false },
  );
  const geometry = findColumn(
    headers,
    [
      'Betriebspunkt.Geometrie',
      'Betriebspunkt_Geometrie',
      'Geometrie',
      'Geometry',
      'Geom',
      'WKT',
    ],
    { required: false },
  );
  const east = findColumn(
    headers,
    [
      'Geometrie.E',
      'Geometrie_E',
      'Geometrie.C1',
      'Geometrie_C1',
      'GeometrieCoord1',
      'Easting',
      'East',
      'ECoord',
      'E_COORD',
      'CoordE',
      'KoordE',
      'E',
      'X',
    ],
    { required: false },
  );
  const north = findColumn(
    headers,
    [
      'Geometrie.N',
      'Geometrie_N',
      'Geometrie.C2',
      'Geometrie_C2',
      'GeometrieCoord2',
      'Northing',
      'North',
      'NCoord',
      'N_COORD',
      'CoordN',
      'KoordN',
      'N',
      'Y',
    ],
    { required: false },
  );

  if (geometry < 0 && (east < 0 || north < 0)) {
    throw new Error(
      `No supported LV95 geometry columns found. Available headers: ${headers.join(' | ')}`,
    );
  }

  return { id, name, meansOfTransport, stopType, geometry, east, north };
}

/** Returns the concrete source header selected for each semantic field. */
function describeResolvedColumns(headers, columns) {
  const headerAt = (index) => (index >= 0 ? headers[index] : '(not present)');
  return {
    id: headerAt(columns.id),
    name: headerAt(columns.name),
    meansOfTransport: headerAt(columns.meansOfTransport),
    stopType: headerAt(columns.stopType),
    geometry: headerAt(columns.geometry),
    east: headerAt(columns.east),
    north: headerAt(columns.north),
  };
}

function readCoordinate(row, columns) {
  if (columns.geometry >= 0) {
    const coordinate = parsePointGeometry(row[columns.geometry] ?? '');
    if (coordinate) return coordinate;
  }

  if (columns.east >= 0 && columns.north >= 0) {
    const east = Number((row[columns.east] ?? '').replace(',', '.'));
    const north = Number((row[columns.north] ?? '').replace(',', '.'));
    if (Number.isFinite(east) && Number.isFinite(north)) {
      return [east, north];
    }
  }

  return null;
}

function parseCandidateCsv(filePath, text) {
  const rows = parseCsv(text.replace(/^\uFEFF/, ''), detectDelimiter(text));
  if (rows.length < 2) {
    return { filePath, records: [], headers: [], rejectionReason: 'empty CSV' };
  }

  const headers = rows[0].map((header) => header.trim());
  let columns;
  try {
    columns = resolveColumns(headers);
  } catch (error) {
    return {
      filePath,
      records: [],
      headers,
      rejectionReason: error instanceof Error ? error.message : String(error),
    };
  }

  const records = [];
  for (const row of rows.slice(1)) {
    const id = (row[columns.id] ?? '').trim();
    const name = (row[columns.name] ?? '').trim();
    const coordinate = readCoordinate(row, columns);
    if (!id || !name || !coordinate) continue;

    records.push([
      id,
      name,
      columns.meansOfTransport >= 0
        ? (row[columns.meansOfTransport] ?? '').trim()
        : '',
      columns.stopType >= 0 ? (row[columns.stopType] ?? '').trim() : '',
      coordinate[0],
      coordinate[1],
    ]);
  }

  return {
    filePath,
    records,
    headers,
    columns,
    sourceRowCount: Math.max(0, rows.length - 1),
    rejectionReason: null,
  };
}

/**
 * Validates assumptions that distinguish the national operating-point table
 * from another compatible-looking CSV or a silently changed exporter schema.
 *
 * @param candidate - Parsed CSV candidate with resolved source columns.
 * @returns Human-readable failures; an empty array means publication is plausible.
 */
export function validateCandidatePlausibility(candidate) {
  const errors = [];
  const records = candidate.records;
  if (records.length < MIN_EXPECTED_RECORD_COUNT) {
    errors.push(
      `only ${records.length.toLocaleString('en-US')} usable records (expected at least ${MIN_EXPECTED_RECORD_COUNT.toLocaleString('en-US')})`,
    );
  }

  const invalidDidokCount = records.reduce(
    (count, record) => count + (DIDOK_SERVICE_NUMBER_PATTERN.test(record[0]) ? 0 : 1),
    0,
  );
  if (invalidDidokCount > 0) {
    errors.push(
      `${invalidDidokCount.toLocaleString('en-US')} records do not use a seven-digit DiDok service number`,
    );
  }

  const [minEast, minNorth, maxEast, maxNorth] = PLAUSIBLE_LV95_EXTENT;
  const implausibleCoordinateCount = records.reduce((count, record) => {
    const east = record[4];
    const north = record[5];
    return count +
      (east >= minEast && east <= maxEast && north >= minNorth && north <= maxNorth
        ? 0
        : 1);
  }, 0);
  if (implausibleCoordinateCount > 0) {
    errors.push(
      `${implausibleCoordinateCount.toLocaleString('en-US')} records fall outside the broad LV95 plausibility envelope`,
    );
  }

  const transportMetadataCount = records.reduce((count, record) => {
    const value = record[2].trim();
    return count + (value && value !== '-' ? 1 : 0);
  }, 0);
  const transportMetadataRatio =
    records.length > 0 ? transportMetadataCount / records.length : 0;
  if (transportMetadataRatio < MIN_TRANSPORT_METADATA_RATIO) {
    errors.push(
      `only ${(transportMetadataRatio * 100).toFixed(1)}% of records carry transport metadata (expected at least ${(MIN_TRANSPORT_METADATA_RATIO * 100).toFixed(0)}%)`,
    );
  }

  return errors;
}

async function main() {
  const { input, output: configuredOutput, releaseRoot, previousRelease } =
    parseArguments(process.argv);
  const csvFiles = await collectCsvFiles(input);
  if (csvFiles.length === 0) {
    throw new Error(`No CSV files found under ${input}.`);
  }
  const sourceFiles = csvFiles.filter(
    (csvFile) => path.basename(csvFile) === SOURCE_TABLE_NAME,
  );
  if (sourceFiles.length !== 1) {
    throw new Error(
      `Expected exactly one ${SOURCE_TABLE_NAME} under ${input}, found ${sourceFiles.length}. Do not rename the official table.`,
    );
  }

  const inspectedCandidates = [];
  for (const csvFile of sourceFiles) {
    const sourceBytes = await readFile(csvFile);
    inspectedCandidates.push({
      ...parseCandidateCsv(csvFile, decodeOfficialCsvUtf8(sourceBytes, csvFile)),
      sourceSha256: sha256(sourceBytes),
      sourceByteLength: sourceBytes.byteLength,
    });
  }
  const candidates = inspectedCandidates.filter(
    (candidate) => candidate.records.length > 0,
  );

  if (candidates.length === 0) {
    const diagnostics = inspectedCandidates
      .map(
        (candidate) =>
          `${candidate.filePath}: ${candidate.rejectionReason ?? 'no usable rows'}`,
      )
      .join('\n');
    throw new Error(
      `No extracted CSV matched the FOT stop schema.\n${diagnostics}`,
    );
  }

  // The canonical PointExploitation table is selected by name first; plausibility
  // checks then protect against a provider-side schema or content change.
  const plausibleCandidates = candidates
    .map((candidate) => ({
      candidate,
      plausibilityErrors: validateCandidatePlausibility(candidate),
    }))
    .filter(({ plausibilityErrors }) => plausibilityErrors.length === 0)
    .sort(
      (first, second) =>
        second.candidate.records.length - first.candidate.records.length,
    );

  if (plausibleCandidates.length === 0) {
    const diagnostics = candidates
      .map((candidate) => {
        const errors = validateCandidatePlausibility(candidate);
        return `${candidate.filePath}: ${errors.join('; ') || 'no plausibility error'}`;
      })
      .join('\n');
    throw new Error(
      `No extracted CSV passed the FOT national-catalog plausibility checks.\n${diagnostics}`,
    );
  }

  const selected = plausibleCandidates[0].candidate;
  assertCanonicalSourceFile(selected.filePath);
  const unique = new Map();
  for (const record of selected.records) unique.set(record[0], record);

  const meansOfTransport = [''];
  const meansOfTransportIndexes = new Map([['', 0]]);
  const stopTypes = [''];
  const stopTypeIndexes = new Map([['', 0]]);
  const records = [...unique.values()].map(
    ([id, name, rawMeansOfTransport, rawStopType, east, north]) => [
      id,
      name,
      internString(rawMeansOfTransport, meansOfTransportIndexes, meansOfTransport),
      internString(rawStopType, stopTypeIndexes, stopTypes),
      east,
      north,
    ],
  );
  if (previousRelease) {
    const previousRecordCount =
      await readPreviousReleaseRecordCount(previousRelease);
    validateRecordCountAgainstPrevious(records.length, previousRecordCount);
    console.log(
      `Previous release record count: ${previousRecordCount.toLocaleString('en-US')} (${records.length.toLocaleString('en-US')} now).`,
    );
  }

  const sourceRelease = createSourceReleaseId(selected.sourceSha256);
  const releasePath = createPublicTransportReleasePath(sourceRelease);
  const releaseDirectory = releaseRoot
    ? path.join(releaseRoot, ...releasePath.split('/'))
    : null;
  const output = releaseDirectory
    ? path.join(releaseDirectory, 'stops.json.br')
    : configuredOutput;
  const payload = {
    version: OUTPUT_FORMAT_VERSION,
    source: SOURCE_DATASET_ID,
    sourceRelease,
    sourceFile: SOURCE_TABLE_NAME,
    sourceSha256: selected.sourceSha256,
    sourceByteLength: selected.sourceByteLength,
    recordCount: records.length,
    meansOfTransport,
    stopTypes,
    records,
  };
  const serialized = `${JSON.stringify(payload)}
`;
  const serializedBytes = Buffer.from(serialized, 'utf8');
  const compressedBytes = brotliCompressSync(serializedBytes, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
    },
  });

  await mkdir(path.dirname(output), { recursive: true });
  if (releaseDirectory) {
    // R2 only needs the pre-compressed transport representation. Remove a raw
    // catalog left by an older local preparation so the release directory itself
    // mirrors the exact object inventory intended for immutable publication.
    await rm(path.join(releaseDirectory, 'stops.json'), { force: true });
    await writeFile(output, compressedBytes);
  } else {
    // Vite development intentionally keeps the decoded JSON directly readable.
    // A stale Brotli sibling from an older generator must not imply that local
    // development depends on special Content-Encoding metadata.
    await rm(`${output}.br`, { force: true });
    await writeFile(output, serializedBytes);
  }

  const catalogSha256 = sha256(serializedBytes);
  const releaseManifest = releaseRoot
    ? {
        version: RELEASE_MANIFEST_VERSION,
        datasetId: `public-transport-stops-${sourceRelease}`,
        formatId: `format-v${OUTPUT_FORMAT_VERSION}`,
        scope: OUTPUT_SCOPE,
        object: 'stops.json',
        source: SOURCE_DATASET_ID,
        sourceRelease,
        sourceFile: SOURCE_TABLE_NAME,
        sourceSha256: selected.sourceSha256,
        sourceByteLength: selected.sourceByteLength,
        recordCount: records.length,
        catalogSha256,
        catalogByteLength: serializedBytes.byteLength,
        brotliByteLength: compressedBytes.byteLength,
      }
    : null;
  if (releaseManifest) {
    await writeFile(
      path.join(releaseDirectory, 'release.json'),
      `${JSON.stringify(releaseManifest, null, 2)}
`,
      'utf8',
    );
  }

  const bytes = serializedBytes.byteLength;
  const gzipBytes = gzipSync(serializedBytes).byteLength;
  const brotliBytes = compressedBytes.byteLength;
  console.log(`Selected ${path.relative(PROJECT_ROOT, selected.filePath)}`);
  const resolvedColumns = describeResolvedColumns(selected.headers, selected.columns);
  console.log(
    `Resolved columns: id=${resolvedColumns.id}, name=${resolvedColumns.name}, transport=${resolvedColumns.meansOfTransport}, type=${resolvedColumns.stopType}, geometry=${resolvedColumns.geometry}, east=${resolvedColumns.east}, north=${resolvedColumns.north}`,
  );
  console.log(
    `Accepted ${selected.records.length.toLocaleString('en-US')} of ${selected.sourceRowCount.toLocaleString('en-US')} source rows after required-field validation.`,
  );
  console.log(`Prepared ${payload.records.length.toLocaleString('en-US')} records.`);
  console.log(
    `Interned ${meansOfTransport.length.toLocaleString('en-US')} transport descriptions and ${stopTypes.length.toLocaleString('en-US')} stop types.`,
  );
  console.log(`Source release ${sourceRelease} (${selected.sourceSha256}).`);
  if (releaseManifest) {
    console.log(
      `Wrote ${path.relative(PROJECT_ROOT, output)} (${formatBytes(brotliBytes)}, Brotli quality 11; ${formatBytes(bytes)} decoded).`,
    );
    console.log(
      `Prepared immutable release ${releasePath} with stops.json.br, release.json, and decoded catalog SHA-256 ${catalogSha256}.`,
    );
  } else {
    console.log(`Wrote ${path.relative(PROJECT_ROOT, output)} (${formatBytes(bytes)}).`);
    console.log(
      `Estimated transfer sizes: gzip ${formatBytes(gzipBytes)}, Brotli ${formatBytes(brotliBytes)}.`,
    );
  }
}

const invokedScript = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedScript === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
