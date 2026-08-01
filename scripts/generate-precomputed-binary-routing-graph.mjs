/**
 * Business context: compiles validated offline Swiss geometry cells into a
 * compact binary routing graph with stable global integer node and edge IDs.
 * The shared TypeScript compiler applies walkability, costs, 3D node identity,
 * and duplicate-edge rules before the binary format is written.
 *
 * National builds use a temporary disk-backed SQLite index rather than global
 * JavaScript Maps. This keeps memory bounded while preserving deterministic IDs
 * and exact cross-cell deduplication for the complete Swiss network.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  extractRoutingDataConfigArgument,
  loadRoutingDataConfig,
} from './lib/routing-data-config.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const DEFAULT_SCOPE = 'ch';
const TEMP_COMPILER_ROOT = join(
  tmpdir(),
  `via-helvetica-routing-compiler-${process.pid}`,
);
const COMPILER_SOURCE = join(
  ROOT,
  'src',
  'routing',
  'precomputedRoutingGraph.ts',
);
const CELL_FORMAT_SOURCE = join(
  ROOT,
  'src',
  'routing',
  'staticRoutingCellFormat.ts',
);

const FORMAT_NAME = 'via-helvetica-precomputed-binary-routing-graph';
const FORMAT_VERSION = 3;
const GENERATOR_VERSION = 4;
const MAGIC = Buffer.from('VHRG', 'ascii');
const HEADER_BYTES = 104;
const XY_SCALE = 100;
const Z_SCALE = 10;
const COST_SCALE = 10_000;
const NO_ELEVATION = -2_147_483_648;
const GENERATOR_VERSION_OFFSET = 64;
const DATASET_BUILD_ID_OFFSET = 68;
const DATASET_BUILD_ID_BYTES = 32;
const PAYLOAD_CRC32_OFFSET = 100;
const PAYLOAD_CHECKSUM = 'crc32';
const COORDINATE_VALIDATION_MARGIN_METRES = 6_000;
const COST_MODEL_VERSION = 1;
const BROTLI_QUALITY = 11;
const BROTLI_LGWIN = 24;
const MINIMUM_NODE_SQLITE_VERSION = [22, 5, 0];

/**
 * @typedef {Object} GeneratorOptions
 * @property {string} sourceRoot Validated geometry-cell root containing manifest.json.
 * @property {string} outputRoot External local release root containing raw and Brotli cells.
 * @property {string} databasePath Temporary disk-backed graph index.
 * @property {string} scope Stable geographic scope written to the manifest.
 * @property {boolean} keepDatabase Whether to retain the SQLite build database.
 */

/**
 * @typedef {Object} NodeRecord
 * @property {number} id Dataset-wide sequential node ID.
 * @property {number[]} coordinate Original EPSG:2056 coordinate.
 */

/**
 * @typedef {Object} EdgeRecord
 * @property {number} id Dataset-wide sequential edge ID.
 * @property {number} startId Global ID of the first endpoint.
 * @property {number} endId Global ID of the second endpoint.
 * @property {number} cost Final pedestrian traversal cost.
 * @property {boolean} isHikingTrail Whether hiking classification influenced the edge.
 */

/**
 * @typedef {Object} IntegrityFile
 * @property {string} path Path relative to the generated dataset root.
 * @property {number} sizeBytes Exact byte length.
 * @property {string} sha256 Lowercase SHA-256 digest.
 */

/** Parses a semantic Node.js version into numeric components. */
function nodeVersion() {
  return process.versions.node.split('.').map((value) => Number(value));
}

/** Returns whether the current Node.js version provides `node:sqlite`. */
function supportsNodeSqlite() {
  const actual = nodeVersion();
  for (let index = 0; index < MINIMUM_NODE_SQLITE_VERSION.length; index += 1) {
    if (actual[index] > MINIMUM_NODE_SQLITE_VERSION[index]) {
      return true;
    }
    if (actual[index] < MINIMUM_NODE_SQLITE_VERSION[index]) {
      return false;
    }
  }
  return true;
}

/** Reads and parses one UTF-8 JSON file. */
async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

/** Orders numeric routing-grid keys independently of JSON manifest order. */
function compareCellKeys(left, right) {
  const [leftColumn, leftRow] = left.split(':').map(Number);
  const [rightColumn, rightRow] = right.split(':').map(Number);
  return leftColumn - rightColumn || leftRow - rightRow;
}

/** Aligns a byte offset for typed-array-safe little-endian sections. */
function align4(value) {
  return Math.ceil(value / 4) * 4;
}

/** Computes the byte layout shared with the Worker parser. */
function binaryLayout(nodeCount, edgeCount) {
  let offset = HEADER_BYTES;
  const nodeIdsOffset = offset;
  offset += nodeCount * 4;
  const nodeXOffset = offset;
  offset += nodeCount * 4;
  const nodeYOffset = offset;
  offset += nodeCount * 4;
  const nodeZOffset = offset;
  offset += nodeCount * 4;
  const edgeIdsOffset = offset;
  offset += edgeCount * 4;
  const edgeStartOffset = offset;
  offset += edgeCount * 4;
  const edgeEndOffset = offset;
  offset += edgeCount * 4;
  const edgeCostOffset = offset;
  offset += edgeCount * 4;
  const edgeFlagsOffset = offset;
  offset += edgeCount;

  return {
    nodeIdsOffset,
    nodeXOffset,
    nodeYOffset,
    nodeZOffset,
    edgeIdsOffset,
    edgeStartOffset,
    edgeEndOffset,
    edgeCostOffset,
    edgeFlagsOffset,
    byteLength: align4(offset),
  };
}

