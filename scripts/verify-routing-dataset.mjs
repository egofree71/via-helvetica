/**
 * Business context: verifies a generated routing release before it is uploaded
 * to public object storage. It checks exact manifest coverage, immutable hashes,
 * the complete v3 binary contract, Brotli round trips, and cross-cell global-ID
 * consistency so partial, stale, or mixed builds cannot be published.
 */
import { createHash } from 'node:crypto';
import { brotliDecompressSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  extractRoutingDataConfigArgument,
  loadRoutingDataConfig,
} from './lib/routing-data-config.mjs';
const MAGIC = 'VHRG';
const FORMAT_NAME = 'via-helvetica-precomputed-binary-routing-graph';
const FORMAT_VERSION = 3;
const HEADER_BYTES = 104;
const GENERATOR_VERSION_OFFSET = 64;
const DATASET_BUILD_ID_OFFSET = 68;
const DATASET_BUILD_ID_BYTES = 32;
const PAYLOAD_CRC32_OFFSET = 100;
const XY_SCALE = 100;
const Z_SCALE = 10;
const COST_SCALE = 10_000;
const NO_ELEVATION = -2_147_483_648;
const COORDINATE_MARGIN_METRES = 6_000;
const MIN_ELEVATION_METRES = -1_000;
const MAX_ELEVATION_METRES = 10_000;
const MIN_ROUTING_COST_FACTOR = 0.45;
const MAX_ROUTING_COST_FACTOR = 4.5;
/** Horizontal node-key precision used by the shared graph compiler, in metres. */
const NODE_HORIZONTAL_PRECISION_METRES = 0.5;
/**
 * Maximum 2D distance change when both endpoints select another representative
 * from their node-identity buckets during deterministic national merging.
 */
const EDGE_ENDPOINT_CANONICALIZATION_ALLOWANCE_METRES =
  2 * Math.SQRT2 * NODE_HORIZONTAL_PRECISION_METRES;
/** Half one fixed-point cost step, covering the generator's rounding error. */
const EDGE_COST_QUANTIZATION_ALLOWANCE = 0.5 / COST_SCALE;
const CELL_SIZE_METRES = 2_400;

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

