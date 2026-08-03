/**
 * Business context: protects the compact binary graph-cell contract before
 * untrusted static responses enter the Worker routing cache.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PRECOMPUTED_BINARY_CHECKSUM,
  PRECOMPUTED_BINARY_COORDINATE_MARGIN_METRES,
  PRECOMPUTED_BINARY_COST_SCALE,
  PRECOMPUTED_BINARY_DATASET_BUILD_ID_OFFSET,
  PRECOMPUTED_BINARY_FORMAT,
  PRECOMPUTED_BINARY_FORMAT_VERSION,
  PRECOMPUTED_BINARY_GENERATOR_VERSION_OFFSET,
  PRECOMPUTED_BINARY_HEADER_BYTES,
  PRECOMPUTED_BINARY_MAGIC,
  PRECOMPUTED_BINARY_PAYLOAD_CRC32_OFFSET,
  PRECOMPUTED_BINARY_SOURCE_CELL_ASSIGNMENT,
  PRECOMPUTED_BINARY_EDGE_OWNERSHIP,
  PRECOMPUTED_BINARY_NODE_IDENTITY,
  PRECOMPUTED_BINARY_XY_SCALE,
  PRECOMPUTED_BINARY_Z_SCALE,
  precomputedBinaryBuildIdFromHex,
  precomputedBinaryCrc32,
  precomputedBinaryLayout,
} from './precomputedBinaryRoutingFormat';

const GENERATOR_VERSION = 4;
const DATASET_BUILD_ID = '11'.repeat(32);

const MANIFEST = {
  version: PRECOMPUTED_BINARY_FORMAT_VERSION,
  format: PRECOMPUTED_BINARY_FORMAT,
  projection: 'EPSG:2056',
  cellSizeMetres: 2_400,
  extent: [2_476_800, 1_101_600, 2_522_400, 1_142_400],
  cellPathTemplate: 'cells/{column}_{row}.bin',
  nonEmptyCellCount: 1,
  nonEmptyCellKeys: ['1041:465'],
  headerBytes: PRECOMPUTED_BINARY_HEADER_BYTES,
  coordinateScalePerMetre: PRECOMPUTED_BINARY_XY_SCALE,
  elevationScalePerMetre: PRECOMPUTED_BINARY_Z_SCALE,
  costScalePerUnit: PRECOMPUTED_BINARY_COST_SCALE,
  payloadChecksum: PRECOMPUTED_BINARY_CHECKSUM,
  coordinateValidationMarginMetres:
    PRECOMPUTED_BINARY_COORDINATE_MARGIN_METRES,
  costModelVersion: 1,
  generatorVersion: GENERATOR_VERSION,
  datasetBuildId: DATASET_BUILD_ID,
  globalNodeCount: 3,
  globalEdgeCount: 2,
  sourceCellAssignment: PRECOMPUTED_BINARY_SOURCE_CELL_ASSIGNMENT,
  edgeOwnership: PRECOMPUTED_BINARY_EDGE_OWNERSHIP,
  nodeIdentity: PRECOMPUTED_BINARY_NODE_IDENTITY,
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Creates one minimal valid VHRG cell without relying on generated files. */
function binaryCellBuffer(): ArrayBuffer {
  const layout = precomputedBinaryLayout(2, 1);
  const buffer = new ArrayBuffer(layout.byteLength);
  const bytes = new Uint8Array(buffer);
  bytes.set(
    [...PRECOMPUTED_BINARY_MAGIC].map((character) => character.charCodeAt(0)),
  );
  const view = new DataView(buffer);
  view.setUint16(4, PRECOMPUTED_BINARY_FORMAT_VERSION, true);
  view.setUint16(6, PRECOMPUTED_BINARY_HEADER_BYTES, true);
  view.setInt32(8, 1041, true);
  view.setInt32(12, 465, true);
  view.setUint32(16, 2, true);
  view.setUint32(20, 1, true);
  view.setUint32(24, 1, true);
  view.setUint32(28, PRECOMPUTED_BINARY_XY_SCALE, true);
  view.setUint32(32, PRECOMPUTED_BINARY_Z_SCALE, true);
  view.setUint32(36, PRECOMPUTED_BINARY_COST_SCALE, true);
  view.setUint32(40, layout.nodeIdsOffset, true);
  view.setUint32(44, layout.edgeIdsOffset, true);
  view.setUint32(48, layout.edgeFlagsOffset, true);
  view.setUint32(52, layout.byteLength, true);
  view.setUint32(56, 3, true);
  view.setUint32(60, 2, true);
  view.setUint32(
    PRECOMPUTED_BINARY_GENERATOR_VERSION_OFFSET,
    GENERATOR_VERSION,
    true,
  );
  bytes.set(
    precomputedBinaryBuildIdFromHex(DATASET_BUILD_ID),
    PRECOMPUTED_BINARY_DATASET_BUILD_ID_OFFSET,
  );

  new Uint32Array(buffer, layout.nodeIdsOffset, 2).set([0, 1]);
  new Int32Array(buffer, layout.nodeXOffset, 2).set([
    249_900_000,
    249_910_000,
  ]);
  new Int32Array(buffer, layout.nodeYOffset, 2).set([
    111_700_000,
    111_710_000,
  ]);
  new Int32Array(buffer, layout.nodeZOffset, 2).set([4_100, 4_120]);
  new Uint32Array(buffer, layout.edgeIdsOffset, 1)[0] = 0;
  new Uint32Array(buffer, layout.edgeStartOffset, 1)[0] = 0;
  new Uint32Array(buffer, layout.edgeEndOffset, 1)[0] = 1;
  new Uint32Array(buffer, layout.edgeCostOffset, 1)[0] =
    91.5 * PRECOMPUTED_BINARY_COST_SCALE;
  new Uint8Array(buffer, layout.edgeFlagsOffset, 1)[0] = 1;
  refreshChecksum(buffer);
  return buffer;
}