/** Precomputed lookup table for the standard IEEE CRC32 polynomial. */
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);

  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }

  return table;
})();

/** Calculates CRC32 for the generated payload after the fixed header. */
function payloadCrc32(buffer) {
  let crc = 0xffffffff;
  for (let index = HEADER_BYTES; index < buffer.length; index += 1) {
    crc = CRC32_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Transpiles the shared geometry validator and graph compiler. */
async function loadSharedCompiler() {
  const require = createRequire(import.meta.url);
  let command = 'tsc';
  let commandPrefix = [];

  try {
    const typescriptPackage = require.resolve('typescript/package.json');
    command = process.execPath;
    commandPrefix = [join(dirname(typescriptPackage), 'bin', 'tsc')];
  } catch {
    // A globally installed compiler keeps offline generation available when the
    // application dependencies are not installed in the current checkout.
  }

  await rm(TEMP_COMPILER_ROOT, { recursive: true, force: true });
  await mkdir(TEMP_COMPILER_ROOT, { recursive: true });

  const compiledRoot = join(TEMP_COMPILER_ROOT, 'compiled');
  const compilerConfigPath = join(TEMP_COMPILER_ROOT, 'tsconfig.json');
  await writeFile(
    compilerConfigPath,
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          skipLibCheck: true,
          types: [],
          rootDir: dirname(COMPILER_SOURCE),
          outDir: compiledRoot,
        },
        files: [COMPILER_SOURCE, CELL_FORMAT_SOURCE],
      },
      null,
      2,
    ),
    'utf8',
  );

  const result = spawnSync(
    command,
    [...commandPrefix, '-p', compilerConfigPath],
    { cwd: ROOT, encoding: 'utf8' },
  );

  if (result.status !== 0) {
    throw new Error(
      `Shared routing compiler transpilation failed.\n${result.stdout}${result.stderr}`,
    );
  }

  const compilerPath = join(compiledRoot, 'precomputedRoutingGraph.js');
  const cellFormatPath = join(compiledRoot, 'staticRoutingCellFormat.js');
  const [compiler, cellFormat] = await Promise.all([
    import(`${pathToFileURL(compilerPath).href}?generated=${Date.now()}`),
    import(`${pathToFileURL(cellFormatPath).href}?generated=${Date.now()}`),
  ]);
  return { ...compiler, ...cellFormat };
}

/** Returns a stable undirected identity for one graph edge. */
function edgeKey(startNodeKey, endNodeKey) {
  return startNodeKey < endNodeKey
    ? `${startNodeKey}|${endNodeKey}`
    : `${endNodeKey}|${startNodeKey}`;
}

/** Converts a metre value to a checked signed 32-bit integer. */
function quantizeSigned(value, scale, label) {
  const quantized = Math.round(value * scale);

  if (
    !Number.isSafeInteger(quantized) ||
    quantized < -2_147_483_648 ||
    quantized > 2_147_483_647
  ) {
    throw new Error(`${label} is outside the signed 32-bit binary range.`);
  }

  return quantized;
}

/**
 * Normalizes one graph node to the exact resolution written to the binary file.
 *
 * Neighbouring source features may contribute slightly different coordinates
 * that intentionally share the same coarser graph identity. Comparing at binary
 * resolution removes irrelevant floating-point noise before the national merge.
 */
function normalizeNodeCoordinate(coordinate) {
  return {
    x: quantizeSigned(coordinate[0], XY_SCALE, 'Node X coordinate') / XY_SCALE,
    y: quantizeSigned(coordinate[1], XY_SCALE, 'Node Y coordinate') / XY_SCALE,
    z: Number.isFinite(coordinate[2])
      ? quantizeSigned(coordinate[2], Z_SCALE, 'Node elevation') / Z_SCALE
      : null,
  };
}

/**
 * Normalizes one traversal cost to the exact unsigned value stored per edge.
 */
function normalizeEdgeCost(cost) {
  return quantizeCost(cost) / COST_SCALE;
}

/** Converts a positive cost to its checked fixed-point representation. */
function quantizeCost(value) {
  const quantized = Math.round(value * COST_SCALE);

  if (!Number.isSafeInteger(quantized) || quantized <= 0 || quantized > 0xffffffff) {
    throw new Error('Routing cost is outside the unsigned 32-bit binary range.');
  }

  return quantized;
}

