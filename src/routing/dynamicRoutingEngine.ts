/**
 * Business context: owns worker-side swissTLM3D routing state. It loads bounded
 * cells from the configured provider, keeps GeoAdmin geometry or compact binary
 * graph cells inside the dedicated Worker, builds the exact corridor network,
 * and performs snapping and A* without blocking the map UI.
 */
import type { Coordinate } from 'ol/coordinate.js';
import {
  NoWalkableNetworkError,
  RoutingNetwork,
  type RoutableNetwork,
  type RoutedNetworkPath,
} from './networkRouter';
import { BinaryRoutingNetwork } from './binaryRoutingNetwork';
import type { PrecomputedBinaryRoutingCell } from './precomputedBinaryRoutingFormat';
import {
  combinedExtent,
  createCorridorCellKeys,
  createLocalCellKeys,
  extentForCellKey,
  type CellKey,
} from './routingGrid';
import { RoutingAreaTooLargeError } from './dynamicRoutingProtocol';
import { isRoutingCoverageError } from './routingCoverage';
import {
  fetchSwissTlmNetworkData,
  mergeSwissTlmFeatures,
  type SwissTlmLineFeature,
  type SwissTlmNetworkData,
} from './swissTlmApi';

/** Corridor radius in cells for the first route attempt. */
const ROUTE_CELL_RADIUS = 1;
/** Wider corridor radius in cells used only when the first graph is disconnected. */
const ROUTE_RETRY_CELL_RADIUS = 2;
/**
 * Safety limit per snap/route operation. It prevents very long segments from
 * triggering excessive API traffic and memory use.
 */
const MAX_CELLS_PER_OPERATION = 80;
/** Hard maximum number of combined corridor graphs retained in the Worker. */
const NETWORK_CACHE_LIMIT = 2;
/**
 * Approximate graph-cache budget in bytes. The estimate is conservative and
 * keeps one oversized current graph rather than evicting the graph just built.
 */
const MAX_NETWORK_CACHE_BYTES = 128 * 1024 * 1024;
/**
 * Approximate raw-cell cache budget in bytes. Cell entries are evicted by least
 * recent use; an individual oversized current cell remains available.
 */
const MAX_LOADED_CELL_CACHE_BYTES = 64 * 1024 * 1024;
/** Number of cells loaded concurrently inside the worker. */
const CELL_LOAD_CONCURRENCY = 2;

/** Completed source-geometry cell retained for the page session. */
interface LoadedGeometryCell {
  /** Discriminator used before merging exact corridor cells. */
  kind: 'geometry';
  /** Deduplicated swissTLM3D road and hiking features for this cell. */
  data: SwissTlmNetworkData;
}

/** Completed typed-array graph cell retained for the page session. */
interface LoadedBinaryPrecomputedCell {
  /** Discriminator used before constructing the compact corridor network. */
  kind: 'precomputed-binary';
  /** Zero-copy typed views over one independently loadable binary cell. */
  graph: PrecomputedBinaryRoutingCell;
}

/** Either provider representation accepted by the session cache. */
type LoadedCell = LoadedGeometryCell | LoadedBinaryPrecomputedCell;

/** Cached graph built for one exact set of cell keys. */
interface CachedNetwork {
  /** Sorted cell-key signature used for exact cache lookup. */
  key: string;
  /** Immutable graph built from those cells. */
  network: RoutableNetwork;
  /** Conservative retained-size estimate used for byte-budget eviction. */
  estimatedBytes: number;
}

/** One completed cell plus its conservative retained-size estimate. */
interface CachedLoadedCell {
  /** Geometry or compact binary graph data returned by the selected provider. */
  cell: LoadedCell;
  /** Approximate retained bytes used by the LRU budget. */
  estimatedBytes: number;
}

/** Result of loading one requested corridor key with bounded-provider handling. */
interface LoadedCellResult {
  /** Routing-grid key that produced this result. */
  key: CellKey;
  /** Completed cell when the provider covers the key. */
  cell?: LoadedCell;
  /** Coverage error when the key lies outside a bounded experimental provider. */
  coverageError?: Error;
}

/** In-flight cell request shared by concurrent consumers. */
interface PendingCell {
  /** Promise resolving to the completed cell. */
  promise: Promise<LoadedCell>;
  /** Cell-owned controller, independent from any one route operation. */
  controller: AbortController;
  /** Number of callers still waiting for this shared request. */
  consumers: number;
  /** Whether the provider promise has completed. */
  settled: boolean;
}

