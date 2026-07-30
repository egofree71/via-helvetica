/**
 * Business context: protects the compact binary graph-cell contract before
 * untrusted static responses enter the Worker routing cache.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PRECOMPUTED_BINARY_CHECKSUM,
  PRECOMPUTED_BINARY_COORDINATE_MARGIN_METRES,
  PRECOMPUTED_BINARY_COST_SCALE,
  PRECOMPUTED_BINARY_FORMAT,
  PRECOMPUTED_BINARY_FORMAT_VERSION,
  PRECOMPUTED_BINARY_HEADER_BYTES,
  PRECOMPUTED_BINARY_MAGIC,
  PRECOMPUTED_BINARY_PAYLOAD_CRC32_OFFSET,
  PRECOMPUTED_BINARY_XY_SCALE,
  PRECOMPUTED_BINARY_Z_SCALE,
  precomputedBinaryCrc32,
  precomputedBinaryLayout,
} from './precomputedBinaryRoutingFormat';

const MANIFEST = {
  version: PRECOMPUTED_BINARY_FORMAT_VERSION,
  format: PRECOMPUTED_BINARY_FORMAT,
  projection: 'EPSG:2056',
  cellSizeMetres: 2_400,
  extent: [2_476_800, 1_101_600, 2_522_400, 1_142_400],
  cellPathTemplate: 'cells/{column}_{row}.bin',
  precompressedCellPathTemplate: 'cells/{column}_{row}.bin.br',
  nonEmptyCellKeys: ['1041:465'],
  headerBytes: PRECOMPUTED_BINARY_HEADER_BYTES,
  coordinateScalePerMetre: PRECOMPUTED_BINARY_XY_SCALE,
  elevationScalePerMetre: PRECOMPUTED_BINARY_Z_SCALE,
  costScalePerUnit: PRECOMPUTED_BINARY_COST_SCALE,
  payloadChecksum: PRECOMPUTED_BINARY_CHECKSUM,
  coordinateValidationMarginMetres:
    PRECOMPUTED_BINARY_COORDINATE_MARGIN_METRES,
  costModelVersion: 1,
  globalNodeCount: 3,
  globalEdgeCount: 2,
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

/** Pass-through stream used to exercise explicit `.bin.br` retrieval. */
class PassThroughDecompressionStream {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;

  constructor() {
    const stream = new TransformStream<Uint8Array, Uint8Array>();
    this.readable = stream.readable;
    this.writable = stream.writable;
  }
}

describe('precomputed binary Geneva routing cells', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('returns zero-copy typed views for a valid binary cell', async () => {
    vi.stubGlobal('DecompressionStream', undefined);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(MANIFEST))
      .mockResolvedValueOnce(binaryCellResponse());
    vi.stubGlobal('fetch', fetchMock);
    const { fetchPrecomputedBinaryGenevaRoutingCell } = await import(
      './precomputedBinaryRoutingData'
    );

    const cell = await fetchPrecomputedBinaryGenevaRoutingCell(
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
    expect(fetchMock.mock.calls[1]?.[0]).toContain('/cells/1041_465.bin');
  });

  it('uses the precompressed cell when native Brotli streams are available', async () => {
    vi.stubGlobal(
      'DecompressionStream',
      PassThroughDecompressionStream as unknown as typeof DecompressionStream,
    );
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(MANIFEST))
      // The pass-through test stream treats the valid binary fixture as if it
      // were the decompressed output of the installed `.bin.br` file.
      .mockResolvedValueOnce(binaryCellResponse());
    vi.stubGlobal('fetch', fetchMock);
    const { fetchPrecomputedBinaryGenevaRoutingCell } = await import(
      './precomputedBinaryRoutingData'
    );

    await fetchPrecomputedBinaryGenevaRoutingCell(
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
    const { fetchPrecomputedBinaryGenevaRoutingCell } = await import(
      './precomputedBinaryRoutingData'
    );

    const cell = await fetchPrecomputedBinaryGenevaRoutingCell(
      '1032:459',
      new AbortController().signal,
    );

    expect(cell.nodeIds).toHaveLength(0);
    expect(cell.edgeIds).toHaveLength(0);
    expect(cell.globalNodeCount).toBe(3);
    expect(cell.globalEdgeCount).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects cells outside the declared experiment before a cell request', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(MANIFEST));
    vi.stubGlobal('fetch', fetchMock);
    const {
      fetchPrecomputedBinaryGenevaRoutingCell,
      PrecomputedBinaryRoutingCoverageError,
    } = await import('./precomputedBinaryRoutingData');

    await expect(
      fetchPrecomputedBinaryGenevaRoutingCell(
        '1000:400',
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(PrecomputedBinaryRoutingCoverageError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