/** Writes one independently loadable graph cell using columnar typed arrays. */
function encodeCell(
  key,
  nodeRecords,
  edgeRecords,
  sourceRoadFeatures,
  globalNodeCount,
  globalEdgeCount,
  datasetBuildId,
) {
  const [column, row] = key.split(':').map(Number);
  const layout = binaryLayout(nodeRecords.length, edgeRecords.length);
  const buffer = Buffer.alloc(layout.byteLength);

  for (let index = 1; index < nodeRecords.length; index += 1) {
    if (nodeRecords[index - 1].id >= nodeRecords[index].id) {
      throw new Error(`Cell ${key} node IDs are not strictly increasing.`);
    }
  }
  for (let index = 1; index < edgeRecords.length; index += 1) {
    if (edgeRecords[index - 1].id >= edgeRecords[index].id) {
      throw new Error(`Cell ${key} edge IDs are not strictly increasing.`);
    }
  }

  MAGIC.copy(buffer, 0);
  buffer.writeUInt16LE(FORMAT_VERSION, 4);
  buffer.writeUInt16LE(HEADER_BYTES, 6);
  buffer.writeInt32LE(column, 8);
  buffer.writeInt32LE(row, 12);
  buffer.writeUInt32LE(nodeRecords.length, 16);
  buffer.writeUInt32LE(edgeRecords.length, 20);
  buffer.writeUInt32LE(sourceRoadFeatures, 24);
  buffer.writeUInt32LE(XY_SCALE, 28);
  buffer.writeUInt32LE(Z_SCALE, 32);
  buffer.writeUInt32LE(COST_SCALE, 36);
  buffer.writeUInt32LE(layout.nodeIdsOffset, 40);
  buffer.writeUInt32LE(layout.edgeIdsOffset, 44);
  buffer.writeUInt32LE(layout.edgeFlagsOffset, 48);
  buffer.writeUInt32LE(layout.byteLength, 52);
  buffer.writeUInt32LE(globalNodeCount, 56);
  buffer.writeUInt32LE(globalEdgeCount, 60);
  buffer.writeUInt32LE(GENERATOR_VERSION, GENERATOR_VERSION_OFFSET);

  if (datasetBuildId.length !== DATASET_BUILD_ID_BYTES) {
    throw new Error('Dataset build ID must contain exactly 32 bytes.');
  }
  datasetBuildId.copy(buffer, DATASET_BUILD_ID_OFFSET);

  for (let index = 0; index < nodeRecords.length; index += 1) {
    const node = nodeRecords[index];
    buffer.writeUInt32LE(node.id, layout.nodeIdsOffset + index * 4);
    buffer.writeInt32LE(
      quantizeSigned(node.coordinate[0], XY_SCALE, 'Node X coordinate'),
      layout.nodeXOffset + index * 4,
    );
    buffer.writeInt32LE(
      quantizeSigned(node.coordinate[1], XY_SCALE, 'Node Y coordinate'),
      layout.nodeYOffset + index * 4,
    );
    buffer.writeInt32LE(
      Number.isFinite(node.coordinate[2])
        ? quantizeSigned(node.coordinate[2], Z_SCALE, 'Node elevation')
        : NO_ELEVATION,
      layout.nodeZOffset + index * 4,
    );
  }

  for (let index = 0; index < edgeRecords.length; index += 1) {
    const edge = edgeRecords[index];
    buffer.writeUInt32LE(edge.id, layout.edgeIdsOffset + index * 4);
    buffer.writeUInt32LE(edge.startId, layout.edgeStartOffset + index * 4);
    buffer.writeUInt32LE(edge.endId, layout.edgeEndOffset + index * 4);
    buffer.writeUInt32LE(
      quantizeCost(edge.cost),
      layout.edgeCostOffset + index * 4,
    );
    buffer.writeUInt8(edge.isHikingTrail ? 1 : 0, layout.edgeFlagsOffset + index);
  }

  buffer.writeUInt32LE(payloadCrc32(buffer), PAYLOAD_CRC32_OFFSET);
  return buffer;
}

/**
 * Parses supported generator options and merges them with local pipeline paths.
 * Command-line values take precedence so bounded experiments remain possible.
 */
async function parseOptions(argv) {
  const {
    configPath,
    configWasExplicit,
    argv: remainingArguments,
  } = extractRoutingDataConfigArgument(argv);
  const overrides = {
    sourceRoot: null,
    outputRoot: null,
    databasePath: null,
    scope: null,
    keepDatabase: false,
  };

  for (let index = 0; index < remainingArguments.length; index += 1) {
    const argument = remainingArguments[index];
    const next = remainingArguments[index + 1];

    if (argument === '--keep-database') {
      overrides.keepDatabase = true;
      continue;
    }
    if (!next || next.startsWith('--')) {
      throw new Error(`Missing value for ${argument}.`);
    }

    switch (argument) {
      case '--source':
        overrides.sourceRoot = resolve(next);
        break;
      case '--output':
        overrides.outputRoot = resolve(next);
        break;
      case '--database':
        overrides.databasePath = resolve(next);
        break;
      case '--scope':
        overrides.scope = next.trim();
        if (!overrides.scope) {
          throw new Error('Dataset scope must not be empty.');
        }
        break;
      default:
        throw new Error(`Unknown generator option: ${argument}`);
    }
    index += 1;
  }

  const config = await loadRoutingDataConfig(configPath, {
    optional:
      !configWasExplicit &&
      overrides.sourceRoot !== null &&
      overrides.outputRoot !== null &&
      overrides.databasePath !== null,
  });
  const options = {
    sourceRoot: overrides.sourceRoot ?? config.geometryRoot,
    outputRoot: overrides.outputRoot ?? config.binaryReleaseRoot,
    databasePath: overrides.databasePath ?? config.buildDatabasePath,
    scope: overrides.scope ?? config.scope ?? DEFAULT_SCOPE,
    keepDatabase: overrides.keepDatabase,
  };

  for (const [field, value] of [
    ['geometryRoot/--source', options.sourceRoot],
    ['binaryReleaseRoot/--output', options.outputRoot],
    ['buildDatabasePath/--database', options.databasePath],
  ]) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(
        `${field} must be configured in routing-data.config.local.json or supplied on the command line.`,
      );
    }
  }
  if (typeof options.scope !== 'string' || options.scope.trim() === '') {
    throw new Error('Dataset scope must not be empty.');
  }

  return {
    ...options,
    sourceRoot: resolve(options.sourceRoot),
    outputRoot: resolve(options.outputRoot),
    databasePath: resolve(options.databasePath),
    scope: options.scope.trim(),
  };
}