/** Session callbacks emitted by the worker-owned routing engine. */
export interface DynamicRoutingNetworkEngineOptions {
  /**
   * Initial provider choice. Defaults to `true`; local development may start in
   * roads-only mode to exercise the fallback without a real provider failure.
   */
  initialHikingEnrichmentEnabled?: boolean;
  /** Called once when optional hiking enrichment is disabled for the session. */
  onHikingEnrichmentUnavailable?: () => void;
  /**
   * Optional normalized geometry loader injected by regression tests.
   * Normal runtime geometry loading uses GeoAdmin directly.
   */
  geometryCellLoader?: (
    key: CellKey,
    signal: AbortSignal,
  ) => Promise<SwissTlmNetworkData>;
  /**
   * Optional loader for compact binary graph cells with global integer IDs.
   * It is mutually exclusive with the injected geometry loader.
   */
  precomputedBinaryCellLoader?: (
    key: CellKey,
    signal: AbortSignal,
  ) => Promise<PrecomputedBinaryRoutingCell>;
}

/**
 * Maps cells with a bounded worker pool to protect the public API and browser.
 * @param values - Ordered inputs to process.
 * @param concurrency - Maximum number of active mapper promises.
 * @param mapper - Asynchronous operation applied once to each input.
 * @returns Results in the same order as the input values.
 * @throws {Error} Propagates the first mapper rejection.
 */
async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  const runners = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(values[index]);
      }
    },
  );

  await Promise.all(runners);
  return results;
}

/**
 * Merges cell features by stable ID because geometries crossing cell boundaries
 * may be returned by several identify requests.
 * @param cells - Completed raw cells contributing features.
 * @param selector - Chooses roads or hiking geometries from one cell.
 * @returns Deduplicated features in stable insertion order.
 */
function mergeFeatures(
  cells: LoadedGeometryCell[],
  selector: (data: SwissTlmNetworkData) => SwissTlmLineFeature[],
): SwissTlmLineFeature[] {
  return mergeSwissTlmFeatures(
    cells.flatMap((cell) => selector(cell.data)),
  ).features;
}


/** Estimates retained bytes for one normalized source feature collection. */
function estimateGeometryCellBytes(data: SwissTlmNetworkData): number {
  let coordinateCount = 0;
  let lineCount = 0;
  let featureCount = 0;

  for (const feature of [...data.roads, ...data.hikingTrails]) {
    featureCount += 1;
    lineCount += feature.lines.length;
    for (const line of feature.lines) {
      coordinateCount += line.length;
    }
  }

  // Coordinates dominate raw-cell memory; the fixed allowances cover nested
  // arrays, feature objects, strings, and normalized attributes.
  return coordinateCount * 48 + lineCount * 64 + featureCount * 256;
}

/** Returns the exact ArrayBuffer size retained by one binary graph cell. */
function estimateBinaryPrecomputedCellBytes(
  data: PrecomputedBinaryRoutingCell,
): number {
  return data.buffer.byteLength;
}

/** Returns the conservative cache weight for any provider representation. */
function estimateLoadedCellBytes(cell: LoadedCell): number {
  if (cell.kind === 'geometry') {
    return estimateGeometryCellBytes(cell.data);
  }

  return estimateBinaryPrecomputedCellBytes(cell.graph);
}

/**
 * Session-scoped dynamic loader for swissTLM3D routing graphs.
 *
 * Completed cells are retained by a byte-bounded LRU. Each route segment first
 * uses a narrow corridor and retries once with a wider corridor when the graph
 * is disconnected. Combined graphs are cached by their exact cell set.
 */