/** Calculates CRC32 over the binary payload after the fixed header. */
function payloadCrc32(buffer) {
  let crc = 0xffffffff;
  for (let index = HEADER_BYTES; index < buffer.length; index += 1) {
    crc = CRC32_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Calculates lowercase SHA-256 for one complete generated file. */
function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Aligns one binary section offset for 32-bit typed values. */
function align4(value) {
  return Math.ceil(value / 4) * 4;
}

/** Calculates the exact v3 columnar layout with overflow checks. */
function binaryLayout(nodeCount, edgeCount) {
  if (
    !Number.isSafeInteger(nodeCount) ||
    nodeCount < 0 ||
    !Number.isSafeInteger(edgeCount) ||
    edgeCount < 0
  ) {
    throw new Error('Binary routing cell contains invalid record counts.');
  }

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
  const byteLength = align4(offset);

  if (!Number.isSafeInteger(byteLength) || byteLength > 0xffffffff) {
    throw new Error('Binary routing cell exceeds the 32-bit format limit.');
  }

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
    byteLength,
  };
}

/** Resolves the generated release root from CLI or local configuration. */
async function parseDatasetRoot(argv) {
  const {
    configPath,
    configWasExplicit,
    argv: remainingArguments,
  } = extractRoutingDataConfigArgument(argv);
  let root = null;

  if (remainingArguments.length === 2 && remainingArguments[0] === '--root') {
    root = resolve(remainingArguments[1]);
  } else if (remainingArguments.length !== 0) {
    throw new Error(
      'Usage: node verify-routing-dataset.mjs [--config <file>] [--root <dataset-root>]',
    );
  }

  const config = await loadRoutingDataConfig(configPath, {
    optional: !configWasExplicit && root !== null,
  });
  root ??= config.binaryReleaseRoot;

  if (typeof root !== 'string' || root.trim() === '') {
    throw new Error(
      'The release root must be derived from datasetId, formatId, scope, and dataRoot, or supplied with --root.',
    );
  }

  return resolve(root);
}

/** Reads one JSON file with a diagnostic path in parse errors. */
async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read JSON file ${path}: ${error}`);
  }
}

/** Returns the expected grid key encoded in a cell filename. */
function keyFromPath(path) {
  const normalized = path.replaceAll('\\', '/');
  const match = /(?:^|\/)(-?\d+)_(-?\d+)\.bin$/.exec(normalized);
  if (!match) {
    throw new Error(`Invalid raw binary cell path in integrity inventory: ${path}`);
  }
  return `${match[1]}:${match[2]}`;
}

/** Returns the raw relative filename expected for a manifest cell key. */
function rawPathForKey(key) {
  const [column, row] = key.split(':');
  return `cells/${column}_${row}.bin`;
}

/** Reads one uint32 column without requiring host buffer alignment. */
function uint32Column(buffer, offset, count) {
  const result = new Uint32Array(count);
  for (let index = 0; index < count; index += 1) {
    result[index] = buffer.readUInt32LE(offset + index * 4);
  }
  return result;
}

/** Reads one int32 column without requiring host buffer alignment. */
function int32Column(buffer, offset, count) {
  const result = new Int32Array(count);
  for (let index = 0; index < count; index += 1) {
    result[index] = buffer.readInt32LE(offset + index * 4);
  }
  return result;
}

/** Binary-searches a strictly increasing uint32 ID column. */
function findId(ids, value) {
  let low = 0;
  let high = ids.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const candidate = ids[middle];
    if (candidate === value) {
      return middle;
    }
    if (candidate < value) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return -1;
}

/** Verifies one sorted ID column and its dataset-wide range. */
function validateSortedIds(ids, globalCount, label, relativePath) {
  let previous = -1;
  for (const id of ids) {
    if (id >= globalCount || id <= previous) {
      throw new Error(`${relativePath} contains invalid or unsorted ${label} IDs.`);
    }
    previous = id;
  }
}

/**
 * Returns plausible coordinate bounds for a generated cell.
 *
 * Geometry cells retain complete source features without clipping. A feature
 * referenced by one cell can therefore contain nodes elsewhere in the declared
 * dataset extent. The local margin still covers bounded extracts whose retained
 * source features continue slightly beyond the extraction boundary.
 */
function coordinateBounds(key, datasetExtent) {
  const [column, row] = key.split(':').map(Number);
  const minX = column * CELL_SIZE_METRES;
  const minY = row * CELL_SIZE_METRES;
  const localBounds = [
    minX - COORDINATE_MARGIN_METRES,
    minY - COORDINATE_MARGIN_METRES,
    minX + CELL_SIZE_METRES + COORDINATE_MARGIN_METRES,
    minY + CELL_SIZE_METRES + COORDINATE_MARGIN_METRES,
  ];

  return [
    Math.min(datasetExtent[0], localBounds[0]),
    Math.min(datasetExtent[1], localBounds[1]),
    Math.max(datasetExtent[2], localBounds[2]),
    Math.max(datasetExtent[3], localBounds[3]),
  ];
}

/** Rejects coordinates outside the dataset and bounded-extract allowance. */
function coordinateIsValid(x, y, z, bounds) {
  if (x === NO_ELEVATION || y === NO_ELEVATION) {
    return false;
  }

  const xMetres = x / XY_SCALE;
  const yMetres = y / XY_SCALE;
  if (
    xMetres < bounds[0] ||
    yMetres < bounds[1] ||
    xMetres > bounds[2] ||
    yMetres > bounds[3]
  ) {
    return false;
  }

  if (z === NO_ELEVATION) {
    return true;
  }
  const elevation = z / Z_SCALE;
  return elevation >= MIN_ELEVATION_METRES && elevation <= MAX_ELEVATION_METRES;
}

/** Checks that a fixed-point edge cost can come from the pedestrian model. */
function edgeCostIsValid(costValue, startX, startY, endX, endY) {
  const deltaX = (endX - startX) / XY_SCALE;
  const deltaY = (endY - startY) / XY_SCALE;
  const distance = Math.hypot(deltaX, deltaY);
  const cost = costValue / COST_SCALE;

  if (!Number.isFinite(distance) || distance <= 0 || !Number.isFinite(cost)) {
    return false;
  }
  // Costs are compiled before shared nodes receive deterministic canonical
  // coordinates. The stored endpoint distance can therefore differ slightly
  // from the source distance used by the cost model, especially for short edges.
  const minimumSourceDistance = Math.max(
    0,
    distance - EDGE_ENDPOINT_CANONICALIZATION_ALLOWANCE_METRES,
  );
  const maximumSourceDistance =
    distance + EDGE_ENDPOINT_CANONICALIZATION_ALLOWANCE_METRES;

  return (
    cost + EDGE_COST_QUANTIZATION_ALLOWANCE >=
      MIN_ROUTING_COST_FACTOR * minimumSourceDistance &&
    cost - EDGE_COST_QUANTIZATION_ALLOWANCE <=
      MAX_ROUTING_COST_FACTOR * maximumSourceDistance
  );
}

/**
 * Tracks global node and edge values. National releases use compact typed
 * arrays; audit subsets use Maps so they do not allocate against national ID
 * ranges while still checking every shared record present in the subset.
 */
function createConsistencyTracker(manifest) {
  if (manifest.auditSubset === true) {
    const nodes = new Map();
    const edges = new Map();
    return {
      addNode(id, x, y, z, relativePath) {
        const previous = nodes.get(id);
        if (!previous) {
          nodes.set(id, [x, y, z]);
        } else if (previous[0] !== x || previous[1] !== y || previous[2] !== z) {
          throw new Error(`${relativePath} disagrees on global node ${id}.`);
        }
      },
      addEdge(id, startId, endId, cost, flags, relativePath) {
        const previous = edges.get(id);
        if (!previous) {
          edges.set(id, [startId, endId, cost, flags]);
        } else if (
          previous[0] !== startId ||
          previous[1] !== endId ||
          previous[2] !== cost ||
          previous[3] !== flags
        ) {
          throw new Error(`${relativePath} disagrees on global edge ${id}.`);
        }
      },
      finish() {
        return { uniqueNodes: nodes.size, uniqueEdges: edges.size, subset: true };
      },
    };
  }

  const nodeSeen = new Uint8Array(manifest.globalNodeCount);
  const nodeX = new Int32Array(manifest.globalNodeCount);
  const nodeY = new Int32Array(manifest.globalNodeCount);
  const nodeZ = new Int32Array(manifest.globalNodeCount);
  const edgeSeen = new Uint8Array(manifest.globalEdgeCount);
  const edgeStart = new Uint32Array(manifest.globalEdgeCount);
  const edgeEnd = new Uint32Array(manifest.globalEdgeCount);
  const edgeCost = new Uint32Array(manifest.globalEdgeCount);
  const edgeFlags = new Uint8Array(manifest.globalEdgeCount);
  let uniqueNodes = 0;
  let uniqueEdges = 0;

  return {
    addNode(id, x, y, z, relativePath) {
      if (nodeSeen[id] === 0) {
        nodeSeen[id] = 1;
        nodeX[id] = x;
        nodeY[id] = y;
        nodeZ[id] = z;
        uniqueNodes += 1;
      } else if (nodeX[id] !== x || nodeY[id] !== y || nodeZ[id] !== z) {
        throw new Error(`${relativePath} disagrees on global node ${id}.`);
      }
    },
    addEdge(id, startId, endId, cost, flags, relativePath) {
      if (edgeSeen[id] === 0) {
        edgeSeen[id] = 1;
        edgeStart[id] = startId;
        edgeEnd[id] = endId;
        edgeCost[id] = cost;
        edgeFlags[id] = flags;
        uniqueEdges += 1;
      } else if (
        edgeStart[id] !== startId ||
        edgeEnd[id] !== endId ||
        edgeCost[id] !== cost ||
        edgeFlags[id] !== flags
      ) {
        throw new Error(`${relativePath} disagrees on global edge ${id}.`);
      }
    },
    finish() {
      if (
        uniqueNodes !== manifest.globalNodeCount ||
        uniqueEdges !== manifest.globalEdgeCount
      ) {
        throw new Error(
          `Global graph coverage is incomplete: ${uniqueNodes}/${manifest.globalNodeCount} nodes, ` +
            `${uniqueEdges}/${manifest.globalEdgeCount} edges.`,
        );
      }
      return { uniqueNodes, uniqueEdges, subset: false };
    },
  };
}

/** Validates and decodes one complete binary cell for semantic checks. */
function validateBinaryCell(buffer, relativePath, manifest, tracker) {
  if (buffer.length < HEADER_BYTES) {
    throw new Error(`${relativePath} is shorter than the binary header.`);
  }
  if (buffer.toString('ascii', 0, 4) !== MAGIC) {
    throw new Error(`${relativePath} has an invalid magic value.`);
  }
  if (buffer.readUInt16LE(4) !== FORMAT_VERSION) {
    throw new Error(`${relativePath} has an incompatible format version.`);
  }
  if (buffer.readUInt16LE(6) !== HEADER_BYTES) {
    throw new Error(`${relativePath} has an incompatible header size.`);
  }

  const key = `${buffer.readInt32LE(8)}:${buffer.readInt32LE(12)}`;
  if (key !== keyFromPath(relativePath)) {
    throw new Error(`${relativePath} encodes unexpected cell key ${key}.`);
  }

  const nodeCount = buffer.readUInt32LE(16);
  const edgeCount = buffer.readUInt32LE(20);
  const layout = binaryLayout(nodeCount, edgeCount);
  const generatorVersion = buffer.readUInt32LE(GENERATOR_VERSION_OFFSET);
  const datasetBuildId = buffer
    .subarray(
      DATASET_BUILD_ID_OFFSET,
      DATASET_BUILD_ID_OFFSET + DATASET_BUILD_ID_BYTES,
    )
    .toString('hex');

  if (
    buffer.readUInt32LE(28) !== XY_SCALE ||
    buffer.readUInt32LE(32) !== Z_SCALE ||
    buffer.readUInt32LE(36) !== COST_SCALE ||
    buffer.readUInt32LE(40) !== layout.nodeIdsOffset ||
    buffer.readUInt32LE(44) !== layout.edgeIdsOffset ||
    buffer.readUInt32LE(48) !== layout.edgeFlagsOffset ||
    buffer.readUInt32LE(52) !== layout.byteLength ||
    buffer.length !== layout.byteLength ||
    buffer.readUInt32LE(56) !== manifest.globalNodeCount ||
    buffer.readUInt32LE(60) !== manifest.globalEdgeCount ||
    generatorVersion !== manifest.generatorVersion ||
    datasetBuildId !== manifest.datasetBuildId
  ) {
    throw new Error(`${relativePath} does not match the v3 dataset contract.`);
  }

  const expectedCrc32 = buffer.readUInt32LE(PAYLOAD_CRC32_OFFSET);
  if (expectedCrc32 !== payloadCrc32(buffer)) {
    throw new Error(`${relativePath} has an invalid payload CRC32.`);
  }

  const nodeIds = uint32Column(buffer, layout.nodeIdsOffset, nodeCount);
  const nodeX = int32Column(buffer, layout.nodeXOffset, nodeCount);
  const nodeY = int32Column(buffer, layout.nodeYOffset, nodeCount);
  const nodeZ = int32Column(buffer, layout.nodeZOffset, nodeCount);
  const edgeIds = uint32Column(buffer, layout.edgeIdsOffset, edgeCount);
  const edgeStart = uint32Column(buffer, layout.edgeStartOffset, edgeCount);
  const edgeEnd = uint32Column(buffer, layout.edgeEndOffset, edgeCount);
  const edgeCost = uint32Column(buffer, layout.edgeCostOffset, edgeCount);
  const edgeFlags = buffer.subarray(layout.edgeFlagsOffset, layout.edgeFlagsOffset + edgeCount);

  validateSortedIds(nodeIds, manifest.globalNodeCount, 'node', relativePath);
  validateSortedIds(edgeIds, manifest.globalEdgeCount, 'edge', relativePath);
  const bounds = coordinateBounds(key, manifest.extent);

  for (let index = 0; index < nodeCount; index += 1) {
    if (!coordinateIsValid(nodeX[index], nodeY[index], nodeZ[index], bounds)) {
      throw new Error(`${relativePath} contains an invalid coordinate.`);
    }
    tracker.addNode(nodeIds[index], nodeX[index], nodeY[index], nodeZ[index], relativePath);
  }

  for (let index = 0; index < edgeCount; index += 1) {
    const startId = edgeStart[index];
    const endId = edgeEnd[index];
    const startIndex = findId(nodeIds, startId);
    const endIndex = findId(nodeIds, endId);
    const flags = edgeFlags[index];
    if (
      startId === endId ||
      startIndex < 0 ||
      endIndex < 0 ||
      edgeCost[index] === 0 ||
      flags > 1 ||
      !edgeCostIsValid(
        edgeCost[index],
        nodeX[startIndex],
        nodeY[startIndex],
        nodeX[endIndex],
        nodeY[endIndex],
      )
    ) {
      throw new Error(
        `${relativePath} contains invalid edge ${edgeIds[index]} at record ${index}.`,
      );
    }
    tracker.addEdge(
      edgeIds[index],
      startId,
      endId,
      edgeCost[index],
      flags,
      relativePath,
    );
  }
}

/** Recomputes the release identity from the manifest provenance contract. */
function expectedDatasetBuildId(manifest) {
  const contract = {
    format: manifest.format,
    formatVersion: manifest.version,
    generatorVersion: manifest.generatorVersion,
    costModelVersion: manifest.costModelVersion,
    scope: manifest.scope,
    projection: manifest.projection,
    cellSizeMetres: manifest.cellSizeMetres,
    extent: manifest.extent,
    sourceGeometryFormat: manifest.sourceGeometryFormat,
    sourceGeometryFormatVersion: manifest.sourceGeometryFormatVersion,
    sourceDatasetVersion: manifest.sourceDatasetVersion,
    sourceSha256: manifest.sourceSha256,
    sourceSizeBytes: manifest.sourceSizeBytes,
    sourceLayer: manifest.sourceLayer,
    sourceCellKeyOrderSha256: manifest.sourceCellKeyOrderSha256,
    sourceCellCount: manifest.sourceGeometryCellCount,
    sourceGeometryBytes: manifest.sourceGeometryCellBytes,
    sourceRoadFeatureCount: manifest.sourceRoadFeatureCount,
    sourceRoadFeatureReferenceCount:
      manifest.sourceRoadFeatureReferenceCount,
    sourceCellAssignment: manifest.sourceCellAssignment,
    sourceGeometryParseErrors: manifest.sourceGeometryParseErrors,
    globalNodeCount: manifest.globalNodeCount,
    globalEdgeCount: manifest.globalEdgeCount,
  };

  return sha256(Buffer.from(JSON.stringify(contract), 'utf8'));
}

/** Validates the manifest fields that define one immutable release. */
function validateManifest(manifest) {
  if (
    manifest.version !== FORMAT_VERSION ||
    manifest.format !== FORMAT_NAME ||
    typeof manifest.scope !== 'string' ||
    manifest.scope.trim() === '' ||
    manifest.projection !== 'EPSG:2056' ||
    manifest.headerBytes !== HEADER_BYTES ||
    manifest.cellSizeMetres !== CELL_SIZE_METRES ||
    manifest.coordinateScalePerMetre !== XY_SCALE ||
    manifest.elevationScalePerMetre !== Z_SCALE ||
    manifest.costScalePerUnit !== COST_SCALE ||
    manifest.payloadChecksum !== 'crc32' ||
    manifest.costModelVersion !== 1 ||
    manifest.coordinateValidationMarginMetres !== COORDINATE_MARGIN_METRES ||
    manifest.cellPathTemplate !== 'cells/{column}_{row}.bin' ||
    manifest.integrityPath !== 'integrity.json' ||
    !Array.isArray(manifest.extent) ||
    manifest.extent.length !== 4 ||
    manifest.extent.some((value) => !Number.isFinite(value)) ||
    manifest.extent[0] >= manifest.extent[2] ||
    manifest.extent[1] >= manifest.extent[3] ||
    !Number.isInteger(manifest.generatorVersion) ||
    manifest.generatorVersion <= 0 ||
    typeof manifest.datasetBuildId !== 'string' ||
    !/^[0-9a-f]{64}$/.test(manifest.datasetBuildId) ||
    typeof manifest.sourceGeometryFormat !== 'string' ||
    !Number.isInteger(manifest.sourceGeometryFormatVersion) ||
    typeof manifest.sourceDatasetVersion !== 'string' ||
    typeof manifest.sourceSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(manifest.sourceSha256) ||
    !Number.isSafeInteger(manifest.sourceSizeBytes) ||
    manifest.sourceSizeBytes <= 0 ||
    typeof manifest.sourceLayer !== 'string' ||
    typeof manifest.sourceCellKeyOrderSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(manifest.sourceCellKeyOrderSha256) ||
    !Number.isInteger(manifest.sourceGeometryCellCount) ||
    manifest.sourceGeometryCellCount <= 0 ||
    !Number.isSafeInteger(manifest.sourceGeometryCellBytes) ||
    manifest.sourceGeometryCellBytes <= 0 ||
    !Number.isSafeInteger(manifest.sourceRoadFeatureCount) ||
    manifest.sourceRoadFeatureCount <= 0 ||
    !Number.isSafeInteger(manifest.sourceRoadFeatureReferenceCount) ||
    manifest.sourceRoadFeatureReferenceCount <
      manifest.sourceRoadFeatureCount ||
    typeof manifest.sourceCellAssignment !== 'string' ||
    !Number.isSafeInteger(manifest.sourceGeometryParseErrors) ||
    manifest.sourceGeometryParseErrors < 0 ||
    !Number.isInteger(manifest.globalNodeCount) ||
    manifest.globalNodeCount <= 0 ||
    !Number.isInteger(manifest.globalEdgeCount) ||
    manifest.globalEdgeCount <= 0 ||
    !Number.isInteger(manifest.nonEmptyCellCount) ||
    !Array.isArray(manifest.nonEmptyCellKeys)
  ) {
    throw new Error('Binary routing manifest is missing or incompatible.');
  }

  if (expectedDatasetBuildId(manifest) !== manifest.datasetBuildId) {
    throw new Error(
      'Binary routing manifest provenance does not match its dataset build ID.',
    );
  }

  const keySet = new Set(manifest.nonEmptyCellKeys);
  if (
    keySet.size !== manifest.nonEmptyCellKeys.length ||
    manifest.nonEmptyCellCount !== manifest.nonEmptyCellKeys.length ||
    manifest.nonEmptyCellKeys.some(
      (key) => typeof key !== 'string' || !/^-?\d+:-?\d+$/.test(key),
    )
  ) {
    throw new Error('Binary routing manifest contains invalid or duplicate cell keys.');
  }
  return keySet;
}

/** Runs the complete immutable-release verification. */
async function main() {
  const datasetRoot = await parseDatasetRoot(process.argv.slice(2));
  const [manifest, integrity] = await Promise.all([
    readJson(join(datasetRoot, 'manifest.json')),
    readJson(join(datasetRoot, 'integrity.json')),
  ]);
  const manifestKeys = validateManifest(manifest);

  if (
    integrity.version !== 1 ||
    integrity.algorithm !== 'sha256' ||
    integrity.datasetManifest !== 'manifest.json' ||
    !Array.isArray(integrity.files) ||
    integrity.fileCount !== integrity.files.length
  ) {
    throw new Error('Routing integrity inventory is missing or incompatible.');
  }

  const integrityByPath = new Map();
  for (const entry of integrity.files) {
    const path = typeof entry?.path === 'string' ? entry.path.replaceAll('\\', '/') : null;
    if (
      !path ||
      !Number.isSafeInteger(entry?.sizeBytes) ||
      entry.sizeBytes < 0 ||
      typeof entry?.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(entry.sha256) ||
      integrityByPath.has(path)
    ) {
      throw new Error('Routing integrity inventory contains an invalid entry.');
    }
    integrityByPath.set(path, { ...entry, path });
  }

  const expectedPaths = new Set();
  for (const key of manifestKeys) {
    const rawPath = rawPathForKey(key);
    expectedPaths.add(rawPath);
    expectedPaths.add(`${rawPath}.br`);
  }
  if (
    expectedPaths.size !== integrityByPath.size ||
    [...expectedPaths].some((path) => !integrityByPath.has(path)) ||
    [...integrityByPath.keys()].some((path) => !expectedPaths.has(path))
  ) {
    throw new Error('Manifest cell keys and integrity file paths do not match exactly.');
  }

  const rawPaths = [...manifestKeys].map(rawPathForKey).sort();
  const tracker = createConsistencyTracker(manifest);
  let rawBytes = 0;
  let brotliBytes = 0;
  let verified = 0;

  for (const rawPath of rawPaths) {
    const compressedPath = `${rawPath}.br`;
    const rawEntry = integrityByPath.get(rawPath);
    const compressedEntry = integrityByPath.get(compressedPath);
    const [raw, compressed] = await Promise.all([
      readFile(join(datasetRoot, rawPath)),
      readFile(join(datasetRoot, compressedPath)),
    ]);

    for (const [buffer, entry] of [
      [raw, rawEntry],
      [compressed, compressedEntry],
    ]) {
      if (buffer.length !== entry.sizeBytes || sha256(buffer) !== entry.sha256) {
        throw new Error(`Integrity mismatch for ${entry.path}.`);
      }
    }

    validateBinaryCell(raw, rawPath, manifest, tracker);
    if (!brotliDecompressSync(compressed).equals(raw)) {
      throw new Error(`${compressedPath} does not reproduce ${rawPath}.`);
    }

    rawBytes += raw.length;
    brotliBytes += compressed.length;
    verified += 1;
    if (verified % 250 === 0) {
      console.log(`Verified ${verified}/${rawPaths.length} binary cells...`);
    }
  }

  const consistency = tracker.finish();
  if (
    rawBytes !== manifest.uncompressedCellBytes ||
    brotliBytes !== manifest.brotliCellBytes
  ) {
    throw new Error('Verified byte totals do not match the manifest.');
  }

  console.log(
    `Verified ${verified} routing cells and ${integrity.files.length} immutable files.`,
  );
  console.log(
    `Raw: ${(rawBytes / 1024 / 1024).toFixed(2)} MiB; ` +
      `Brotli: ${(brotliBytes / 1024 / 1024).toFixed(2)} MiB.`,
  );
  console.log(
    consistency.subset
      ? `Subset graph: ${consistency.uniqueNodes} shared nodes, ${consistency.uniqueEdges} shared edges.`
      : `Graph: ${consistency.uniqueNodes} nodes, ${consistency.uniqueEdges} edges.`,
  );
  console.log(`Dataset build ID: ${manifest.datasetBuildId}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
