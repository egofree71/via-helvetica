/**
 * Business context: protects typed-array graph assembly, numeric cross-cell
 * deduplication, snapping, and A* independently from generated national files.
 */
import { describe, expect, it } from 'vitest';
import { BinaryRoutingNetwork } from './binaryRoutingNetwork';
import {
  PRECOMPUTED_BINARY_COST_SCALE,
  PRECOMPUTED_BINARY_HEADER_BYTES,
  type PrecomputedBinaryRoutingCell,
} from './precomputedBinaryRoutingFormat';

function cell(
  key: `${number}:${number}`,
  nodeIds: number[],
  nodeX: number[],
  edgeIds: number[],
  edgeStarts: number[],
  edgeEnds: number[],
  options: {
    nodeY?: number[];
    edgeCosts?: number[];
    globalNodeCount?: number;
    globalEdgeCount?: number;
  } = {},
): PrecomputedBinaryRoutingCell {
  return {
    key,
    nodeIds: Uint32Array.from(nodeIds),
    nodeX: Int32Array.from(nodeX),
    nodeY: Int32Array.from(options.nodeY ?? nodeIds.map(() => 0)),
    nodeZ: Int32Array.from(nodeIds.map((id) => 4_000 + id * 10)),
    edgeIds: Uint32Array.from(edgeIds),
    edgeStartNodeIds: Uint32Array.from(edgeStarts),
    edgeEndNodeIds: Uint32Array.from(edgeEnds),
    edgeCosts: Uint32Array.from(
      options.edgeCosts ??
        edgeIds.map(() => 100 * PRECOMPUTED_BINARY_COST_SCALE),
    ),
    edgeFlags: Uint8Array.from(edgeIds.map(() => 1)),
    globalNodeCount:
      options.globalNodeCount ?? Math.max(3, Math.max(...nodeIds, 0) + 1),
    globalEdgeCount:
      options.globalEdgeCount ?? Math.max(2, Math.max(...edgeIds, 0) + 1),
    sourceRoadFeatures: 1,
    buffer: new ArrayBuffer(PRECOMPUTED_BINARY_HEADER_BYTES),
  };
}

describe('BinaryRoutingNetwork', () => {
  it('deduplicates global IDs and routes across neighbouring cells', () => {
    const first = cell(
      '0:0',
      [0, 1],
      [0, 10_000],
      [0],
      [0],
      [1],
    );
    const second = cell(
      '1:0',
      [0, 1, 2],
      [0, 10_000, 20_000],
      [0, 1],
      [0, 1],
      [1, 2],
    );

    const network = BinaryRoutingNetwork.fromCells(
      [-100, -100, 300, 100],
      [first, second],
    );
    const path = network.route([1, 2], [199, -2]);

    expect(network.stats).toEqual({
      roadFeatures: 2,
      hikingFeatures: 0,
      nodes: 3,
      segments: 2,
      hikingSegments: 2,
    });
    expect(path).not.toBeNull();
    expect(path?.coordinates[0][0]).toBeCloseTo(1, 5);
    expect(path?.coordinates.at(-1)?.[0]).toBeCloseTo(199, 5);
    expect(path?.coordinates).toContainEqual([100, 0, 401]);
    expect(network.estimatedMemoryBytes).toBeLessThan(10_000);
  });

  it('rejects conflicting coordinates for the same global node', () => {
    const first = cell('0:0', [0, 1], [0, 10_000], [0], [0], [1]);
    const second = cell(
      '1:0',
      [0, 1, 2],
      [0, 10_001, 20_000],
      [1],
      [1],
      [2],
    );

    expect(() =>
      BinaryRoutingNetwork.fromCells([-100, -100, 300, 100], [first, second]),
    ).toThrow('global node coordinate');
  });

  it('uses geometry as a deterministic tie-breaker across cell load orders', () => {
    const lower = cell(
      '0:0',
      [0, 1],
      [0, 10_000],
      [0],
      [0],
      [1],
      {
        nodeY: [-100, -100],
        globalNodeCount: 4,
        globalEdgeCount: 2,
      },
    );
    const upper = cell(
      '1:0',
      [2, 3],
      [0, 10_000],
      [1],
      [2],
      [3],
      {
        nodeY: [100, 100],
        globalNodeCount: 4,
        globalEdgeCount: 2,
      },
    );

    const firstNetwork = BinaryRoutingNetwork.fromCells(
      [-10, -10, 110, 10],
      [lower, upper],
    );
    const reverseNetwork = BinaryRoutingNetwork.fromCells(
      [-10, -10, 110, 10],
      [upper, lower],
    );

    expect(firstNetwork.snap([50, 0])?.slice(0, 2)).toEqual([50, -1]);
    expect(reverseNetwork.snap([50, 0])?.slice(0, 2)).toEqual([50, -1]);
  });

  it('routes with the sparse global-ID lookup used by a national dataset', () => {
    const sparse = cell(
      '0:0',
      [10, 900_000],
      [0, 10_000],
      [700_000],
      [10],
      [900_000],
      { globalNodeCount: 1_000_000, globalEdgeCount: 1_000_000 },
    );

    const network = BinaryRoutingNetwork.fromCells(
      [-10, -10, 110, 10],
      [sparse],
    );

    expect(network.route([1, 0], [99, 0])).not.toBeNull();
  });

  it('indexes a long diagonal by crossed buckets instead of its envelope', () => {
    const diagonal = cell(
      '0:0',
      [0, 1],
      [0, 220_000],
      [0],
      [0],
      [1],
      {
        nodeY: [0, 180_000],
        globalNodeCount: 2,
        globalEdgeCount: 1,
      },
    );

    const network = BinaryRoutingNetwork.fromCells(
      [-300, -300, 2_500, 2_100],
      [diagonal],
    );
    const snapped = network.snap([1_100, 900]);

    // The old 9 x 8 envelope occupied 72 buckets and exceeded the former
    // safety limit even though the line itself crosses only a short sequence.
    expect(snapped?.[0]).toBeCloseTo(1_100, 5);
    expect(snapped?.[1]).toBeCloseTo(900, 5);
  });

  it('rejects an edge that would explode the snapping spatial index', () => {
    const corrupt = cell(
      '0:0',
      [0, 1],
      [0, 100_000_000],
      [0],
      [0],
      [1],
      { globalNodeCount: 2, globalEdgeCount: 1 },
    );

    expect(() =>
      BinaryRoutingNetwork.fromCells(
        [-1_000_000, -1_000_000, 2_000_000, 1_000_000],
        [corrupt],
      ),
    ).toThrow('implausible spatial extent');
  });
});