export class DynamicRoutingNetworkEngine {
  /** Raw feature cells already completed during this page session. */
  private readonly loadedCells = new Map<CellKey, CachedLoadedCell>();
  /** Current conservative retained-size total for completed raw cells. */
  private loadedCellCacheBytes = 0;
  /** In-flight cell requests shared to avoid duplicate GeoAdmin traffic. */
  private readonly pendingCells = new Map<CellKey, PendingCell>();
  /** Small most-recent-first cache of graphs for exact corridor cell sets. */
  private readonly networkCache: CachedNetwork[] = [];
  /** Current conservative retained-size total for cached corridor graphs. */
  private networkCacheBytes = 0;
  /**
   * Whether new cells should still request the optional hiking layer. Once a
   * layer-specific rejection occurs, roads alone are used for the remaining
   * worker session so every new waypoint does not repeat the same failure.
   */
  private hikingEnrichmentEnabled: boolean;
  /** Session callbacks and initial provider policy. */
  private readonly options: DynamicRoutingNetworkEngineOptions;
  /** Prevents abandoned providers from accepting or retaining new work. */
  private disposed = false;
  /** Prevents repeated UI notices after roads-only mode has been reported. */
  private hikingEnrichmentUnavailableReported = false;
  /** Avoids repeating provider diagnostics for every loaded GeoAdmin cell. */
  private missingElevationReported = false;
  /** Avoids repeating provider-ID collision diagnostics for every cell. */
  private conflictingProviderIdReported = false;

  constructor(options: DynamicRoutingNetworkEngineOptions = {}) {
    const configuredLoaders = [
      options.geometryCellLoader,
      options.precomputedBinaryCellLoader,
    ].filter(Boolean).length;

    if (configuredLoaders > 1) {
      throw new Error(
        'Injected geometry and binary precomputed cell loaders are mutually exclusive.',
      );
    }

    this.options = options;
    this.hikingEnrichmentEnabled =
      options.initialHikingEnrichmentEnabled ?? true;
  }

  /**
   * Releases provider requests and cached graphs when a whole routing provider
   * is abandoned for the remainder of the Worker session.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;

    for (const pending of this.pendingCells.values()) {
      pending.controller.abort();
    }

    this.pendingCells.clear();
    this.loadedCells.clear();
    this.loadedCellCacheBytes = 0;
    this.networkCache.splice(0);
    this.networkCacheBytes = 0;
  }

  /** Rejects work that belongs to a provider already abandoned by the session. */
  private ensureActive(): void {
    if (this.disposed) {
      throw new DOMException('Routing provider disposed', 'AbortError');
    }
  }

  /** Reports roads-only mode after a routing request has started. */
  private reportHikingEnrichmentUnavailable(): void {
    if (this.hikingEnrichmentUnavailableReported) {
      return;
    }

    this.hikingEnrichmentUnavailableReported = true;
    this.options.onHikingEnrichmentUnavailable?.();
  }

  /** Disables optional hiking requests and reports the transition only once. */
  private disableHikingEnrichment(): void {
    if (!this.hikingEnrichmentEnabled) {
      return;
    }

    this.hikingEnrichmentEnabled = false;
    this.reportHikingEnrichmentUnavailable();
  }

  /** Reports live-provider assumptions that must be verified before comparison. */
  private reportProviderDiagnostics(diagnostics: {
    roadCoordinates: number;
    roadCoordinatesWithZ: number;
    conflictingFeatureIds: number;
  }): void {
    if (
      !this.missingElevationReported &&
      diagnostics.roadCoordinatesWithZ < diagnostics.roadCoordinates
    ) {
      this.missingElevationReported = true;
      console.warn(
        '[Via Helvetica] GeoAdmin swissTLM3D roads contain coordinates without Z:',
        diagnostics,
      );
    }

    if (
      !this.conflictingProviderIdReported &&
      diagnostics.conflictingFeatureIds > 0
    ) {
      this.conflictingProviderIdReported = true;
      console.warn(
        '[Via Helvetica] GeoAdmin reused feature IDs for different geometries:',
        diagnostics.conflictingFeatureIds,
      );
    }
  }

  /**
   * Loads a neighbourhood around a point and snaps it to the local network.
   * @param coordinate - User-selected coordinate in EPSG:2056.
   * @param signal - Abort signal owned by the route-creation session.
   * @returns The snapped coordinate, or `null` when coverage is empty or no segment is close enough.
   * @throws {RoutingAreaTooLargeError} If the generated neighbourhood exceeds the safety limit.
   * @throws {Error} When provider loading or graph construction fails.
   */
  async snap(
    coordinate: Coordinate,
    signal: AbortSignal,
  ): Promise<Coordinate | null> {
    this.ensureActive();

    if (!this.hikingEnrichmentEnabled) {
      // Emitting after the first operation arrives avoids losing the local-test
      // notice while the Worker module is still starting up.
      this.reportHikingEnrichmentUnavailable();
    }

    const cellKeys = createLocalCellKeys(coordinate);

    try {
      const network = await this.getNetwork(cellKeys, signal);
      return network.snap(coordinate);
    } catch (error) {
      // Empty cells are expected outside swissTLM3D coverage. Returning null
      // lets the editor place the point freely instead of treating it as an
      // API failure.
      if (error instanceof NoWalkableNetworkError) {
        return null;
      }

      throw error;
    }
  }

