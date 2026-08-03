/**
 * Business context: protects the worker-owned routing engine independently
 * from the Worker transport. The suite verifies certified binary envelopes,
 * legacy corridor retries, straight-fallback signalling, cell-request reuse,
 * and the derived-graph LRU without live traffic or graph construction.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const moduleMocks = vi.hoisted(() => ({
  fetchSwissTlmNetworkData: vi.fn(),
  fromSwissTlm: vi.fn(),
  fromBinary: vi.fn(),
}));

vi.mock('./swissTlmApi', () => ({
  fetchSwissTlmNetworkData: moduleMocks.fetchSwissTlmNetworkData,
  mergeSwissTlmFeatures: (features: unknown[]) => ({
    features,
    conflictingFeatureIds: 0,
  }),
}));

vi.mock('./networkRouter', () => {
  class NoWalkableNetworkError extends Error {
    constructor(message = 'No walkable network is available.') {
      super(message);
      this.name = 'NoWalkableNetworkError';
    }
  }

  class RoutingNetwork {
    static fromSwissTlm(...args: unknown[]): unknown {
      return moduleMocks.fromSwissTlm(...args);
    }

  }

  return { NoWalkableNetworkError, RoutingNetwork };
});

vi.mock('./binaryRoutingNetwork', () => ({
  BinaryRoutingNetwork: {
    fromCells: (...args: unknown[]) => moduleMocks.fromBinary(...args),
  },
}));

import type { Coordinate } from 'ol/coordinate.js';
import { DynamicRoutingNetworkEngine } from './dynamicRoutingEngine';
import { PRECOMPUTED_BINARY_HEADER_BYTES } from './precomputedBinaryRoutingFormat';
import { RoutingAreaTooLargeError } from './dynamicRoutingProtocol';
import {
  createCorridorCellKeys,
  createLocalCellKeys,
  createSegmentEnvelopeCellKeys,
} from './routingGrid';
import type { RouteAttempt, RoutedNetworkPath } from './networkRouter';
import type {
  NetworkLoadOptions,
  SwissTlmNetworkData,
} from './swissTlmApi';

const EMPTY_NETWORK_DATA: SwissTlmNetworkData = {
  roads: [],
  hikingTrails: [],
};

const DEFAULT_PATH: RoutedNetworkPath = {
  coordinates: [
    [1_200, 1_200],
    [1_300, 1_200],
  ],
  snapDistanceStart: 0,
  snapDistanceEnd: 0,
};

/** Minimal graph double exposing only the methods used by the engine. */
function createNetwork(
  routeResult: RoutedNetworkPath | null = DEFAULT_PATH,
  estimatedMemoryBytes = 1_024,
): {
  snap: ReturnType<typeof vi.fn>;
  route: ReturnType<typeof vi.fn>;
  estimatedMemoryBytes: number;
} {
  return {
    snap: vi.fn((coordinate: Coordinate) => coordinate),
    route: vi.fn(() => routeResult),
    estimatedMemoryBytes,
  };
}

/** Binary-network double exposing the loaded-frontier diagnostic. */
function createCertifiedNetwork(
  attempt: Omit<RouteAttempt, 'snapMiss'> &
    Partial<Pick<RouteAttempt, 'snapMiss'>>,
  legacyRouteResult: RoutedNetworkPath | null = attempt.path,
  estimatedMemoryBytes = 1_024,
): {
  snap: ReturnType<typeof vi.fn>;
  route: ReturnType<typeof vi.fn>;
  routeAttempt: ReturnType<typeof vi.fn>;
  estimatedMemoryBytes: number;
} {
  return {
    snap: vi.fn((coordinate: Coordinate) => coordinate),
    route: vi.fn(() => legacyRouteResult),
    routeAttempt: vi.fn(() => ({ snapMiss: false, ...attempt })),
    estimatedMemoryBytes,
  };
}

/** Minimal decoded binary cell accepted by the engine test loader. */
function createBinaryCell(key: `${number}:${number}`) {
  return {
    key,
    nodeIds: new Uint32Array(),
    nodeX: new Int32Array(),
    nodeY: new Int32Array(),
    nodeZ: new Int32Array(),
    edgeIds: new Uint32Array(),
    edgeStartNodeIds: new Uint32Array(),
    edgeEndNodeIds: new Uint32Array(),
    edgeCosts: new Uint32Array(),
    edgeFlags: new Uint8Array(),
    globalNodeCount: 1,
    globalEdgeCount: 1,
    sourceRoadFeatures: 0,
    supportsFrontierCertification: true as const,
    buffer: new ArrayBuffer(PRECOMPUTED_BINARY_HEADER_BYTES),
  };
}

