/**
 * Business context: prepares a small browser-readable public-transport stop
 * catalog from the manually downloaded and extracted FOT GeoAdmin CSV asset.
 * The generated file is intentionally local-only so the static-data approach
 * can be validated before any Cloudflare R2 publication workflow is designed.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync } from 'node:zlib';

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
const OUTPUT_FORMAT_VERSION = 2;

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

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--output') {
      const outputArgument = args[index + 1];
      if (!outputArgument) {
        throw new Error('Missing value after --output.');
      }
      output = path.resolve(outputArgument);
      index += 1;
    } else if (!argument.startsWith('--') && input === null) {
      input = argument;
    } else {
      throw new Error(`Unexpected argument: ${argument}`);
    }
  }

  if (!input) {
    throw new Error(
      'Usage: npm run prepare:public-transport-stops-local -- <extracted CSV file or directory> [--output <file>]',
    );
  }

  return { input: path.resolve(input), output };
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

  for (const candidate of normalizedCandidates) {
    // One-letter coordinate headers such as `E`, `N`, `X`, and `Y` must only
    // match exactly; suffix matching them would incorrectly accept unrelated
    // columns such as `Designation`.
    if (candidate.length < 2) continue;
    const suffix = normalizedHeaders.findIndex((header) =>
      header.endsWith(candidate),
    );
    if (suffix >= 0) return suffix;
  }

  if (!required) return -1;
  throw new Error(
    `Missing CSV column (${candidates.join(', ')}). Available headers: ${headers.join(' | ')}`,
  );
}

function parsePointGeometry(value) {
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

function resolveColumns(headers) {
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

  return { filePath, records, headers, rejectionReason: null };
}

async function main() {
  const { input, output } = parseArguments(process.argv);
  const csvFiles = await collectCsvFiles(input);
  if (csvFiles.length === 0) {
    throw new Error(`No CSV files found under ${input}.`);
  }

  const inspectedCandidates = [];
  for (const csvFile of csvFiles) {
    const text = await readFile(csvFile, 'utf8');
    inspectedCandidates.push(parseCandidateCsv(csvFile, text));
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

  // The download can contain several model tables. The passenger/operating-point
  // table is expected to be the largest compatible table, while platform-edge
  // tables either lack the transport-mode field or use a different identifier.
  candidates.sort((first, second) => second.records.length - first.records.length);
  const selected = candidates[0];
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
  const payload = {
    version: OUTPUT_FORMAT_VERSION,
    source: SOURCE_DATASET_ID,
    generatedAt: new Date().toISOString(),
    meansOfTransport,
    stopTypes,
    records,
  };
  const serialized = JSON.stringify(payload);

  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${serialized}\n`, 'utf8');

  const bytes = Buffer.byteLength(serialized);
  const gzipBytes = gzipSync(serialized).byteLength;
  const brotliBytes = brotliCompressSync(serialized).byteLength;
  console.log(`Selected ${path.relative(PROJECT_ROOT, selected.filePath)}`);
  console.log(`Prepared ${payload.records.length.toLocaleString('en-US')} records.`);
  console.log(
    `Interned ${meansOfTransport.length.toLocaleString('en-US')} transport descriptions and ${stopTypes.length.toLocaleString('en-US')} stop types.`,
  );
  console.log(`Wrote ${path.relative(PROJECT_ROOT, output)} (${formatBytes(bytes)}).`);
  console.log(
    `Estimated transfer sizes: gzip ${formatBytes(gzipBytes)}, Brotli ${formatBytes(brotliBytes)}.`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