/** Creates the temporary disk-backed global graph index. */
function createGraphDatabase(DatabaseSync, path) {
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA journal_mode = OFF;
    PRAGMA synchronous = OFF;
    PRAGMA temp_store = MEMORY;
    PRAGMA locking_mode = EXCLUSIVE;
    CREATE TABLE nodes (
      node_key TEXT PRIMARY KEY,
      node_id INTEGER NOT NULL UNIQUE,
      x REAL NOT NULL,
      y REAL NOT NULL,
      z REAL,
      coordinate_variant INTEGER NOT NULL DEFAULT 0,
      conflict INTEGER NOT NULL DEFAULT 0
    ) WITHOUT ROWID;
    CREATE TABLE edges (
      edge_key TEXT PRIMARY KEY,
      edge_id INTEGER NOT NULL UNIQUE,
      start_node_key TEXT NOT NULL,
      end_node_key TEXT NOT NULL,
      cost REAL NOT NULL,
      hiking INTEGER NOT NULL,
      value_variant INTEGER NOT NULL DEFAULT 0
    ) WITHOUT ROWID;
    CREATE TABLE source_cells (
      cell_key TEXT PRIMARY KEY,
      source_road_features INTEGER NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE cell_nodes (
      cell_key TEXT NOT NULL,
      local_order INTEGER NOT NULL,
      node_key TEXT NOT NULL,
      PRIMARY KEY (cell_key, local_order),
      UNIQUE (cell_key, node_key)
    ) WITHOUT ROWID;
    CREATE TABLE cell_edges (
      cell_key TEXT NOT NULL,
      local_order INTEGER NOT NULL,
      edge_key TEXT NOT NULL,
      PRIMARY KEY (cell_key, local_order),
      UNIQUE (cell_key, edge_key)
    ) WITHOUT ROWID;
  `);
  return database;
}

/** Calculates SHA-256 for one generated buffer. */
function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Identifies one complete generated release independently of its upload path.
 * Every v3 cell repeats these bytes so mixed annual or partial builds fail at
 * decode time even when their global record counts happen to match.
 */
function createDatasetBuildId(
  sourceManifest,
  sourceCellKeyOrderSha256,
  scope,
  globalNodeCount,
  globalEdgeCount,
) {
  const contract = {
    format: FORMAT_NAME,
    formatVersion: FORMAT_VERSION,
    generatorVersion: GENERATOR_VERSION,
    costModelVersion: COST_MODEL_VERSION,
    scope,
    projection: 'EPSG:2056',
    cellSizeMetres: sourceManifest.cellSizeMetres,
    extent: sourceManifest.extent,
    sourceGeometryFormat: sourceManifest.format,
    sourceGeometryFormatVersion: sourceManifest.version,
    sourceDatasetVersion: sourceManifest.sourceDatasetVersion,
    sourceSha256: sourceManifest.sourceSha256,
    sourceSizeBytes: sourceManifest.sourceSizeBytes,
    sourceLayer: sourceManifest.sourceLayer,
    sourceCellKeyOrderSha256,
    sourceCellCount: sourceManifest.nonEmptyCellKeys.length,
    sourceGeometryBytes: sourceManifest.uncompressedCellBytes,
    sourceRoadFeatureCount:
      sourceManifest.roadFeatureCountBeforeCellDuplication,
    sourceRoadFeatureReferenceCount: sourceManifest.roadFeatureReferenceCount,
    sourceCellAssignment: sourceManifest.cellAssignment,
    sourceGeometryParseErrors: sourceManifest.geometryParseErrors,
    globalNodeCount,
    globalEdgeCount,
  };

  return createHash('sha256').update(JSON.stringify(contract)).digest();
}

/** Returns a nearest-rank percentile for sorted non-negative measurements. */
function percentile(sorted, fraction) {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1),
  );
  return sorted[index];
}

/** Builds the disk-backed graph index from every source geometry cell. */
async function indexSourceCells(
  database,
  sourceRoot,
  sourceManifest,
  compilePrecomputedRoutingGraph,
  readStaticRoutingCell,
  nodeHorizontalPrecisionMetres,
  nodeVerticalPrecisionMetres,
) {
  const insertNode = database.prepare(`
    INSERT OR IGNORE INTO nodes(node_key, node_id, x, y, z)
    VALUES (?, ?, ?, ?, ?)
  `);
  const markNodeVariant = database.prepare(`
    UPDATE nodes
    SET
      coordinate_variant = 1,
      conflict = CASE
        WHEN (
          ABS(x - ?) > ? OR
          ABS(y - ?) > ? OR
          (z IS NULL AND ? IS NOT NULL) OR
          (z IS NOT NULL AND ? IS NULL) OR
          (z IS NOT NULL AND ? IS NOT NULL AND ABS(z - ?) > ?)
        )
        THEN 1
        ELSE conflict
      END
    WHERE node_key = ? AND (
      ABS(x - ?) > 1e-9 OR
      ABS(y - ?) > 1e-9 OR
      (z IS NULL AND ? IS NOT NULL) OR
      (z IS NOT NULL AND ? IS NULL) OR
      (z IS NOT NULL AND ? IS NOT NULL AND ABS(z - ?) > 1e-9)
    )
  `);
  const canonicalizeNode = database.prepare(`
    UPDATE nodes
    SET x = ?, y = ?, z = ?
    WHERE node_key = ? AND (
      ? < x OR
      (? = x AND ? < y) OR
      (
        ? = x AND
        ? = y AND
        COALESCE(?, -1e300) < COALESCE(z, -1e300)
      )
    )
  `);
  const insertEdge = database.prepare(`
    INSERT OR IGNORE INTO edges(
      edge_key, edge_id, start_node_key, end_node_key, cost, hiking
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const mergeEdgeVariant = database.prepare(`
    UPDATE edges
    SET
      value_variant = CASE
        WHEN ABS(cost - ?) > 1e-9 OR hiking <> ? THEN 1
        ELSE value_variant
      END,
      hiking = CASE
        WHEN ? < cost - 1e-9 THEN ?
        WHEN ABS(? - cost) <= 1e-9 THEN MAX(hiking, ?)
        ELSE hiking
      END,
      cost = MIN(cost, ?)
    WHERE edge_key = ?
  `);
  const insertSourceCell = database.prepare(`
    INSERT INTO source_cells(cell_key, source_road_features)
    VALUES (?, ?)
  `);
  const insertCellNode = database.prepare(`
    INSERT INTO cell_nodes(cell_key, local_order, node_key)
    VALUES (?, ?, ?)
  `);
  const insertCellEdge = database.prepare(`
    INSERT INTO cell_edges(cell_key, local_order, edge_key)
    VALUES (?, ?, ?)
  `);

  let nextNodeId = 0;
  let nextEdgeId = 0;
  let processedCells = 0;

  for (const key of sourceManifest.nonEmptyCellKeys) {
    const [column, row] = key.split(':');
    const sourceCell = readStaticRoutingCell(
      await readJson(join(sourceRoot, 'cells', `${column}_${row}.json`)),
      key,
    );
    const graph = compilePrecomputedRoutingGraph({
      roads: sourceCell.roads,
      hikingTrails: [],
    });

    if (graph.segments.length === 0) {
      continue;
    }

    database.exec('BEGIN IMMEDIATE');
    try {
      for (let index = 0; index < graph.nodes.length; index += 1) {
        const node = graph.nodes[index];
        const coordinate = normalizeNodeCoordinate(node.coordinate);
        const result = insertNode.run(
          node.key,
          nextNodeId,
          coordinate.x,
          coordinate.y,
          coordinate.z,
        );
        if (result.changes === 1) {
          nextNodeId += 1;
        } else {
          // The node key deliberately merges source vertices within 0.5 m
          // horizontally and 2 m vertically. Different representatives are
          // therefore expected nationally; only a value outside those identity
          // buckets indicates a compiler or data-contract defect.
          markNodeVariant.run(
            coordinate.x,
            nodeHorizontalPrecisionMetres + 1e-9,
            coordinate.y,
            nodeHorizontalPrecisionMetres + 1e-9,
            coordinate.z,
            coordinate.z,
            coordinate.z,
            coordinate.z,
            nodeVerticalPrecisionMetres + 1e-9,
            node.key,
            coordinate.x,
            coordinate.y,
            coordinate.z,
            coordinate.z,
            coordinate.z,
            coordinate.z,
          );

          // Every cell must write the same coordinate for a shared global node.
          // Lexicographic selection is deterministic and remains within the
          // identity bucket validated above.
          canonicalizeNode.run(
            coordinate.x,
            coordinate.y,
            coordinate.z,
            node.key,
            coordinate.x,
            coordinate.x,
            coordinate.y,
            coordinate.x,
            coordinate.y,
            coordinate.z,
          );
        }
        insertCellNode.run(key, index, node.key);
      }

      const seenEdges = new Set();
      let localEdgeOrder = 0;
      for (const segment of graph.segments) {
        const identity = edgeKey(segment.startNodeKey, segment.endNodeKey);
        if (seenEdges.has(identity)) {
          continue;
        }
        seenEdges.add(identity);

        const normalizedCost = normalizeEdgeCost(segment.cost);
        const hiking = segment.isHikingTrail ? 1 : 0;
        const result = insertEdge.run(
          identity,
          nextEdgeId,
          segment.startNodeKey,
          segment.endNodeKey,
          normalizedCost,
          hiking,
        );
        if (result.changes === 1) {
          nextEdgeId += 1;
        } else {
          // Distinct swissTLM3D features can quantize to the same endpoint
          // pair. The shared compiler already keeps the cheapest interpretation
          // within one cell; the national merge must apply the same policy
          // across cell boundaries instead of treating it as corruption.
          mergeEdgeVariant.run(
            normalizedCost,
            hiking,
            normalizedCost,
            hiking,
            normalizedCost,
            hiking,
            normalizedCost,
            identity,
          );
        }
        insertCellEdge.run(key, localEdgeOrder, identity);
        localEdgeOrder += 1;
      }

      insertSourceCell.run(key, graph.sourceRoadFeatures);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }

    processedCells += 1;
    if (processedCells % 100 === 0) {
      console.log(
        `Indexed ${processedCells}/${sourceManifest.nonEmptyCellKeys.length} geometry cells...`,
      );
    }
  }

  const nodeConflicts = database
    .prepare('SELECT COUNT(*) AS count FROM nodes WHERE conflict <> 0')
    .get().count;
  const nodeCoordinateVariants = database
    .prepare(
      'SELECT COUNT(*) AS count FROM nodes WHERE coordinate_variant <> 0',
    )
    .get().count;
  const edgeValueVariants = database
    .prepare('SELECT COUNT(*) AS count FROM edges WHERE value_variant <> 0')
    .get().count;

  if (nodeConflicts !== 0) {
    throw new Error(
      `Global node identity conflicts detected: ${nodeConflicts}.`,
    );
  }
  if (nextNodeId > 0xffffffff || nextEdgeId > 0xffffffff) {
    throw new Error('The national graph exceeds the unsigned 32-bit ID space.');
  }

  console.log(
    `Merged ${nodeCoordinateVariants} shared-node coordinate variants and ` +
      `${edgeValueVariants} duplicate-edge value variants.`,
  );

  database.exec(`
    CREATE INDEX cell_nodes_by_key ON cell_nodes(cell_key, local_order);
    CREATE INDEX cell_edges_by_key ON cell_edges(cell_key, local_order);
    ANALYZE;
  `);

  return {
    globalNodeCount: nextNodeId,
    globalEdgeCount: nextEdgeId,
    nodeCoordinateVariants,
    edgeValueVariants,
  };
}

/** Writes all binary cells and returns aggregate manifest statistics. */
async function writeBinaryCells(
  database,
  temporaryOutputRoot,
  globalNodeCount,
  globalEdgeCount,
  datasetBuildId,
) {
  const outputCells = join(temporaryOutputRoot, 'cells');
  await mkdir(outputCells, { recursive: true });

  const cells = database
    .prepare('SELECT cell_key, source_road_features FROM source_cells')
    .all()
    .sort((left, right) => compareCellKeys(left.cell_key, right.cell_key));
  const selectNodes = database.prepare(`
    SELECT nodes.node_id AS id, nodes.x, nodes.y, nodes.z
    FROM cell_nodes
    JOIN nodes USING (node_key)
    WHERE cell_nodes.cell_key = ?
    ORDER BY nodes.node_id
  `);
  const selectEdges = database.prepare(`
    SELECT
      edges.edge_id AS id,
      start_node.node_id AS startId,
      end_node.node_id AS endId,
      edges.cost,
      edges.hiking
    FROM cell_edges
    JOIN edges USING (edge_key)
    JOIN nodes AS start_node ON start_node.node_key = edges.start_node_key
    JOIN nodes AS end_node ON end_node.node_key = edges.end_node_key
    WHERE cell_edges.cell_key = ?
    ORDER BY edges.edge_id
  `);

  const cellKeys = [];
  const integrityFiles = [];
  const rawCellSizes = [];
  const brotliCellSizes = [];
  const nodeReferenceCounts = [];
  const edgeReferenceCounts = [];
  let uncompressedCellBytes = 0;
  let brotliCellBytes = 0;
  let totalNodeReferences = 0;
  let totalEdgeReferences = 0;
  let hikingEdgeReferences = 0;

  for (let index = 0; index < cells.length; index += 1) {
    const sourceCell = cells[index];
    const nodeRecords = selectNodes.all(sourceCell.cell_key).map(
      (row) => ({
        id: row.id,
        coordinate:
          row.z === null ? [row.x, row.y] : [row.x, row.y, row.z],
      }),
    );
    const edgeRecords = selectEdges.all(sourceCell.cell_key).map(
      (row) => ({
        id: row.id,
        startId: row.startId,
        endId: row.endId,
        cost: row.cost,
        isHikingTrail: row.hiking === 1,
      }),
    );
    const encoded = encodeCell(
      sourceCell.cell_key,
      nodeRecords,
      edgeRecords,
      sourceCell.source_road_features,
      globalNodeCount,
      globalEdgeCount,
      datasetBuildId,
    );
    const compressed = brotliCompressSync(encoded, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
        [zlibConstants.BROTLI_PARAM_LGWIN]: BROTLI_LGWIN,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: encoded.byteLength,
      },
    });
    const [column, row] = sourceCell.cell_key.split(':');
    const rawRelativePath = `cells/${column}_${row}.bin`;
    const brotliRelativePath = `${rawRelativePath}.br`;

    await writeFile(join(temporaryOutputRoot, rawRelativePath), encoded);
    await writeFile(join(temporaryOutputRoot, brotliRelativePath), compressed);

    cellKeys.push(sourceCell.cell_key);
    integrityFiles.push(
      {
        path: rawRelativePath,
        sizeBytes: encoded.byteLength,
        sha256: sha256(encoded),
      },
      {
        path: brotliRelativePath,
        sizeBytes: compressed.byteLength,
        sha256: sha256(compressed),
      },
    );
    rawCellSizes.push(encoded.byteLength);
    brotliCellSizes.push(compressed.byteLength);
    nodeReferenceCounts.push(nodeRecords.length);
    edgeReferenceCounts.push(edgeRecords.length);
    uncompressedCellBytes += encoded.byteLength;
    brotliCellBytes += compressed.byteLength;
    totalNodeReferences += nodeRecords.length;
    totalEdgeReferences += edgeRecords.length;
    hikingEdgeReferences += edgeRecords.filter(
      (edge) => edge.isHikingTrail,
    ).length;

    if ((index + 1) % 100 === 0) {
      console.log(`Encoded ${index + 1}/${cells.length} binary cells...`);
    }
  }

  return {
    cellKeys,
    integrityFiles,
    uncompressedCellBytes,
    brotliCellBytes,
    totalNodeReferences,
    totalEdgeReferences,
    hikingEdgeReferences,
    rawCellSizes,
    brotliCellSizes,
    nodeReferenceCounts,
    edgeReferenceCounts,
  };
}