/** Returns a coordinate safely centred inside a chosen grid column. */
function coordinateInColumn(column: number): Coordinate {
  return [column * 2_400 + 1_200, 1_200];
}

describe('DynamicRoutingNetworkEngine', () => {
  beforeEach(() => {
    moduleMocks.fetchSwissTlmNetworkData.mockReset();
    moduleMocks.fetchSwissTlmNetworkData.mockResolvedValue(EMPTY_NETWORK_DATA);
    moduleMocks.fromSwissTlm.mockReset();
    moduleMocks.fromSwissTlm.mockImplementation(() => createNetwork());
    moduleMocks.fromBinary.mockReset();
    moduleMocks.fromBinary.mockImplementation(() => createNetwork());
  });

  it('retries with the wider corridor and reuses cells loaded by the first attempt', async () => {
    moduleMocks.fromSwissTlm
      .mockImplementationOnce(() => createNetwork(null))
      .mockImplementationOnce(() => createNetwork(DEFAULT_PATH));
    const engine = new DynamicRoutingNetworkEngine();
    const start: Coordinate = [1_200, 1_200];
    const end: Coordinate = [3_600, 1_200];

    const result = await engine.route(
      start,
      end,
      new AbortController().signal,
    );

    expect(result).toEqual(DEFAULT_PATH);
    expect(moduleMocks.fromSwissTlm).toHaveBeenCalledTimes(2);
    expect(moduleMocks.fetchSwissTlmNetworkData).toHaveBeenCalledTimes(
      createCorridorCellKeys(start, end, 2).size,
    );
  });

  it('returns null after both corridor widths fail to find a connected path', async () => {
    moduleMocks.fromSwissTlm.mockImplementation(() => createNetwork(null));
    const engine = new DynamicRoutingNetworkEngine();

    const result = await engine.route(
      [1_200, 1_200],
      [3_600, 1_200],
      new AbortController().signal,
    );

    expect(result).toBeNull();
    expect(moduleMocks.fromSwissTlm).toHaveBeenCalledTimes(2);
  });

  it('shares an in-flight cell request between concurrent snap operations', async () => {
    let resolveFetch: ((data: SwissTlmNetworkData) => void) | undefined;
    moduleMocks.fetchSwissTlmNetworkData.mockImplementation(
      () =>
        new Promise<SwissTlmNetworkData>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const engine = new DynamicRoutingNetworkEngine();
    const coordinate: Coordinate = [1_200, 1_200];

    const first = engine.snap(coordinate, new AbortController().signal);
    const second = engine.snap(coordinate, new AbortController().signal);

    await vi.waitFor(() => {
      expect(moduleMocks.fetchSwissTlmNetworkData).toHaveBeenCalledTimes(1);
    });

    resolveFetch?.(EMPTY_NETWORK_DATA);

    await expect(Promise.all([first, second])).resolves.toEqual([
      coordinate,
      coordinate,
    ]);
  });

  it('keeps a shared cell request alive when only one consumer is cancelled', async () => {
    let resolveFetch: ((data: SwissTlmNetworkData) => void) | undefined;
    let providerSignal: AbortSignal | undefined;
    moduleMocks.fetchSwissTlmNetworkData.mockImplementation(
      (_extent: unknown, signal: AbortSignal) => {
        providerSignal = signal;
        return new Promise<SwissTlmNetworkData>((resolve, reject) => {
          resolveFetch = resolve;
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        });
      },
    );
    const engine = new DynamicRoutingNetworkEngine();
    const coordinate: Coordinate = [1_200, 1_200];
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = engine.snap(coordinate, firstController.signal);
    const second = engine.snap(coordinate, secondController.signal);

    await vi.waitFor(() => {
      expect(moduleMocks.fetchSwissTlmNetworkData).toHaveBeenCalledTimes(1);
    });

    firstController.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(providerSignal?.aborted).toBe(false);

    resolveFetch?.(EMPTY_NETWORK_DATA);
    await expect(second).resolves.toEqual(coordinate);
    expect(moduleMocks.fetchSwissTlmNetworkData).toHaveBeenCalledTimes(1);
  });

  it('uses an injected geometry loader instead of GeoAdmin', async () => {
    const geometryCellLoader = vi.fn().mockResolvedValue(EMPTY_NETWORK_DATA);
    const engine = new DynamicRoutingNetworkEngine({ geometryCellLoader });
    const coordinate: Coordinate = [1_200, 1_200];

    await engine.snap(coordinate, new AbortController().signal);

    expect(geometryCellLoader).toHaveBeenCalledTimes(1);
    expect(geometryCellLoader).toHaveBeenCalledWith(
      '0:0',
      expect.any(AbortSignal),
    );
    expect(moduleMocks.fetchSwissTlmNetworkData).not.toHaveBeenCalled();
  });


  it('uses binary precomputed cells through the typed-array network', async () => {
    const graph = createBinaryCell('0:0');
    const precomputedBinaryCellLoader = vi.fn().mockResolvedValue(graph);
    const engine = new DynamicRoutingNetworkEngine({
      precomputedBinaryCellLoader,
    });
    const coordinate: Coordinate = [1_200, 1_200];

    await engine.snap(coordinate, new AbortController().signal);

    expect(precomputedBinaryCellLoader).toHaveBeenCalledWith(
      '0:0',
      expect.any(AbortSignal),
    );
    expect(moduleMocks.fromBinary).toHaveBeenCalledWith(
      expect.any(Array),
      [graph],
      new Set(['0:0']),
    );
    expect(moduleMocks.fromSwissTlm).not.toHaveBeenCalled();
  });

  it('accepts a certified binary route from the smallest metric envelope', async () => {
    const network = createCertifiedNetwork({
      path: DEFAULT_PATH,
      frontierReached: false,
    });
    moduleMocks.fromBinary.mockReturnValue(network);
    const precomputedBinaryCellLoader = vi.fn(async (key: `${number}:${number}`) =>
      createBinaryCell(key),
    );
    const engine = new DynamicRoutingNetworkEngine({
      precomputedBinaryCellLoader,
    });
    const start: Coordinate = [1_200, 1_200];
    const end: Coordinate = [1_300, 1_200];

    await expect(
      engine.route(start, end, new AbortController().signal),
    ).resolves.toEqual(DEFAULT_PATH);

    const expectedCellKeys = createSegmentEnvelopeCellKeys(start, end, 400);
    expect(precomputedBinaryCellLoader).toHaveBeenCalledTimes(
      expectedCellKeys.size,
    );
    expect(moduleMocks.fromBinary).toHaveBeenCalledTimes(1);
    expect(moduleMocks.fromBinary).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Array),
      expectedCellKeys,
    );
    expect(network.routeAttempt).toHaveBeenCalledTimes(1);
    expect(network.route).not.toHaveBeenCalled();
  });

  it('reuses the first-waypoint graph for a 173 m certified section near a cell edge', async () => {
    const network = createCertifiedNetwork({
      path: DEFAULT_PATH,
      frontierReached: false,
    });
    moduleMocks.fromBinary.mockReturnValue(network);
    const precomputedBinaryCellLoader = vi.fn(async (key: `${number}:${number}`) =>
      createBinaryCell(key),
    );
    const engine = new DynamicRoutingNetworkEngine({
      precomputedBinaryCellLoader,
    });
    const start: Coordinate = [1_200, 256];
    const end: Coordinate = [1_373, 256];
    const firstWaypointCells = createLocalCellKeys(start);
    const routeCells = createSegmentEnvelopeCellKeys(start, end, 400);

    expect(routeCells).toEqual(firstWaypointCells);

    await engine.snap(start, new AbortController().signal);
    await expect(
      engine.route(start, end, new AbortController().signal),
    ).resolves.toEqual(DEFAULT_PATH);

    expect(precomputedBinaryCellLoader).toHaveBeenCalledTimes(2);
    expect(moduleMocks.fromBinary).toHaveBeenCalledTimes(1);
    expect(network.routeAttempt).toHaveBeenCalledTimes(1);
  });

  it('widens a binary metric envelope only when the frontier remains relevant', async () => {
    const firstNetwork = createCertifiedNetwork({
      path: DEFAULT_PATH,
      frontierReached: true,
    });
    const secondNetwork = createCertifiedNetwork({
      path: DEFAULT_PATH,
      frontierReached: false,
    });
    moduleMocks.fromBinary
      .mockReturnValueOnce(firstNetwork)
      .mockReturnValueOnce(secondNetwork);
    const precomputedBinaryCellLoader = vi.fn(async (key: `${number}:${number}`) =>
      createBinaryCell(key),
    );
    const engine = new DynamicRoutingNetworkEngine({
      precomputedBinaryCellLoader,
    });
    const start: Coordinate = [1_200, 1_200];
    const end: Coordinate = [1_600, 1_200];

    await expect(
      engine.route(start, end, new AbortController().signal),
    ).resolves.toEqual(DEFAULT_PATH);

    expect(moduleMocks.fromBinary).toHaveBeenCalledTimes(2);
    expect(moduleMocks.fromBinary.mock.calls[0]?.[2]).toEqual(
      createSegmentEnvelopeCellKeys(start, end, 700),
    );
    expect(moduleMocks.fromBinary.mock.calls[1]?.[2]).toEqual(
      createSegmentEnvelopeCellKeys(start, end, 1_100),
    );
    expect(firstNetwork.routeAttempt).toHaveBeenCalledTimes(1);
    expect(secondNetwork.routeAttempt).toHaveBeenCalledTimes(1);
    expect(firstNetwork.route).not.toHaveBeenCalled();
    expect(secondNetwork.route).not.toHaveBeenCalled();
  });

  it('accepts a certified binary miss without loading the legacy retry corridor', async () => {
    const network = createCertifiedNetwork({
      path: null,
      frontierReached: false,
    });
    moduleMocks.fromBinary.mockReturnValue(network);
    const precomputedBinaryCellLoader = vi.fn(async (key: `${number}:${number}`) =>
      createBinaryCell(key),
    );
    const engine = new DynamicRoutingNetworkEngine({
      precomputedBinaryCellLoader,
    });

    await expect(
      engine.route(
        [1_200, 1_200],
        [1_300, 1_200],
        new AbortController().signal,
      ),
    ).resolves.toBeNull();

    expect(moduleMocks.fromBinary).toHaveBeenCalledTimes(1);
    expect(network.routeAttempt).toHaveBeenCalledTimes(1);
  });

  it('stops after a certified snap miss covered by the smallest envelope', async () => {
    const network = createCertifiedNetwork({
      path: null,
      frontierReached: false,
      snapMiss: true,
    });
    moduleMocks.fromBinary.mockReturnValue(network);
    const precomputedBinaryCellLoader = vi.fn(async (key: `${number}:${number}`) =>
      createBinaryCell(key),
    );
    const engine = new DynamicRoutingNetworkEngine({
      precomputedBinaryCellLoader,
    });
    const start: Coordinate = [1_200, 1_200];
    const end: Coordinate = [1_300, 1_200];

    await expect(
      engine.route(start, end, new AbortController().signal),
    ).resolves.toBeNull();

    expect(moduleMocks.fromBinary).toHaveBeenCalledTimes(1);
    expect(moduleMocks.fromBinary.mock.calls[0]?.[2]).toEqual(
      createSegmentEnvelopeCellKeys(start, end, 400),
    );
    expect(network.routeAttempt).toHaveBeenCalledTimes(1);
    expect(network.route).not.toHaveBeenCalled();
  });

  it('stops after one empty binary graph when all snap cells were covered', async () => {
    const { NoWalkableNetworkError } = await import('./networkRouter');
    moduleMocks.fromBinary.mockImplementation(() => {
      throw new NoWalkableNetworkError();
    });
    const precomputedBinaryCellLoader = vi.fn(async (key: `${number}:${number}`) =>
      createBinaryCell(key),
    );
    const engine = new DynamicRoutingNetworkEngine({
      precomputedBinaryCellLoader,
    });
    const start: Coordinate = [1_200, 1_200];
    const end: Coordinate = [1_300, 1_200];

    await expect(
      engine.route(start, end, new AbortController().signal),
    ).resolves.toBeNull();

    expect(moduleMocks.fromBinary).toHaveBeenCalledTimes(1);
    expect(precomputedBinaryCellLoader).toHaveBeenCalledTimes(1);
  });

  it('reports the metric step and certification outcome for local tuning', async () => {
    const network = createCertifiedNetwork({
      path: DEFAULT_PATH,
      frontierReached: false,
    });
    moduleMocks.fromBinary.mockReturnValue(network);
    const onCertifiedRoutingAttempt = vi.fn();
    const engine = new DynamicRoutingNetworkEngine({
      precomputedBinaryCellLoader: vi.fn(async (key: `${number}:${number}`) =>
        createBinaryCell(key),
      ),
      onCertifiedRoutingAttempt,
    });

    await engine.route(
      [1_200, 1_200],
      [1_300, 1_200],
      new AbortController().signal,
    );

    expect(onCertifiedRoutingAttempt).toHaveBeenCalledWith({
      directDistanceMetres: 100,
      attemptNumber: 1,
      marginMetres: 400,
      cellCount: 1,
      outcome: 'certified-path',
    });
  });

  it('returns to the legacy radius-1 workflow when an envelope is no smaller', async () => {
    const legacyNetwork = createNetwork(DEFAULT_PATH);
    moduleMocks.fromBinary.mockReturnValue(legacyNetwork);
    const onCertifiedRoutingAttempt = vi.fn();
    const engine = new DynamicRoutingNetworkEngine({
      precomputedBinaryCellLoader: vi.fn(async (key: `${number}:${number}`) =>
        createBinaryCell(key),
      ),
      onCertifiedRoutingAttempt,
    });
    const start: Coordinate = [1_200, 1_200];
    const end: Coordinate = [4_200, 1_200];

    await expect(
      engine.route(start, end, new AbortController().signal),
    ).resolves.toEqual(DEFAULT_PATH);

    expect(moduleMocks.fromBinary).toHaveBeenCalledTimes(1);
    expect(moduleMocks.fromBinary.mock.calls[0]?.[2]).toEqual(
      createCorridorCellKeys(start, end, 1),
    );
    expect(legacyNetwork.route).toHaveBeenCalledTimes(1);
    expect(onCertifiedRoutingAttempt).toHaveBeenCalledWith({
      directDistanceMetres: 3_000,
      attemptNumber: 1,
      marginMetres: 2_400,
      cellCount: createSegmentEnvelopeCellKeys(start, end, 2_400).size,
      outcome: 'legacy-footprint-preferred',
    });
  });

  it('accepts a legacy radius-1 path after an inconclusive long metric envelope', async () => {
    const metricNetwork = createCertifiedNetwork({
      path: DEFAULT_PATH,
      frontierReached: true,
    });
    const legacyInitialNetwork = createNetwork(DEFAULT_PATH);
    moduleMocks.fromBinary
      .mockReturnValueOnce(metricNetwork)
      .mockReturnValueOnce(legacyInitialNetwork);
    const precomputedBinaryCellLoader = vi.fn(async (key: `${number}:${number}`) =>
      createBinaryCell(key),
    );
    const engine = new DynamicRoutingNetworkEngine({
      precomputedBinaryCellLoader,
    });
    // This diagonal section reproduces the Romont footprint relationship:
    // the 2,400 m metric envelope is smaller than radius 1 but remains
    // inconclusive, so radius 1 must be accepted before any radius-2 download.
    const start: Coordinate = [2_569_749.92, 1_170_535.54];
    const end: Coordinate = [2_571_256.31, 1_175_039.82];
    const metricCellKeys = createSegmentEnvelopeCellKeys(start, end, 2_400);
    const legacyInitialCellKeys = createCorridorCellKeys(start, end, 1);

    expect(metricCellKeys.size).toBeLessThan(legacyInitialCellKeys.size);

    await expect(
      engine.route(start, end, new AbortController().signal),
    ).resolves.toEqual(DEFAULT_PATH);

    expect(moduleMocks.fromBinary).toHaveBeenCalledTimes(2);
    expect(moduleMocks.fromBinary.mock.calls[0]?.[2]).toEqual(metricCellKeys);
    expect(moduleMocks.fromBinary.mock.calls[1]?.[2]).toEqual(
      legacyInitialCellKeys,
    );
    expect(metricNetwork.routeAttempt).toHaveBeenCalledTimes(1);
    expect(legacyInitialNetwork.route).toHaveBeenCalledTimes(1);
  });

  it('keeps the exact legacy radius-2 retry after radius 1 also misses', async () => {
    const metricNetwork = createCertifiedNetwork({
      path: DEFAULT_PATH,
      frontierReached: true,
    });
    const legacyInitialNetwork = createNetwork(null);
    const legacyRetryNetwork = createNetwork(DEFAULT_PATH);
    moduleMocks.fromBinary
      .mockReturnValueOnce(metricNetwork)
      .mockReturnValueOnce(legacyInitialNetwork)
      .mockReturnValueOnce(legacyRetryNetwork);
    const precomputedBinaryCellLoader = vi.fn(async (key: `${number}:${number}`) =>
      createBinaryCell(key),
    );
    const engine = new DynamicRoutingNetworkEngine({
      precomputedBinaryCellLoader,
    });
    const start: Coordinate = [2_569_749.92, 1_170_535.54];
    const end: Coordinate = [2_571_256.31, 1_175_039.82];

    await expect(
      engine.route(start, end, new AbortController().signal),
    ).resolves.toEqual(DEFAULT_PATH);

    expect(moduleMocks.fromBinary).toHaveBeenCalledTimes(3);
    expect(moduleMocks.fromBinary.mock.calls.at(-2)?.[2]).toEqual(
      createCorridorCellKeys(start, end, 1),
    );
    expect(moduleMocks.fromBinary.mock.calls.at(-1)?.[2]).toEqual(
      createCorridorCellKeys(start, end, 2),
    );
    expect(legacyInitialNetwork.route).toHaveBeenCalledTimes(1);
    expect(legacyRetryNetwork.route).toHaveBeenCalledTimes(1);
  });

  it('retains the best smaller metric path only when both legacy corridors miss', async () => {
    const metricNetwork = createCertifiedNetwork({
      path: DEFAULT_PATH,
      frontierReached: true,
    });
    const legacyInitialNetwork = createNetwork(null);
    const legacyRetryNetwork = createNetwork(null);
    moduleMocks.fromBinary
      .mockReturnValueOnce(metricNetwork)
      .mockReturnValueOnce(legacyInitialNetwork)
      .mockReturnValueOnce(legacyRetryNetwork);
    const engine = new DynamicRoutingNetworkEngine({
      precomputedBinaryCellLoader: vi.fn(async (key: `${number}:${number}`) =>
        createBinaryCell(key),
      ),
    });
    const start: Coordinate = [2_569_749.92, 1_170_535.54];
    const end: Coordinate = [2_571_256.31, 1_175_039.82];

    await expect(
      engine.route(start, end, new AbortController().signal),
    ).resolves.toEqual(DEFAULT_PATH);

    expect(moduleMocks.fromBinary).toHaveBeenCalledTimes(3);
    expect(legacyInitialNetwork.route).toHaveBeenCalledTimes(1);
    expect(legacyRetryNetwork.route).toHaveBeenCalledTimes(1);
  });

  it('uses the complete legacy workflow when diagnostics are unavailable', async () => {
    const metricNetwork = createNetwork(DEFAULT_PATH);
    const legacyNetwork = createNetwork(DEFAULT_PATH);
    moduleMocks.fromBinary
      .mockReturnValueOnce(metricNetwork)
      .mockReturnValueOnce(legacyNetwork);
    const precomputedBinaryCellLoader = vi.fn(async (key: `${number}:${number}`) =>
      createBinaryCell(key),
    );
    const engine = new DynamicRoutingNetworkEngine({
      precomputedBinaryCellLoader,
    });
    const start: Coordinate = [1_200, 1_200];
    const end: Coordinate = [1_300, 1_200];

    await expect(
      engine.route(start, end, new AbortController().signal),
    ).resolves.toEqual(DEFAULT_PATH);

    expect(moduleMocks.fromBinary).toHaveBeenCalledTimes(2);
    expect(moduleMocks.fromBinary.mock.calls.at(-1)?.[2]).toEqual(
      createCorridorCellKeys(start, end, 1),
    );
    expect(metricNetwork.route).not.toHaveBeenCalled();
    expect(legacyNetwork.route).toHaveBeenCalledTimes(1);
  });

  it('rejects simultaneous geometry and binary precomputed loaders', () => {
    expect(
      () =>
        new DynamicRoutingNetworkEngine({
          geometryCellLoader: vi.fn(),
          precomputedBinaryCellLoader: vi.fn(),
        }),
    ).toThrow('mutually exclusive');
  });

  it('starts in roads-only mode when local fallback testing disables enrichment', async () => {
    const enrichmentChoices: boolean[] = [];
    const onHikingEnrichmentUnavailable = vi.fn();

    moduleMocks.fetchSwissTlmNetworkData.mockImplementation(
      (
        _extent: unknown,
        _signal: AbortSignal,
        options: NetworkLoadOptions,
      ) => {
        enrichmentChoices.push(
          options.shouldRequestHikingEnrichment?.() ?? true,
        );
        return Promise.resolve(EMPTY_NETWORK_DATA);
      },
    );

    const engine = new DynamicRoutingNetworkEngine({
      initialHikingEnrichmentEnabled: false,
      onHikingEnrichmentUnavailable,
    });

    // The notice must not be emitted during Worker construction, when the
    // main-thread subscriber may not yet be ready to receive it.
    expect(onHikingEnrichmentUnavailable).not.toHaveBeenCalled();

    await engine.snap(
      coordinateInColumn(0),
      new AbortController().signal,
    );

    expect(enrichmentChoices).not.toHaveLength(0);
    expect(enrichmentChoices).toEqual(
      Array(enrichmentChoices.length).fill(false),
    );
    expect(onHikingEnrichmentUnavailable).toHaveBeenCalledTimes(1);
  });

  it('reports local roads-only mode when route is the first Worker operation', async () => {
    const onHikingEnrichmentUnavailable = vi.fn();
    const engine = new DynamicRoutingNetworkEngine({
      initialHikingEnrichmentEnabled: false,
      onHikingEnrichmentUnavailable,
    });

    expect(onHikingEnrichmentUnavailable).not.toHaveBeenCalled();

    await engine.route(
      coordinateInColumn(0),
      coordinateInColumn(1),
      new AbortController().signal,
    );

    expect(onHikingEnrichmentUnavailable).toHaveBeenCalledTimes(1);
  });

  it('stops requesting hiking enrichment after the first session failure', async () => {
    const enrichmentChoices: boolean[] = [];
    const onHikingEnrichmentUnavailable = vi.fn();

    moduleMocks.fetchSwissTlmNetworkData.mockImplementation(
      (
        _extent: unknown,
        _signal: AbortSignal,
        options: NetworkLoadOptions,
      ) => {
        enrichmentChoices.push(
          options.shouldRequestHikingEnrichment?.() ?? true,
        );

        if (enrichmentChoices.length === 1) {
          options.onHikingEnrichmentUnavailable?.();
        }

        return Promise.resolve(EMPTY_NETWORK_DATA);
      },
    );

    const engine = new DynamicRoutingNetworkEngine({
      onHikingEnrichmentUnavailable,
    });

    await engine.snap(
      coordinateInColumn(0),
      new AbortController().signal,
    );
    await engine.snap(
      coordinateInColumn(10),
      new AbortController().signal,
    );

    expect(enrichmentChoices[0]).toBe(true);
    expect(enrichmentChoices.slice(1)).toEqual(
      Array(enrichmentChoices.length - 1).fill(false),
    );
    expect(onHikingEnrichmentUnavailable).toHaveBeenCalledTimes(1);
  });

  it('cleans an aborted pending cell so the same area can be retried', async () => {
    moduleMocks.fetchSwissTlmNetworkData.mockImplementationOnce(
      (_extent: unknown, signal: AbortSignal) =>
        new Promise<SwissTlmNetworkData>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        }),
    );
    const engine = new DynamicRoutingNetworkEngine();
    const coordinate: Coordinate = [1_200, 1_200];
    const controller = new AbortController();
    const abortedSnap = engine.snap(coordinate, controller.signal);

    await vi.waitFor(() => {
      expect(moduleMocks.fetchSwissTlmNetworkData).toHaveBeenCalledTimes(1);
    });

    controller.abort();

    await expect(abortedSnap).rejects.toMatchObject({ name: 'AbortError' });
    moduleMocks.fetchSwissTlmNetworkData.mockResolvedValueOnce(
      EMPTY_NETWORK_DATA,
    );

    await expect(
      engine.snap(coordinate, new AbortController().signal),
    ).resolves.toEqual(coordinate);
    expect(moduleMocks.fetchSwissTlmNetworkData).toHaveBeenCalledTimes(2);
  });


  it('aborts pending cells and rejects new work after provider disposal', async () => {
    moduleMocks.fetchSwissTlmNetworkData.mockImplementationOnce(
      (_extent: unknown, signal: AbortSignal) =>
        new Promise<SwissTlmNetworkData>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        }),
    );
    const engine = new DynamicRoutingNetworkEngine();
    const pendingSnap = engine.snap(
      [1_200, 1_200],
      new AbortController().signal,
    );

    await vi.waitFor(() => {
      expect(moduleMocks.fetchSwissTlmNetworkData).toHaveBeenCalledTimes(1);
    });

    engine.dispose();

    await expect(pendingSnap).rejects.toMatchObject({ name: 'AbortError' });
    await expect(
      engine.snap([1_200, 1_200], new AbortController().signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('promotes cache hits and evicts the least-recently used graph', async () => {
    const engine = new DynamicRoutingNetworkEngine();
    const signal = new AbortController().signal;
    const coordinates = Array.from({ length: 3 }, (_, index) =>
      coordinateInColumn(index * 10),
    );

    await engine.route(coordinates[0], coordinates[0], signal);
    await engine.route(coordinates[1], coordinates[1], signal);
    expect(moduleMocks.fromSwissTlm).toHaveBeenCalledTimes(2);

    // Reusing the oldest graph promotes it before a third graph is inserted.
    await engine.route(coordinates[0], coordinates[0], signal);
    await engine.route(coordinates[2], coordinates[2], signal);
    await engine.route(coordinates[0], coordinates[0], signal);
    expect(moduleMocks.fromSwissTlm).toHaveBeenCalledTimes(3);

    // The untouched graph was evicted by the two-entry LRU.
    await engine.route(coordinates[1], coordinates[1], signal);
    expect(moduleMocks.fromSwissTlm).toHaveBeenCalledTimes(4);
  });

  it('keeps valid edge cells when neighbouring halo cells are outside coverage', async () => {
    const { RoutingCoverageError } = await import('./routingCoverage');
    const geometryCellLoader = vi.fn(
      async (key: string): Promise<SwissTlmNetworkData> => {
        if (key.startsWith('-')) {
          throw new RoutingCoverageError(
            'TestCoverageError',
            'Outside the bounded fixture.',
          );
        }
        return EMPTY_NETWORK_DATA;
      },
    );
    const engine = new DynamicRoutingNetworkEngine({ geometryCellLoader });

    await expect(
      engine.snap([100, 1_200], new AbortController().signal),
    ).resolves.toEqual([100, 1_200]);
    expect(moduleMocks.fromSwissTlm).toHaveBeenCalledTimes(1);
  });

  it('preserves an explicit coverage error when every requested cell is outside', async () => {
    const { RoutingCoverageError } = await import('./routingCoverage');
    const geometryCellLoader = vi.fn(async () => {
      throw new RoutingCoverageError(
        'TestCoverageError',
        'Outside the bounded fixture.',
      );
    });
    const engine = new DynamicRoutingNetworkEngine({ geometryCellLoader });

    await expect(
      engine.snap([1_200, 1_200], new AbortController().signal),
    ).rejects.toMatchObject({ name: 'TestCoverageError' });
  });

  it('evicts older corridor graphs when the estimated byte budget is exceeded', async () => {
    moduleMocks.fromSwissTlm.mockImplementation(() =>
      createNetwork(DEFAULT_PATH, 80 * 1024 * 1024),
    );
    const engine = new DynamicRoutingNetworkEngine();
    const signal = new AbortController().signal;
    const first = coordinateInColumn(0);
    const second = coordinateInColumn(10);

    await engine.route(first, first, signal);
    await engine.route(second, second, signal);
    await engine.route(first, first, signal);

    // Two 80 MiB estimates exceed the 128 MiB budget, so the first graph was rebuilt.
    expect(moduleMocks.fromSwissTlm).toHaveBeenCalledTimes(3);
  });

  it('rejects an oversized corridor before making provider requests', async () => {
    const engine = new DynamicRoutingNetworkEngine();

    await expect(
      engine.route(
        [0, 0],
        [240_000, 0],
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(RoutingAreaTooLargeError);
    expect(moduleMocks.fetchSwissTlmNetworkData).not.toHaveBeenCalled();
  });

  it('propagates provider failures instead of treating them as missing coverage', async () => {
    moduleMocks.fetchSwissTlmNetworkData.mockRejectedValue(
      new Error('GeoAdmin unavailable'),
    );
    const engine = new DynamicRoutingNetworkEngine();

    await expect(
      engine.snap([1_200, 1_200], new AbortController().signal),
    ).rejects.toThrow('GeoAdmin unavailable');
  });
});