  /**
   * Routes between two waypoints using an on-demand corridor of swissTLM3D cells.
   * @param startCoordinate - Existing route endpoint in EPSG:2056.
   * @param endCoordinate - Newly selected destination in EPSG:2056.
   * @param signal - Abort signal owned by the route-creation session.
   * @returns A routed path, or `null` when both corridor widths lack usable coverage or connectivity.
   * @throws {RoutingAreaTooLargeError} If either corridor exceeds the safety limit.
   * @throws {Error} When provider loading or graph construction fails.
   */
  async route(
    startCoordinate: Coordinate,
    endCoordinate: Coordinate,
    signal: AbortSignal,
  ): Promise<RoutedNetworkPath | null> {
    this.ensureActive();

    if (!this.hikingEnrichmentEnabled) {
      // A route request can be the first Worker operation after local startup.
      this.reportHikingEnrichmentUnavailable();
    }

    return this.routeInternal(startCoordinate, endCoordinate, signal);
  }

  /**
   * Executes the shared narrow-corridor and optional wider-retry workflow.
   * @param startCoordinate - Existing route endpoint in EPSG:2056.
   * @param endCoordinate - Newly selected destination in EPSG:2056.
   * @param signal - Abort signal owned by the caller.
   * @returns Routed path, or `null` after normal coverage/connectivity misses.
   * @throws {RoutingAreaTooLargeError} If either corridor exceeds the safety limit.
   * @throws {Error} When provider loading or graph construction fails.
   */
  private async routeInternal(
    startCoordinate: Coordinate,
    endCoordinate: Coordinate,
    signal: AbortSignal,
  ): Promise<RoutedNetworkPath | null> {
    const initialCellKeys = createCorridorCellKeys(
      startCoordinate,
      endCoordinate,
      ROUTE_CELL_RADIUS,
    );
    let initialPath: RoutedNetworkPath | null = null;

    try {
      const initialNetwork = await this.getNetwork(
        initialCellKeys,
        signal,
      );

      initialPath = initialNetwork.route(startCoordinate, endCoordinate);
    } catch (error) {
      // A narrow corridor can be entirely outside swissTLM3D coverage. The
      // wider retry may still reach a usable network near a national border.
      if (!(error instanceof NoWalkableNetworkError)) {
        throw error;
      }
    }

    if (initialPath) {
      return initialPath;
    }

    // A wider retry allows realistic detours around barriers without paying
    // that loading cost for every segment.

    const retryCellKeys = createCorridorCellKeys(
      startCoordinate,
      endCoordinate,
      ROUTE_RETRY_CELL_RADIUS,
    );

    try {
      const retryNetwork = await this.getNetwork(
        retryCellKeys,
        signal,
      );

      return retryNetwork.route(startCoordinate, endCoordinate);
    } catch (error) {
      // No walkable data after both attempts is a normal coverage miss. The
      // route editor can preserve continuity with a straight fallback segment.
      if (error instanceof NoWalkableNetworkError) {
        return null;
      }

      throw error;
    }
  }

