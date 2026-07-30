/**
 * Business context: protects the worker-owned routing engine independently
 * from the Worker transport. The suite verifies bounded corridor retries,
 * straight-fallback signalling, cell-request reuse, and the derived-graph LRU
 * without live GeoAdmin traffic or expensive graph construction.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const moduleMocks = vi.hoisted(() => ({
  fetchSwissTlmNetworkData: vi.fn(),
  fromSwissTlm: vi.fn(),
  fromPrecomputed: vi.fn(),
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

    static fromPrecomputed(...args: unknown[]): unknown {
      return moduleMocks.fromPrecomputed(...args);
    }
  }

  return { NoWalkableNetworkError, RoutingNetwork };
});

import type { Coordinate } from 'ol/coordinate.js';
import { DynamicRoutingNetworkEngine } from './dynamicRoutingEngine';
import { RoutingAreaTooLargeError } from './dynamicRoutingProtocol';
import { createCorridorCellKeys } from './routingGrid';
import type { RoutedNetworkPath } from './networkRouter';
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
    moduleMocks.fromPrecomputed.mockReset();
    moduleMocks.fromPrecomputed.mockImplementation(() => createNetwork());
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

  it('uses an injected static cell loader instead of GeoAdmin', async () => {
    const cellDataLoader = vi.fn().mockResolvedValue(EMPTY_NETWORK_DATA);
    const engine = new DynamicRoutingNetworkEngine({ cellDataLoader });
    const coordinate: Coordinate = [1_200, 1_200];

    await engine.snap(coordinate, new AbortController().signal);

    expect(cellDataLoader).toHaveBeenCalledTimes(1);
    expect(cellDataLoader).toHaveBeenCalledWith(
      '0:0',
      expect.any(AbortSignal),
    );
    expect(moduleMocks.fetchSwissTlmNetworkData).not.toHaveBeenCalled();
  });


  it('uses precomputed graph cells without compiling source geometry', async () => {
    const graph = {
      nodes: [],
      segments: [],
      sourceRoadFeatures: 0,
      sourceHikingFeatures: 0,
    };
    const precomputedCellLoader = vi.fn().mockResolvedValue(graph);
    const engine = new DynamicRoutingNetworkEngine({
      precomputedCellLoader,
    });
    const coordinate: Coordinate = [1_200, 1_200];

    await engine.snap(coordinate, new AbortController().signal);

    expect(precomputedCellLoader).toHaveBeenCalledWith(
      '0:0',
      expect.any(AbortSignal),
    );
    expect(moduleMocks.fromPrecomputed).toHaveBeenCalledWith(
      expect.any(Array),
      [graph],
    );
    expect(moduleMocks.fromSwissTlm).not.toHaveBeenCalled();
    expect(moduleMocks.fetchSwissTlmNetworkData).not.toHaveBeenCalled();
  });

  it('rejects simultaneous geometry and precomputed loaders', () => {
    expect(
      () =>
        new DynamicRoutingNetworkEngine({
          cellDataLoader: vi.fn(),
          precomputedCellLoader: vi.fn(),
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
    const cellDataLoader = vi.fn(
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
    const engine = new DynamicRoutingNetworkEngine({ cellDataLoader });

    await expect(
      engine.snap([100, 1_200], new AbortController().signal),
    ).resolves.toEqual([100, 1_200]);
    expect(moduleMocks.fromSwissTlm).toHaveBeenCalledTimes(1);
  });

  it('preserves an explicit coverage error when every requested cell is outside', async () => {
    const { RoutingCoverageError } = await import('./routingCoverage');
    const cellDataLoader = vi.fn(async () => {
      throw new RoutingCoverageError(
        'TestCoverageError',
        'Outside the bounded fixture.',
      );
    });
    const engine = new DynamicRoutingNetworkEngine({ cellDataLoader });

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
