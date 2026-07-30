/**
 * Business context: converts validated Geneva precomputed JSON cells into a
 * compact binary graph with global integer node and edge identifiers. Logical
 * cell overlap is preserved so every corridor remains equivalent to the JSON
 * reference, while numeric IDs make runtime deduplication cheap and avoid
 * rebuilding coordinate-derived string keys.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const SOURCE_ROOT = join(ROOT, 'public', 'routing-data', 'geneva-precomputed');
const STATIC_MANIFEST_PATH = join(
  ROOT,
  'public',
  'routing-data',
  'geneva',
  'manifest.json',
);
const OUTPUT_ROOT = join(
  ROOT,
  'public',
  'routing-data',
  'geneva-precomputed-binary',
);
const OUTPUT_CELLS = join(OUTPUT_ROOT, 'cells');
const TEMP_ROOT = join(ROOT, '.tmp-precomputed-binary-routing-compiler');
const COMPILER_SOURCE = join(
  ROOT,
  'src',
  'routing',
  'precomputedRoutingGraph.ts',
);

const FORMAT_NAME = 'via-helvetica-precomputed-binary-routing-graph';
const FORMAT_VERSION = 2;
const MAGIC = Buffer.from('VHRG', 'ascii');
const HEADER_BYTES = 68;
const XY_SCALE = 100;
const Z_SCALE = 10;
const COST_SCALE = 10_000;
const NO_ELEVATION = -2_147_483_648;
const PAYLOAD_CRC32_OFFSET = 64;
const PAYLOAD_CHECKSUM = 'crc32';
const COORDINATE_VALIDATION_MARGIN_METRES = 2_400;
const COST_MODEL_VERSION = 1;
const BROTLI_QUALITY = 6;

/** Reads and parses one UTF-8 JSON file. */
async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
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