/** Recalculates the header checksum after an intentional semantic mutation. */
function refreshChecksum(buffer: ArrayBuffer): void {
  new DataView(buffer).setUint32(
    PRECOMPUTED_BINARY_PAYLOAD_CRC32_OFFSET,
    precomputedBinaryCrc32(
      new Uint8Array(buffer),
      PRECOMPUTED_BINARY_HEADER_BYTES,
    ),
    true,
  );
}

function binaryCellResponse(buffer = binaryCellBuffer()): Response {
  return new Response(buffer, {
    status: 200,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
}

describe('precomputed binary routing cells', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns zero-copy typed views for a valid binary cell', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(MANIFEST))
      .mockResolvedValueOnce(binaryCellResponse());
    vi.stubGlobal('fetch', fetchMock);
    const { fetchPrecomputedBinaryRoutingCell } = await import(
      './precomputedBinaryRoutingData'
    );

    const cell = await fetchPrecomputedBinaryRoutingCell(
      '1041:465',
      new AbortController().signal,
    );

    expect([...cell.nodeIds]).toEqual([0, 1]);
    expect([...cell.edgeIds]).toEqual([0]);
    expect([...cell.edgeStartNodeIds]).toEqual([0]);
    expect([...cell.edgeEndNodeIds]).toEqual([1]);
    expect([...cell.edgeFlags]).toEqual([1]);
    expect(cell.globalNodeCount).toBe(3);
    expect(cell.globalEdgeCount).toBe(2);
    expect(cell.nodeIds.buffer).toBe(cell.buffer);
    expect(cell.supportsFrontierCertification).toBe(true);
    expect(fetchMock.mock.calls[1]?.[0]).toContain('/cells/1041_465.bin');
  });

  it('rejects a manifest that omits the topology invariants', async () => {
    const {
      sourceCellAssignment: _sourceCellAssignment,
      edgeOwnership: _edgeOwnership,
      nodeIdentity: _nodeIdentity,
      ...legacyManifest
    } = MANIFEST;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(legacyManifest));
    vi.stubGlobal('fetch', fetchMock);
    const { fetchPrecomputedBinaryRoutingCell } = await import(
      './precomputedBinaryRoutingData'
    );

    await expect(
      fetchPrecomputedBinaryRoutingCell(
        '1041:465',
        new AbortController().signal,
      ),
    ).rejects.toThrow('manifest is invalid or incompatible');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['sourceCellAssignment', 'clipped-at-cell-boundaries'],
    ['edgeOwnership', 'cell-local-edge-identity'],
    ['nodeIdentity', 'cell-local-node-identity'],
  ] as const)(
    'rejects a manifest with incompatible %s semantics',
    async (field, incompatibleValue) => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({
          ...MANIFEST,
          [field]: incompatibleValue,
        }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const { fetchPrecomputedBinaryRoutingCell } = await import(
        './precomputedBinaryRoutingData'
      );

      await expect(
        fetchPrecomputedBinaryRoutingCell(
          '1041:465',
          new AbortController().signal,
        ),
      ).rejects.toThrow('manifest is invalid or incompatible');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects a published .bin.br path without HTTP Brotli metadata', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        ...MANIFEST,
        cellPathTemplate: 'cells/{column}_{row}.bin.br',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { fetchPrecomputedBinaryRoutingCell } = await import(
      './precomputedBinaryRoutingData'
    );

    await expect(
      fetchPrecomputedBinaryRoutingCell(
        '1041:465',
        new AbortController().signal,
      ),
    ).rejects.toThrow('manifest is invalid or incompatible');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('accepts transport-decoded bytes from the published .bin.br path', async () => {
    const publishedManifest = {
      ...MANIFEST,
      cellPathTemplate: 'cells/{column}_{row}.bin.br',
      deliveryEncoding: 'br',
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(publishedManifest))
      // Fetch transparently removes HTTP Content-Encoding before arrayBuffer().
      .mockResolvedValueOnce(binaryCellResponse());
    vi.stubGlobal('fetch', fetchMock);
    const { fetchPrecomputedBinaryRoutingCell } = await import(
      './precomputedBinaryRoutingData'
    );

    await fetchPrecomputedBinaryRoutingCell(
      '1041:465',
      new AbortController().signal,
    );

    expect(fetchMock.mock.calls[1]?.[0]).toContain('/cells/1041_465.bin.br');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns an empty typed cell without fetching an unlisted in-region file', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(MANIFEST));
    vi.stubGlobal('fetch', fetchMock);
    const { fetchPrecomputedBinaryRoutingCell } = await import(
      './precomputedBinaryRoutingData'
    );

    const cell = await fetchPrecomputedBinaryRoutingCell(
      '1032:459',
      new AbortController().signal,
    );

    expect(cell.nodeIds).toHaveLength(0);
    expect(cell.edgeIds).toHaveLength(0);
    expect(cell.globalNodeCount).toBe(3);
    expect(cell.globalEdgeCount).toBe(2);
    expect(cell.supportsFrontierCertification).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects cells outside the declared dataset before a cell request', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(MANIFEST));
    vi.stubGlobal('fetch', fetchMock);
    const {
      fetchPrecomputedBinaryRoutingCell,
      PrecomputedBinaryRoutingCoverageError,
    } = await import('./precomputedBinaryRoutingData');

    await expect(
      fetchPrecomputedBinaryRoutingCell(
        '1000:400',
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(PrecomputedBinaryRoutingCoverageError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('loads a manifest and cell from an explicit remote dataset root', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(MANIFEST))
      .mockResolvedValueOnce(binaryCellResponse());
    vi.stubGlobal('fetch', fetchMock);
    const { createPrecomputedBinaryRoutingCellLoader } = await import(
      './precomputedBinaryRoutingData'
    );
    const loader = createPrecomputedBinaryRoutingCellLoader(
      'https://routing-data.example.test/swisstlm3d-2026/format-v3/ch/',
    );

    await loader('1041:465', new AbortController().signal);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://routing-data.example.test/swisstlm3d-2026/format-v3/ch/manifest.json',
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://routing-data.example.test/swisstlm3d-2026/format-v3/ch/cells/1041_465.bin',
    );
  });

  it('uses the bounded 300 ms and 1,000 ms retry delays before returning the cell', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse(MANIFEST))
      .mockResolvedValueOnce(binaryCellResponse());
    vi.stubGlobal('fetch', fetchMock);
    const { createPrecomputedBinaryRoutingCellLoader } = await import(
      './precomputedBinaryRoutingData'
    );
    const loader = createPrecomputedBinaryRoutingCellLoader(
      'https://routing-data.example.test/ch',
    );
    const result = loader('1041:465', new AbortController().signal);

    await vi.advanceTimersByTimeAsync(299);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toMatchObject({ key: '1041:465' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('stops after three provider attempts so the session can switch to GeoAdmin', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({}, 503));
    vi.stubGlobal('fetch', fetchMock);
    const { createPrecomputedBinaryRoutingCellLoader } = await import(
      './precomputedBinaryRoutingData'
    );
    const loader = createPrecomputedBinaryRoutingCellLoader(
      'https://routing-data.example.test/ch',
    );
    const result = loader('1041:465', new AbortController().signal);
    const failure = result.then(
      () => null,
      (error: unknown) => error,
    );

    await vi.runAllTimersAsync();

    await expect(failure).resolves.toMatchObject({
      message: expect.stringContaining('request failed (503)'),
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not mark a directly decoded cell as frontier-certifiable', async () => {
    const { readPrecomputedBinaryRoutingCell } = await import(
      './precomputedBinaryRoutingData'
    );

    const cell = readPrecomputedBinaryRoutingCell(
      binaryCellBuffer(),
      '1041:465',
    );

    expect(cell.supportsFrontierCertification).toBeUndefined();
  });

  it('rejects payload corruption before typed arrays enter the cache', async () => {
    const buffer = binaryCellBuffer();
    const layout = precomputedBinaryLayout(2, 1);
    new Int32Array(buffer, layout.nodeXOffset, 2)[0] += 1;
    const { readPrecomputedBinaryRoutingCell } = await import(
      './precomputedBinaryRoutingData'
    );

    expect(() =>
      readPrecomputedBinaryRoutingCell(buffer, '1041:465'),
    ).toThrow('invalid or incompatible');
  });

  it('accepts an unclipped source feature elsewhere in the dataset extent', async () => {
    const buffer = binaryCellBuffer();
    const layout = precomputedBinaryLayout(2, 1);
    new Int32Array(buffer, layout.nodeXOffset, 2).set([
      252_000_000,
      252_010_000,
    ]);
    refreshChecksum(buffer);
    const { readPrecomputedBinaryRoutingCell } = await import(
      './precomputedBinaryRoutingData'
    );

    expect(() =>
      readPrecomputedBinaryRoutingCell(buffer, '1041:465', MANIFEST.extent),
    ).not.toThrow();
  });

  it('rejects a checksummed coordinate far outside the generated region', async () => {
    const buffer = binaryCellBuffer();
    const layout = precomputedBinaryLayout(2, 1);
    new Int32Array(buffer, layout.nodeXOffset, 2)[0] = 349_900_000;
    refreshChecksum(buffer);
    const { readPrecomputedBinaryRoutingCell } = await import(
      './precomputedBinaryRoutingData'
    );

    expect(() =>
      readPrecomputedBinaryRoutingCell(buffer, '1041:465', MANIFEST.extent),
    ).toThrow('invalid coordinate');
  });

  it('rejects a cell from another dataset build', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ ...MANIFEST, datasetBuildId: '22'.repeat(32) }),
      )
      .mockResolvedValueOnce(binaryCellResponse());
    vi.stubGlobal('fetch', fetchMock);
    const { fetchPrecomputedBinaryRoutingCell } = await import(
      './precomputedBinaryRoutingData'
    );

    await expect(
      fetchPrecomputedBinaryRoutingCell(
        '1041:465',
        new AbortController().signal,
      ),
    ).rejects.toThrow('invalid or incompatible');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects unsorted global IDs required by the v3 format', async () => {
    const buffer = binaryCellBuffer();
    const layout = precomputedBinaryLayout(2, 1);
    new Uint32Array(buffer, layout.nodeIdsOffset, 2).set([1, 0]);
    refreshChecksum(buffer);
    const { readPrecomputedBinaryRoutingCell } = await import(
      './precomputedBinaryRoutingData'
    );

    expect(() =>
      readPrecomputedBinaryRoutingCell(buffer, '1041:465'),
    ).toThrow('unsorted node IDs');
  });

  it('accepts a minimum-cost edge after shared-node canonicalization', async () => {
    const buffer = binaryCellBuffer();
    const layout = precomputedBinaryLayout(2, 1);
    new Int32Array(buffer, layout.nodeXOffset, 2).set([
      249_900_000,
      249_900_081,
    ]);
    new Int32Array(buffer, layout.nodeYOffset, 2).set([
      111_700_000,
      111_699_941,
    ]);
    new Uint32Array(buffer, layout.edgeCostOffset, 1)[0] = 4_499;
    refreshChecksum(buffer);
    const { readPrecomputedBinaryRoutingCell } = await import(
      './precomputedBinaryRoutingData'
    );

    expect(() =>
      readPrecomputedBinaryRoutingCell(buffer, '1041:465', MANIFEST.extent),
    ).not.toThrow();
  });

  it('rejects an implausible checksummed edge cost', async () => {
    const buffer = binaryCellBuffer();
    const layout = precomputedBinaryLayout(2, 1);
    new Uint32Array(buffer, layout.edgeCostOffset, 1)[0] = 0xffffffff;
    refreshChecksum(buffer);
    const { readPrecomputedBinaryRoutingCell } = await import(
      './precomputedBinaryRoutingData'
    );

    expect(() =>
      readPrecomputedBinaryRoutingCell(buffer, '1041:465'),
    ).toThrow('invalid edge');
  });
});