  /**
   * Returns a graph for one exact set of cells, loading and merging missing data.
   * @param cellKeys - Exact corridor cells required by this routing attempt.
   * @param signal - Abort signal shared by cell requests.
   * @returns Cached or newly built immutable routing graph.
   * @throws {RoutingAreaTooLargeError} When the set exceeds the per-operation cell limit.
   * @throws {Error} When cell loading or graph construction fails.
   */
  private async getNetwork(
    cellKeys: Set<CellKey>,
    signal: AbortSignal,
  ): Promise<RoutableNetwork> {
    if (cellKeys.size > MAX_CELLS_PER_OPERATION) {
      throw new RoutingAreaTooLargeError();
    }

    // Sorting makes the cache key independent of insertion order.
    const cacheKey = [...cellKeys].sort().join('|');
    const cachedNetworkIndex = this.networkCache.findIndex(
      (entry) => entry.key === cacheKey,
    );
    const reusedNetwork = this.networkCache[cachedNetworkIndex];

    if (reusedNetwork) {
      // Promote a reused graph so the bounded cache evicts the least-recently
      // used corridor rather than the oldest corridor regardless of access.
      if (cachedNetworkIndex > 0) {
        this.networkCache.splice(cachedNetworkIndex, 1);
        this.networkCache.unshift(reusedNetwork);
      }

      return reusedNetwork.network;
    }

    const loadResults = await mapWithConcurrency(
      [...cellKeys],
      CELL_LOAD_CONCURRENCY,
      async (key): Promise<LoadedCellResult> => {
        try {
          return { key, cell: await this.loadCell(key, signal) };
        } catch (error) {
          if (isRoutingCoverageError(error)) {
            return { key, coverageError: error };
          }

          throw error;
        }
      },
    );
    const coveredResults = loadResults.filter(
      (result): result is LoadedCellResult & { cell: LoadedCell } =>
        result.cell !== undefined,
    );

    if (coveredResults.length === 0) {
      // A completely out-of-region request remains explicit. When only halo
      // cells are outside coverage, the covered cells still form a usable
      // partial corridor instead of turning valid edge data into a network error.
      throw (
        loadResults.find((result) => result.coverageError)?.coverageError ??
        new NoWalkableNetworkError()
      );
    }

    const coveredCellKeys = new Set(coveredResults.map((result) => result.key));
    const cells = coveredResults.map((result) => result.cell);
    let network: RoutableNetwork;

    if (this.options.precomputedBinaryCellLoader) {
      const binaryCells = cells.map((cell) => {
        if (cell.kind !== 'precomputed-binary') {
          throw new Error('Routing cell provider returned mixed representations.');
        }

        return cell.graph;
      });
      network = BinaryRoutingNetwork.fromCells(
        combinedExtent(coveredCellKeys),
        binaryCells,
      );
    } else {
      const geometryCells = cells.map((cell) => {
        if (cell.kind !== 'geometry') {
          throw new Error('Routing cell provider returned mixed representations.');
        }

        return cell;
      });
      const data: SwissTlmNetworkData = {
        roads: mergeFeatures(geometryCells, (cellData) => cellData.roads),
        hikingTrails: mergeFeatures(
          geometryCells,
          (cellData) => cellData.hikingTrails,
        ),
      };
      network = RoutingNetwork.fromSwissTlm(
        combinedExtent(coveredCellKeys),
        data,
      );
    }

    // Most-recently-built graphs stay at the front. Both a count and a byte
    // budget bound retained JavaScript object graphs on memory-constrained devices.
    const cachedNetwork: CachedNetwork = {
      key: cacheKey,
      network,
      estimatedBytes: network.estimatedMemoryBytes,
    };
    this.networkCache.unshift(cachedNetwork);
    this.networkCacheBytes += cachedNetwork.estimatedBytes;

    while (
      this.networkCache.length > 1 &&
      (this.networkCache.length > NETWORK_CACHE_LIMIT ||
        this.networkCacheBytes > MAX_NETWORK_CACHE_BYTES)
    ) {
      const evicted = this.networkCache.pop();
      if (evicted) {
        this.networkCacheBytes -= evicted.estimatedBytes;
      }
    }

    return network;
  }

  /** Returns a consistent AbortError for one cancelled consumer. */
  private abortReason(signal: AbortSignal): unknown {
    return signal.reason ?? new DOMException('Aborted', 'AbortError');
  }

