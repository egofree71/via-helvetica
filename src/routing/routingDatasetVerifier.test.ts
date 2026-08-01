// @vitest-environment node
/**
 * Business context: protects the offline publication gate against complete but
 * inconsistent routing releases that per-file hashes alone cannot detect.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PRECOMPUTED_BINARY_COST_SCALE,
  PRECOMPUTED_BINARY_DATASET_BUILD_ID_OFFSET,
  PRECOMPUTED_BINARY_FORMAT,
  PRECOMPUTED_BINARY_FORMAT_VERSION,
  PRECOMPUTED_BINARY_GENERATOR_VERSION_OFFSET,
  PRECOMPUTED_BINARY_HEADER_BYTES,
  PRECOMPUTED_BINARY_MAGIC,
  PRECOMPUTED_BINARY_PAYLOAD_CRC32_OFFSET,
  PRECOMPUTED_BINARY_XY_SCALE,
  PRECOMPUTED_BINARY_Z_SCALE,
  precomputedBinaryBuildIdFromHex,
  precomputedBinaryCrc32,
  precomputedBinaryLayout,
} from './precomputedBinaryRoutingFormat';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const VERIFIER = join(ROOT, 'scripts', 'verify-routing-dataset.mjs');
const GENERATOR_VERSION = 4;
const temporaryRoots: string[] = [];

interface CellFixture {
  key: `${number}:${number}`;
  nodeIds: number[];
  coordinates: Array<[number, number, number]>;
  edgeIds: number[];
  edges: Array<{
    startId: number;
    endId: number;
    cost: number;
    hiking: boolean;
  }>;
}

function sha256(buffer: Uint8Array): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function encodeCell(
  fixture: CellFixture,
  globalNodeCount: number,
  globalEdgeCount: number,
  datasetBuildId: string,
): Buffer {
  const layout = precomputedBinaryLayout(
    fixture.nodeIds.length,
    fixture.edgeIds.length,
  );
  const buffer = Buffer.alloc(layout.byteLength);
  buffer.write(PRECOMPUTED_BINARY_MAGIC, 0, 'ascii');
  const [column, row] = fixture.key.split(':').map(Number);
  buffer.writeUInt16LE(PRECOMPUTED_BINARY_FORMAT_VERSION, 4);
  buffer.writeUInt16LE(PRECOMPUTED_BINARY_HEADER_BYTES, 6);
  buffer.writeInt32LE(column, 8);
  buffer.writeInt32LE(row, 12);
  buffer.writeUInt32LE(fixture.nodeIds.length, 16);
  buffer.writeUInt32LE(fixture.edgeIds.length, 20);
  buffer.writeUInt32LE(1, 24);
  buffer.writeUInt32LE(PRECOMPUTED_BINARY_XY_SCALE, 28);
  buffer.writeUInt32LE(PRECOMPUTED_BINARY_Z_SCALE, 32);
  buffer.writeUInt32LE(PRECOMPUTED_BINARY_COST_SCALE, 36);
  buffer.writeUInt32LE(layout.nodeIdsOffset, 40);
  buffer.writeUInt32LE(layout.edgeIdsOffset, 44);
  buffer.writeUInt32LE(layout.edgeFlagsOffset, 48);
  buffer.writeUInt32LE(layout.byteLength, 52);
  buffer.writeUInt32LE(globalNodeCount, 56);
  buffer.writeUInt32LE(globalEdgeCount, 60);
  buffer.writeUInt32LE(
    GENERATOR_VERSION,
    PRECOMPUTED_BINARY_GENERATOR_VERSION_OFFSET,
  );
  buffer.set(
    precomputedBinaryBuildIdFromHex(datasetBuildId),
    PRECOMPUTED_BINARY_DATASET_BUILD_ID_OFFSET,
  );

  for (let index = 0; index < fixture.nodeIds.length; index += 1) {
    const coordinate = fixture.coordinates[index];
    buffer.writeUInt32LE(
      fixture.nodeIds[index],
      layout.nodeIdsOffset + index * 4,
    );
    buffer.writeInt32LE(
      Math.round(coordinate[0] * PRECOMPUTED_BINARY_XY_SCALE),
      layout.nodeXOffset + index * 4,
    );
    buffer.writeInt32LE(
      Math.round(coordinate[1] * PRECOMPUTED_BINARY_XY_SCALE),
      layout.nodeYOffset + index * 4,
    );
    buffer.writeInt32LE(
      Math.round(coordinate[2] * PRECOMPUTED_BINARY_Z_SCALE),
      layout.nodeZOffset + index * 4,
    );
  }

  for (let index = 0; index < fixture.edgeIds.length; index += 1) {
    const edge = fixture.edges[index];
    buffer.writeUInt32LE(
      fixture.edgeIds[index],
      layout.edgeIdsOffset + index * 4,
    );
    buffer.writeUInt32LE(edge.startId, layout.edgeStartOffset + index * 4);
    buffer.writeUInt32LE(edge.endId, layout.edgeEndOffset + index * 4);
    buffer.writeUInt32LE(
      Math.round(edge.cost * PRECOMPUTED_BINARY_COST_SCALE),
      layout.edgeCostOffset + index * 4,
    );
    buffer.writeUInt8(edge.hiking ? 1 : 0, layout.edgeFlagsOffset + index);
  }

  buffer.writeUInt32LE(
    precomputedBinaryCrc32(
      buffer,
      PRECOMPUTED_BINARY_HEADER_BYTES,
    ),
    PRECOMPUTED_BINARY_PAYLOAD_CRC32_OFFSET,
  );
  return buffer;
}

function createDatasetBuildId(
  sourceCellKeyOrderSha256: string,
  sourceGeometryCellCount: number,
  globalNodeCount: number,
  globalEdgeCount: number,
  extent: [number, number, number, number],
): string {
  const contract = {
    format: PRECOMPUTED_BINARY_FORMAT,
    formatVersion: PRECOMPUTED_BINARY_FORMAT_VERSION,
    generatorVersion: GENERATOR_VERSION,
    costModelVersion: 1,
    scope: 'test',
    projection: 'EPSG:2056',
    cellSizeMetres: 2_400,
    extent,
    sourceGeometryFormat: 'via-helvetica-static-routing-geometry',
    sourceGeometryFormatVersion: 2,
    sourceDatasetVersion: 'SWISSTLM3D_TEST',
    sourceSha256: '55'.repeat(32),
    sourceSizeBytes: 10_000,
    sourceLayer: 'tlm_strassen_strasse',
    sourceCellKeyOrderSha256,
    sourceCellCount: sourceGeometryCellCount,
    sourceGeometryBytes: 5_000,
    sourceRoadFeatureCount: 2,
    sourceRoadFeatureReferenceCount: 3,
    sourceCellAssignment: 'full-feature-bbox-overlap-no-clipping',
    sourceGeometryParseErrors: 0,
    globalNodeCount,
    globalEdgeCount,
  };
  return createHash('sha256')
    .update(JSON.stringify(contract))
    .digest('hex');
}

async function createDataset(
  cells: CellFixture[],
  globalNodeCount: number,
  globalEdgeCount: number,
  extent: [number, number, number, number] = [
    2_498_400, 1_116_000, 2_503_200, 1_118_400,
  ],
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'via-helvetica-verifier-'));
  temporaryRoots.push(root);
  await mkdir(join(root, 'cells'), { recursive: true });

  const files: Array<{ path: string; sizeBytes: number; sha256: string }> = [];
  let rawBytes = 0;
  let brotliBytes = 0;
  const sourceCellKeyOrderSha256 = createHash('sha256')
    .update(JSON.stringify(cells.map((cell) => cell.key)))
    .digest('hex');
  const datasetBuildId = createDatasetBuildId(
    sourceCellKeyOrderSha256,
    cells.length,
    globalNodeCount,
    globalEdgeCount,
    extent,
  );

  for (const fixture of cells) {
    const raw = encodeCell(
      fixture,
      globalNodeCount,
      globalEdgeCount,
      datasetBuildId,
    );
    const compressed = brotliCompressSync(raw);
    const filename = fixture.key.replace(':', '_');
    const rawPath = `cells/${filename}.bin`;
    const brotliPath = `${rawPath}.br`;
    await Promise.all([
      writeFile(join(root, rawPath), raw),
      writeFile(join(root, brotliPath), compressed),
    ]);
    files.push(
      { path: rawPath, sizeBytes: raw.length, sha256: sha256(raw) },
      {
        path: brotliPath,
        sizeBytes: compressed.length,
        sha256: sha256(compressed),
      },
    );
    rawBytes += raw.length;
    brotliBytes += compressed.length;
  }

  const manifest = {
    version: PRECOMPUTED_BINARY_FORMAT_VERSION,
    format: PRECOMPUTED_BINARY_FORMAT,
    generatorVersion: GENERATOR_VERSION,
    datasetBuildId,
    scope: 'test',
    projection: 'EPSG:2056',
    cellSizeMetres: 2_400,
    extent,
    cellPathTemplate: 'cells/{column}_{row}.bin',
    integrityPath: 'integrity.json',
    nonEmptyCellCount: cells.length,
    nonEmptyCellKeys: cells.map((cell) => cell.key),
    headerBytes: PRECOMPUTED_BINARY_HEADER_BYTES,
    coordinateScalePerMetre: PRECOMPUTED_BINARY_XY_SCALE,
    elevationScalePerMetre: PRECOMPUTED_BINARY_Z_SCALE,
    costScalePerUnit: PRECOMPUTED_BINARY_COST_SCALE,
    payloadChecksum: 'crc32',
    coordinateValidationMarginMetres: 6_000,
    costModelVersion: 1,
    globalNodeCount,
    globalEdgeCount,
    sourceGeometryFormat: 'via-helvetica-static-routing-geometry',
    sourceGeometryFormatVersion: 2,
    sourceDatasetVersion: 'SWISSTLM3D_TEST',
    sourceSha256: '55'.repeat(32),
    sourceSizeBytes: 10_000,
    sourceLayer: 'tlm_strassen_strasse',
    sourceCellKeyOrderSha256,
    sourceGeometryCellCount: cells.length,
    sourceGeometryCellBytes: 5_000,
    sourceRoadFeatureCount: 2,
    sourceRoadFeatureReferenceCount: 3,
    sourceCellAssignment: 'full-feature-bbox-overlap-no-clipping',
    sourceGeometryParseErrors: 0,
    uncompressedCellBytes: rawBytes,
    brotliCellBytes: brotliBytes,
  };
  const integrity = {
    version: 1,
    algorithm: 'sha256',
    datasetManifest: 'manifest.json',
    fileCount: files.length,
    files,
  };

  await Promise.all([
    writeFile(join(root, 'manifest.json'), JSON.stringify(manifest)),
    writeFile(join(root, 'integrity.json'), JSON.stringify(integrity)),
  ]);
  return root;
}

function verify(root: string) {
  return spawnSync(process.execPath, [VERIFIER, '--root', root], {
    encoding: 'utf8',
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe('national routing dataset verifier', () => {
  it('accepts a complete internally consistent v3 release', async () => {
    const root = await createDataset(
      [
        {
          key: '1041:465',
          nodeIds: [0, 1],
          coordinates: [
            [2_499_000, 1_117_000, 410],
            [2_499_100, 1_117_100, 412],
          ],
          edgeIds: [0],
          edges: [
            { startId: 0, endId: 1, cost: 141.5, hiking: true },
          ],
        },
      ],
      2,
      1,
    );

    const result = verify(root);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Verified 1 routing cells');
  });

  it('accepts complete source geometry elsewhere in the dataset extent', async () => {
    const root = await createDataset(
      [
        {
          key: '1041:465',
          nodeIds: [0, 1],
          coordinates: [
            [2_520_000, 1_117_000, 410],
            [2_520_100, 1_117_000, 412],
          ],
          edgeIds: [0],
          edges: [
            { startId: 0, endId: 1, cost: 100, hiking: true },
          ],
        },
      ],
      2,
      1,
      [2_476_800, 1_101_600, 2_522_400, 1_142_400],
    );

    const result = verify(root);
    expect(result.status).toBe(0);
  });

  it('accepts a minimum-cost edge after shared-node canonicalization', async () => {
    const root = await createDataset(
      [
        {
          key: '1041:465',
          nodeIds: [0, 1],
          coordinates: [
            [2_499_000, 1_117_000, 410],
            [2_499_000.81, 1_116_999.41, 410],
          ],
          edgeIds: [0],
          edges: [
            { startId: 0, endId: 1, cost: 0.4499, hiking: true },
          ],
        },
      ],
      2,
      1,
    );

    const result = verify(root);
    expect(result.status).toBe(0);
  });

  it('rejects a manifest whose key set differs from the inventory', async () => {
    const root = await createDataset(
      [
        {
          key: '1041:465',
          nodeIds: [0, 1],
          coordinates: [
            [2_499_000, 1_117_000, 410],
            [2_499_100, 1_117_100, 412],
          ],
          edgeIds: [0],
          edges: [
            { startId: 0, endId: 1, cost: 141.5, hiking: false },
          ],
        },
      ],
      2,
      1,
    );
    const manifestPath = join(root, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.nonEmptyCellKeys = ['1042:465'];
    await writeFile(manifestPath, JSON.stringify(manifest));

    const result = verify(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('do not match exactly');
  });

  it('rejects conflicting values for a shared global node', async () => {
    const root = await createDataset(
      [
        {
          key: '1041:465',
          nodeIds: [0, 1],
          coordinates: [
            [2_500_800, 1_117_000, 410],
            [2_500_700, 1_117_100, 412],
          ],
          edgeIds: [0],
          edges: [
            { startId: 0, endId: 1, cost: 141.5, hiking: true },
          ],
        },
        {
          key: '1042:465',
          nodeIds: [0, 2],
          coordinates: [
            [2_500_801, 1_117_000, 410],
            [2_500_900, 1_117_100, 414],
          ],
          edgeIds: [1],
          edges: [
            { startId: 0, endId: 2, cost: 141.5, hiking: true },
          ],
        },
      ],
      3,
      2,
    );

    const result = verify(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('disagrees on global node 0');
  });
});