/** Atomically replaces the generated output after all files are complete. */
async function replaceOutput(
  temporaryOutputRoot,
  outputRoot,
) {
  await mkdir(dirname(outputRoot), { recursive: true });
  const previousOutputRoot = `${outputRoot}.previous-${process.pid}`;
  await rm(previousOutputRoot, { recursive: true, force: true });

  let previousOutputMoved = false;
  try {
    await rename(outputRoot, previousOutputRoot);
    previousOutputMoved = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  try {
    await rename(temporaryOutputRoot, outputRoot);
  } catch (error) {
    if (previousOutputMoved) {
      await rename(previousOutputRoot, outputRoot);
    }
    throw error;
  }

  if (previousOutputMoved) {
    await rm(previousOutputRoot, { recursive: true, force: true });
  }
}

/** Runs the complete disk-backed national graph build. */
async function main() {
  if (!supportsNodeSqlite()) {
    throw new Error(
      'National binary generation requires Node.js 22.5 or later for node:sqlite.',
    );
  }

  const options = await parseOptions(process.argv.slice(2));
  const temporaryOutputRoot = `${options.outputRoot}.building-${process.pid}`;

  await rm(temporaryOutputRoot, { recursive: true, force: true });
  await rm(options.databasePath, { force: true });
  await mkdir(dirname(options.databasePath), { recursive: true });

  const [
    sourceManifest,
    {
      compilePrecomputedRoutingGraph,
      readStaticRoutingCell,
      STATIC_ROUTING_FORMAT,
      STATIC_ROUTING_FORMAT_VERSION,
      NODE_HORIZONTAL_PRECISION_METRES,
      NODE_VERTICAL_PRECISION_METRES,
    },
    { DatabaseSync },
  ] = await Promise.all([
    readJson(join(options.sourceRoot, 'manifest.json')),
    loadSharedCompiler(),
    import('node:sqlite'),
  ]);

  if (
    sourceManifest.version !== STATIC_ROUTING_FORMAT_VERSION ||
    sourceManifest.format !== STATIC_ROUTING_FORMAT ||
    sourceManifest.cellSizeMetres !== 2_400 ||
    !Array.isArray(sourceManifest.nonEmptyCellKeys) ||
    !Number.isInteger(sourceManifest.nonEmptyCellCount) ||
    sourceManifest.nonEmptyCellCount !== sourceManifest.nonEmptyCellKeys.length ||
    sourceManifest.nonEmptyCellKeys.some(
      (key) => typeof key !== 'string' || !/^-?\d+:-?\d+$/.test(key),
    ) ||
    new Set(sourceManifest.nonEmptyCellKeys).size !==
      sourceManifest.nonEmptyCellKeys.length
  ) {
    throw new Error('Geometry-cell manifest is missing or incompatible.');
  }
  sourceManifest.nonEmptyCellKeys =
    [...sourceManifest.nonEmptyCellKeys].sort(compareCellKeys);
  if (sourceManifest.scope && sourceManifest.scope !== options.scope) {
    throw new Error(
      `Geometry scope ${sourceManifest.scope} does not match requested scope ${options.scope}.`,
    );
  }

  const database = createGraphDatabase(DatabaseSync, options.databasePath);

  try {
    const {
      globalNodeCount,
      globalEdgeCount,
      nodeCoordinateVariants,
      edgeValueVariants,
    } = await indexSourceCells(
      database,
      options.sourceRoot,
      sourceManifest,
      compilePrecomputedRoutingGraph,
      readStaticRoutingCell,
      NODE_HORIZONTAL_PRECISION_METRES,
      NODE_VERTICAL_PRECISION_METRES,
    );
    const sourceCellKeyOrderSha256 = createHash('sha256')
      .update(JSON.stringify(sourceManifest.nonEmptyCellKeys))
      .digest('hex');
    const datasetBuildId = createDatasetBuildId(
      sourceManifest,
      sourceCellKeyOrderSha256,
      options.scope,
      globalNodeCount,
      globalEdgeCount,
    );
    const statistics = await writeBinaryCells(
      database,
      temporaryOutputRoot,
      globalNodeCount,
      globalEdgeCount,
      datasetBuildId,
    );

    const sortedRawSizes = [...statistics.rawCellSizes].sort((a, b) => a - b);
    const sortedBrotliSizes = [...statistics.brotliCellSizes].sort(
      (a, b) => a - b,
    );
    const sortedNodeCounts = [...statistics.nodeReferenceCounts].sort(
      (a, b) => a - b,
    );
    const sortedEdgeCounts = [...statistics.edgeReferenceCounts].sort(
      (a, b) => a - b,
    );

    const integrity = {
      version: 1,
      algorithm: 'sha256',
      datasetManifest: 'manifest.json',
      fileCount: statistics.integrityFiles.length,
      files: statistics.integrityFiles,
    };
    const integrityBuffer = Buffer.from(
      `${JSON.stringify(integrity, null, 2)}\n`,
      'utf8',
    );
    await writeFile(
      join(temporaryOutputRoot, 'integrity.json'),
      integrityBuffer,
    );

    const manifest = {
      version: FORMAT_VERSION,
      format: FORMAT_NAME,
      generatorVersion: GENERATOR_VERSION,
      datasetBuildId: datasetBuildId.toString('hex'),
      scope: options.scope,
      projection: 'EPSG:2056',
      cellSizeMetres: sourceManifest.cellSizeMetres,
      extent: sourceManifest.extent,
      cellPathTemplate: 'cells/{column}_{row}.bin',
      integrityPath: 'integrity.json',
      nonEmptyCellCount: statistics.cellKeys.length,
      nonEmptyCellKeys: statistics.cellKeys,
      headerBytes: HEADER_BYTES,
      coordinateScalePerMetre: XY_SCALE,
      elevationScalePerMetre: Z_SCALE,
      costScalePerUnit: COST_SCALE,
      payloadChecksum: PAYLOAD_CHECKSUM,
      coordinateValidationMarginMetres:
        COORDINATE_VALIDATION_MARGIN_METRES,
      costModelVersion: COST_MODEL_VERSION,
      globalNodeCount,
      globalEdgeCount,
      globalNodeCoordinateVariantCount: nodeCoordinateVariants,
      globalEdgeValueVariantCount: edgeValueVariants,
      totalNodeReferences: statistics.totalNodeReferences,
      totalEdgeReferences: statistics.totalEdgeReferences,
      hikingEdgeReferences: statistics.hikingEdgeReferences,
      uncompressedCellBytes: statistics.uncompressedCellBytes,
      brotliCellBytes: statistics.brotliCellBytes,
      largestRawCellBytes: sortedRawSizes.at(-1) ?? 0,
      p95RawCellBytes: percentile(sortedRawSizes, 0.95),
      largestBrotliCellBytes: sortedBrotliSizes.at(-1) ?? 0,
      p95BrotliCellBytes: percentile(sortedBrotliSizes, 0.95),
      largestCellNodeReferences: sortedNodeCounts.at(-1) ?? 0,
      p95CellNodeReferences: percentile(sortedNodeCounts, 0.95),
      largestCellEdgeReferences: sortedEdgeCounts.at(-1) ?? 0,
      p95CellEdgeReferences: percentile(sortedEdgeCounts, 0.95),
      sourceGeometryFormatVersion: sourceManifest.version,
      sourceGeometryFormat: sourceManifest.format,
      sourceDatasetVersion: sourceManifest.sourceDatasetVersion,
      sourceFiles: sourceManifest.sourceFiles,
      sourceSizeBytes: sourceManifest.sourceSizeBytes,
      sourceSha256: sourceManifest.sourceSha256,
      sourceLayer: sourceManifest.sourceLayer,
      sourceCellKeyOrderSha256,
      sourceGeometryCellCount: sourceManifest.nonEmptyCellKeys.length,
      sourceGeometryCellBytes: sourceManifest.uncompressedCellBytes,
      sourceRoadFeatureCount:
        sourceManifest.roadFeatureCountBeforeCellDuplication,
      sourceRoadFeatureReferenceCount:
        sourceManifest.roadFeatureReferenceCount,
      sourceCellAssignment: sourceManifest.cellAssignment,
      sourceGeometryParseErrors: sourceManifest.geometryParseErrors,
      edgeOwnership: 'global-id-with-logical-cell-references',
      nodeIdentity: 'shared-compiler-quantized-xyz',
      recordOrder: 'strictly-increasing-global-id',
      brotliQuality: BROTLI_QUALITY,
    };
    const manifestBuffer = Buffer.from(
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );
    await writeFile(
      join(temporaryOutputRoot, 'manifest.json'),
      manifestBuffer,
    );

    await replaceOutput(temporaryOutputRoot, options.outputRoot);

    console.log(
      `Generated ${statistics.cellKeys.length} binary ${options.scope} cells ` +
        `with ${globalNodeCount} global nodes and ${globalEdgeCount} global edges.`,
    );
    console.log(
      `Raw binary size: ${(statistics.uncompressedCellBytes / 1024 / 1024).toFixed(2)} MiB.`,
    );
    console.log(
      `Brotli size: ${(statistics.brotliCellBytes / 1024 / 1024).toFixed(2)} MiB.`,
    );
    console.log(
      `Largest raw cell: ${((sortedRawSizes.at(-1) ?? 0) / 1024 / 1024).toFixed(2)} MiB; ` +
        `largest Brotli cell: ${((sortedBrotliSizes.at(-1) ?? 0) / 1024 / 1024).toFixed(2)} MiB.`,
    );
    console.log(
      `Integrity inventory: ${statistics.integrityFiles.length} files plus manifest.json.`,
    );
  } finally {
    database.close();
    await rm(TEMP_COMPILER_ROOT, { recursive: true, force: true });
    await rm(temporaryOutputRoot, { recursive: true, force: true });
    if (!options.keepDatabase) {
      await rm(options.databasePath, { force: true });
    } else {
      console.log(`Retained graph database: ${options.databasePath}`);
    }
  }
}

main().catch(async (error) => {
  await rm(TEMP_COMPILER_ROOT, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