  /**
   * Attaches one caller to a cell-owned request without allowing that caller to
   * cancel work still required by another route operation.
   */
  private consumePendingCell(
    pending: PendingCell,
    signal: AbortSignal,
  ): Promise<LoadedCell> {
    this.ensureActive();

    if (signal.aborted) {
      return Promise.reject(this.abortReason(signal));
    }

    pending.consumers += 1;

    return new Promise<LoadedCell>((resolve, reject) => {
      let active = true;

      const release = (): void => {
        pending.consumers -= 1;
        if (
          pending.consumers === 0 &&
          !pending.settled &&
          !pending.controller.signal.aborted
        ) {
          pending.controller.abort();
        }
      };
      const cleanup = (): void => {
        signal.removeEventListener('abort', onAbort);
      };
      const onAbort = (): void => {
        if (!active) {
          return;
        }
        active = false;
        cleanup();
        release();
        reject(this.abortReason(signal));
      };

      signal.addEventListener('abort', onAbort, { once: true });
      pending.promise.then(
        (cell) => {
          if (!active) {
            return;
          }
          active = false;
          cleanup();
          release();
          resolve(cell);
        },
        (error) => {
          if (!active) {
            return;
          }
          active = false;
          cleanup();
          release();
          reject(error);
        },
      );
    });
  }

  /**
   * Returns a completed cell or shares a cell-owned active request for the same
   * key. The provider request is cancelled only after every consumer leaves.
   * @param key - Stable routing-cell identifier.
   * @param signal - Abort signal owned by this consumer only.
   * @returns Completed cell or the shared in-flight result.
   * @throws {Error} Propagates provider request and parsing failures.
   */
  private loadCell(
    key: CellKey,
    signal: AbortSignal,
  ): Promise<LoadedCell> {
    if (signal.aborted) {
      return Promise.reject(this.abortReason(signal));
    }

    const loadedEntry = this.loadedCells.get(key);

    if (loadedEntry) {
      // Map insertion order acts as the raw-cell LRU. Reinsert a hit so the
      // oldest untouched cell is evicted first when the byte budget is exceeded.
      this.loadedCells.delete(key);
      this.loadedCells.set(key, loadedEntry);
      return Promise.resolve(loadedEntry.cell);
    }

    const existingPending = this.pendingCells.get(key);

    if (existingPending && !existingPending.controller.signal.aborted) {
      return this.consumePendingCell(existingPending, signal);
    }

    if (existingPending) {
      this.pendingCells.delete(key);
    }

    const extent = extentForCellKey(key);
    const controller = new AbortController();
    const pending: PendingCell = {
      promise: Promise.resolve(undefined as never),
      controller,
      consumers: 0,
      settled: false,
    };
    const cellPromise: Promise<LoadedCell> = this.options
      .precomputedBinaryCellLoader
      ? this.options
          .precomputedBinaryCellLoader(key, controller.signal)
          .then((graph): LoadedBinaryPrecomputedCell => ({
            kind: 'precomputed-binary',
            graph,
          }))
      : (
          this.options.geometryCellLoader
            ? this.options.geometryCellLoader(key, controller.signal)
            : fetchSwissTlmNetworkData(extent, controller.signal, {
                allowEmpty: true,
                shouldRequestHikingEnrichment: () =>
                  this.hikingEnrichmentEnabled,
                onHikingEnrichmentUnavailable: () =>
                  this.disableHikingEnrichment(),
                onDiagnostics: (diagnostics) =>
                  this.reportProviderDiagnostics(diagnostics),
              })
        ).then((data): LoadedGeometryCell => ({
          kind: 'geometry',
          data,
        }));

    pending.promise = cellPromise
      .then((cell): LoadedCell => {
        if (this.disposed) {
          return cell;
        }

        const estimatedBytes = estimateLoadedCellBytes(cell);
        const previous = this.loadedCells.get(key);

        if (previous) {
          this.loadedCellCacheBytes -= previous.estimatedBytes;
          this.loadedCells.delete(key);
        }

        this.loadedCells.set(key, { cell, estimatedBytes });
        this.loadedCellCacheBytes += estimatedBytes;

        while (
          this.loadedCells.size > 1 &&
          this.loadedCellCacheBytes > MAX_LOADED_CELL_CACHE_BYTES
        ) {
          const oldestKey = this.loadedCells.keys().next().value as
            | CellKey
            | undefined;

          if (oldestKey === undefined) {
            break;
          }

          const evicted = this.loadedCells.get(oldestKey);
          this.loadedCells.delete(oldestKey);
          if (evicted) {
            this.loadedCellCacheBytes -= evicted.estimatedBytes;
          }
        }

        return cell;
      })
      .finally(() => {
        pending.settled = true;
        if (this.pendingCells.get(key) === pending) {
          this.pendingCells.delete(key);
        }
      });

    this.pendingCells.set(key, pending);
    return this.consumePendingCell(pending, signal);
  }
}