/** Transpiles the shared node-key function instead of duplicating quantization. */
async function loadSharedCompiler() {
  const require = createRequire(import.meta.url);
  let command = 'tsc';
  let commandPrefix = [];

  try {
    const typescriptPackage = require.resolve('typescript/package.json');
    command = process.execPath;
    commandPrefix = [join(dirname(typescriptPackage), 'bin', 'tsc')];
  } catch {
    // A globally installed TypeScript compiler keeps generation available when
    // the npm registry cannot restore the project dependencies.
  }

  await rm(TEMP_ROOT, { recursive: true, force: true });
  await mkdir(TEMP_ROOT, { recursive: true });

  const compiledRoot = join(TEMP_ROOT, 'compiled');
  const compilerConfigPath = join(TEMP_ROOT, 'tsconfig.json');
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
        files: [COMPILER_SOURCE],
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
      `Shared node-key compiler transpilation failed.\n${result.stdout}${result.stderr}`,
    );
  }

  const compilerPath = join(compiledRoot, 'precomputedRoutingGraph.js');
  return import(`${pathToFileURL(compilerPath).href}?generated=${Date.now()}`);
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
) {
  const [column, row] = key.split(':').map(Number);
  const layout = binaryLayout(nodeRecords.length, edgeRecords.length);
  const buffer = Buffer.alloc(layout.byteLength);

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

async function main() {
  const [sourceManifest, staticManifest, { precomputedNodeKey }] =
    await Promise.all([
      readJson(join(SOURCE_ROOT, 'manifest.json')),
      readJson(STATIC_MANIFEST_PATH),
      loadSharedCompiler(),
    ]);

  if (
    sourceManifest.version !== 1 ||
    sourceManifest.format !== 'via-helvetica-precomputed-routing-graph' ||
    !Array.isArray(sourceManifest.nonEmptyCellKeys)
  ) {
    throw new Error('Precomputed Geneva JSON manifest is missing or incompatible.');
  }

  const nodesByKey = new Map();
  const edgesByKey = new Map();
  const sourceCells = [];

  for (const key of sourceManifest.nonEmptyCellKeys) {
    const [column, row] = key.split(':');
    const cell = await readJson(
      join(SOURCE_ROOT, 'cells', `${column}_${row}.json`),
    );

    if (
      cell.v !== sourceManifest.version ||
      cell.k !== key ||
      !Array.isArray(cell.n) ||
      !Array.isArray(cell.s) ||
      !Number.isInteger(cell.f) ||
      cell.f < 0
    ) {
      throw new Error(`Precomputed JSON cell ${key} is invalid.`);
    }

    const localNodeKeys = cell.n.map((coordinate) => {
      const nodeKey = precomputedNodeKey(coordinate);
      const existingCoordinate = nodesByKey.get(nodeKey);

      if (existingCoordinate) {
        const difference = Math.max(
          Math.abs(existingCoordinate[0] - coordinate[0]),
          Math.abs(existingCoordinate[1] - coordinate[1]),
          Math.abs((existingCoordinate[2] ?? 0) - (coordinate[2] ?? 0)),
        );
        if (difference > 1e-9) {
          throw new Error(`Global node ${nodeKey} has conflicting coordinates.`);
        }
      } else {
        nodesByKey.set(nodeKey, coordinate);
      }

      return nodeKey;
    });
    const segments = [];

    for (const segment of cell.s) {
      const [startIndex, endIndex, cost, hikingFlag = 0] = segment;
      const startNodeKey = localNodeKeys[startIndex];
      const endNodeKey = localNodeKeys[endIndex];

      if (
        startNodeKey === undefined ||
        endNodeKey === undefined ||
        !Number.isFinite(cost) ||
        cost <= 0 ||
        (hikingFlag !== 0 && hikingFlag !== 1)
      ) {
        throw new Error(`Precomputed JSON cell ${key} has an invalid segment.`);
      }

      const identity = edgeKey(startNodeKey, endNodeKey);
      const candidate = {
        startNodeKey,
        endNodeKey,
        cost,
        isHikingTrail: hikingFlag === 1,
      };
      const existing = edgesByKey.get(identity);

      if (existing) {
        if (
          Math.abs(existing.cost - candidate.cost) > 1e-9 ||
          existing.isHikingTrail !== candidate.isHikingTrail
        ) {
          throw new Error(
            `Duplicate edge ${identity} has inconsistent routing metadata.`,
          );
        }
      } else {
        edgesByKey.set(identity, candidate);
      }

      segments.push(identity);
    }

    sourceCells.push({
      key,
      sourceRoadFeatures: cell.f,
      nodeKeys: [...new Set(localNodeKeys)],
      edgeKeys: [...new Set(segments)],
    });
  }

  // Preserve the reference JSON insertion order so equal-cost A* ties expand
  // nodes and edges in the same deterministic order in both implementations.
  const globalNodeKeys = [...nodesByKey.keys()];
  const nodeIdByKey = new Map(
    globalNodeKeys.map((key, index) => [key, index]),
  );
  const globalEdgeKeys = [...edgesByKey.keys()];
  const edgeIdByKey = new Map(
    globalEdgeKeys.map((key, index) => [key, index]),
  );

  await rm(OUTPUT_ROOT, { recursive: true, force: true });
  await mkdir(OUTPUT_CELLS, { recursive: true });

  let uncompressedCellBytes = 0;
  let brotliCellBytes = 0;
  let totalNodeReferences = 0;
  let totalEdgeReferences = 0;
  let hikingEdgeReferences = 0;

  for (const sourceCell of sourceCells) {
    const [column, row] = sourceCell.key.split(':');
    const nodeRecords = sourceCell.nodeKeys
      .map((key) => ({
        id: nodeIdByKey.get(key),
        coordinate: nodesByKey.get(key),
      }));
    const edgeRecords = sourceCell.edgeKeys
      .map((key) => {
        const edge = edgesByKey.get(key);
        return {
          id: edgeIdByKey.get(key),
          startId: nodeIdByKey.get(edge.startNodeKey),
          endId: nodeIdByKey.get(edge.endNodeKey),
          cost: edge.cost,
          isHikingTrail: edge.isHikingTrail,
        };
      });
    const encoded = encodeCell(
      sourceCell.key,
      nodeRecords,
      edgeRecords,
      sourceCell.sourceRoadFeatures,
      globalNodeKeys.length,
      globalEdgeKeys.length,
    );
    const compressed = brotliCompressSync(encoded, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
      },
    });

    await writeFile(join(OUTPUT_CELLS, `${column}_${row}.bin`), encoded);
    await writeFile(join(OUTPUT_CELLS, `${column}_${row}.bin.br`), compressed);

    uncompressedCellBytes += encoded.byteLength;
    brotliCellBytes += compressed.byteLength;
    totalNodeReferences += nodeRecords.length;
    totalEdgeReferences += edgeRecords.length;
    hikingEdgeReferences += edgeRecords.filter((edge) => edge.isHikingTrail).length;
  }

  const manifest = {
    version: FORMAT_VERSION,
    format: FORMAT_NAME,
    projection: 'EPSG:2056',
    cellSizeMetres: sourceManifest.cellSizeMetres,
    extent: sourceManifest.extent,
    cellPathTemplate: 'cells/{column}_{row}.bin',
    precompressedCellPathTemplate: 'cells/{column}_{row}.bin.br',
    nonEmptyCellCount: sourceCells.length,
    nonEmptyCellKeys: sourceCells.map((cell) => cell.key),
    headerBytes: HEADER_BYTES,
    coordinateScalePerMetre: XY_SCALE,
    elevationScalePerMetre: Z_SCALE,
    costScalePerUnit: COST_SCALE,
    payloadChecksum: PAYLOAD_CHECKSUM,
    coordinateValidationMarginMetres: COORDINATE_VALIDATION_MARGIN_METRES,
    costModelVersion: COST_MODEL_VERSION,
    globalNodeCount: globalNodeKeys.length,
    globalEdgeCount: globalEdgeKeys.length,
    totalNodeReferences,
    totalEdgeReferences,
    hikingEdgeReferences,
    uncompressedCellBytes,
    brotliCellBytes,
    sourcePrecomputedFormatVersion: sourceManifest.version,
    sourceGeometryFormatVersion: staticManifest.version,
    sourceFiles: staticManifest.sourceFiles,
    sourceRoadFeatureCount: staticManifest.roadFeatureCountBeforeCellDuplication,
    edgeOwnership: 'global-id-with-logical-cell-references',
    nodeIdentity: 'shared-compiler-quantized-xyz',
  };

  await writeFile(
    join(OUTPUT_ROOT, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  await rm(TEMP_ROOT, { recursive: true, force: true });

  console.log(
    `Generated ${sourceCells.length} binary Geneva cells from ` +
      `${globalNodeKeys.length} global nodes and ${globalEdgeKeys.length} global edges.`,
  );
  console.log(
    `Raw binary size: ${(uncompressedCellBytes / 1024 / 1024).toFixed(2)} MiB.`,
  );
  console.log(
    `Brotli size: ${(brotliCellBytes / 1024 / 1024).toFixed(2)} MiB.`,
  );
  console.log(
    `Logical references: ${totalNodeReferences} nodes, ${totalEdgeReferences} edges.`,
  );
}

main().catch(async (error) => {
  await rm(TEMP_ROOT, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
