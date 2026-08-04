/**
 * Business context: runs reproducible routing-policy comparisons away from the
 * simulator page. Each GPX scenario gets fresh legacy and certified engines so
 * only their corridor policy differs; binary cells and A* remain off the UI
 * thread just as they do in the production application.
 */
import type { Coordinate } from 'ol/coordinate.js';
import {
  DynamicRoutingNetworkEngine,
  type BinaryRoutingCorridorPolicy,
  type CertifiedRoutingAttemptDiagnostic,
  type RoutingNetworkAccessDiagnostic,
  type LegacyRoutingAttemptDiagnostic,
} from '../../src/routing/dynamicRoutingEngine';
import {
  createPrecomputedBinaryRoutingCellLoader,
  type PrecomputedBinaryRoutingCellLoader,
} from '../../src/routing/precomputedBinaryRoutingData';
import type { PrecomputedBinaryRoutingCell } from '../../src/routing/precomputedBinaryRoutingFormat';
import { normalizeRoutingDataBaseUrl } from '../../src/routing/routingConfig';
import { assertNetworkRouteSectionDistance } from '../../src/routing/routeSectionLimit';
import type { CellKey } from '../../src/routing/routingGrid';
import type {
  RoutingSimulatorComparison,
  RoutingSimulatorPolicy,
  RoutingSimulatorPolicyResult,
  RoutingSimulatorScenario,
  RoutingSimulatorScenarioResult,
  RoutingSimulatorSectionResult,
  RoutingSimulatorWorkerRequest,
  RoutingSimulatorWorkerResponse,
} from './protocol';

/** Published integrity inventory entry used to recover intrinsic Brotli sizes. */
interface PublishedIntegrityEntry {
  /** Path relative to the published dataset root. */
  path?: unknown;
  /** Exact compressed object size in bytes. */
  sizeBytes?: unknown;
}

/** Untrusted published integrity payload. */
interface PublishedIntegrityPayload {
  /** Published compressed objects. */
  files?: unknown;
}

/** Mutable measurements collected around one engine session. */
interface PolicyMeasurements {
  /** Binary keys requested after the engine's raw-cell cache missed. */
  cellLoadKeys: CellKey[];
  /** Decoded bytes corresponding to every logical cell load. */
  decodedBytes: number;
  /** Graphs assembled from exact cell signatures. */
  graphBuildCount: number;
  /** Exact-signature graph-cache hits. */
  graphReuseCount: number;
  /** Conservative bytes of all newly assembled graphs. */
  graphBuiltBytes: number;
  /** Metric-envelope decisions emitted by the certified engine. */
  metricAttempts: CertifiedRoutingAttemptDiagnostic[];
  /** Radius-based decisions emitted by either policy. */
  legacyAttempts: LegacyRoutingAttemptDiagnostic[];
}

/** Internal section result retaining geometry until both policies are compared. */
interface InternalSectionResult extends RoutingSimulatorSectionResult {
  /** Displayed route geometry in LV95. */
  coordinates: Coordinate[];
}

/** Internal policy result retaining section geometry. */
interface InternalPolicyResult extends Omit<RoutingSimulatorPolicyResult, 'sections'> {
  /** Section results with temporary route geometry. */
  sections: InternalSectionResult[];
}

/** Active batch cancellation shared by all current simulator operations. */
let activeController: AbortController | null = null;

/** Posts a typed response without exposing Worker implementation details. */
function postResponse(response: RoutingSimulatorWorkerResponse): void {
  postMessage(response);
}

/** Normalizes one published compressed-cell path to a routing-grid key. */
function cellKeyFromIntegrityPath(path: string): CellKey | null {
  const match = /(?:^|\/)cells\/(-?\d+)_(-?\d+)\.bin\.br$/.exec(path);
  return match ? (`${match[1]}:${match[2]}` as CellKey) : null;
}

/**
 * Loads compressed object sizes once so both policies are compared against the
 * same intrinsic payload sizes rather than browser-cache-dependent transfer
 * timing from the current run.
 */
async function loadCompressedCellSizes(
  baseUrl: string,
  signal: AbortSignal,
): Promise<{ sizes: Map<CellKey, number>; warning: string | null }> {
  try {
    const response = await fetch(`${baseUrl}/integrity.json`, { signal });

    if (!response.ok) {
      throw new Error(`integrity.json request failed (${response.status}).`);
    }

    const payload = (await response.json()) as PublishedIntegrityPayload;
    const files = Array.isArray(payload.files)
      ? (payload.files as PublishedIntegrityEntry[])
      : null;

    if (!files) {
      throw new Error('integrity.json does not contain a file inventory.');
    }

    const sizes = new Map<CellKey, number>();

    for (const entry of files) {
      if (
        typeof entry.path !== 'string' ||
        typeof entry.sizeBytes !== 'number' ||
        !Number.isFinite(entry.sizeBytes) ||
        entry.sizeBytes < 0
      ) {
        continue;
      }

      const key = cellKeyFromIntegrityPath(entry.path);
      if (key) {
        sizes.set(key, entry.sizeBytes);
      }
    }

    if (sizes.size === 0) {
      throw new Error('integrity.json contains no recognized Brotli cells.');
    }

    return { sizes, warning: null };
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }

    return {
      sizes: new Map(),
      warning:
        'Compressed-byte totals are unavailable because integrity.json could not be read: ' +
        (error instanceof Error ? error.message : String(error)),
    };
  }
}

/** Horizontal length of one displayed route section. */
function routeDistance(coordinates: readonly Coordinate[]): number {
  let distance = 0;

  for (let index = 1; index < coordinates.length; index += 1) {
    distance += Math.hypot(
      coordinates[index][0] - coordinates[index - 1][0],
      coordinates[index][1] - coordinates[index - 1][1],
    );
  }

  return distance;
}

/** Updates one 32-bit FNV-1a hash with a signed centimetre coordinate value. */
function updateHash(hash: number, value: number): number {
  let nextHash = hash;
  const normalized = value | 0;

  for (let byte = 0; byte < 4; byte += 1) {
    nextHash ^= (normalized >>> (byte * 8)) & 0xff;
    nextHash = Math.imul(nextHash, 0x01000193);
  }

  return nextHash >>> 0;
}

/** Stable route hash independent of floating-point serialization details. */
function geometryHash(coordinates: readonly Coordinate[]): string {
  let hash = 0x811c9dc5;

  for (const coordinate of coordinates) {
    hash = updateHash(hash, Math.round(coordinate[0] * 100));
    hash = updateHash(hash, Math.round(coordinate[1] * 100));
  }

  return hash.toString(16).padStart(8, '0');
}

/** Squared distance from one point to one finite line segment. */
function squaredPointToSegmentDistance(
  point: Coordinate,
  start: Coordinate,
  end: Coordinate,
): number {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared === 0) {
    return (point[0] - start[0]) ** 2 + (point[1] - start[1]) ** 2;
  }

  const fraction = Math.min(
    1,
    Math.max(
      0,
      ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) /
        lengthSquared,
    ),
  );
  const projectedX = start[0] + fraction * dx;
  const projectedY = start[1] + fraction * dy;
  return (point[0] - projectedX) ** 2 + (point[1] - projectedY) ** 2;
}

/** Minimum distance from one point to an ordered polyline. */
function pointToPolylineDistance(
  point: Coordinate,
  line: readonly Coordinate[],
): number {
  let bestSquaredDistance = Number.POSITIVE_INFINITY;

  for (let index = 1; index < line.length; index += 1) {
    bestSquaredDistance = Math.min(
      bestSquaredDistance,
      squaredPointToSegmentDistance(point, line[index - 1], line[index]),
    );
  }

  return Math.sqrt(bestSquaredDistance);
}

/** Samples at most 120 source vertices while preserving both endpoints. */
function sampledVertices(coordinates: readonly Coordinate[]): Coordinate[] {
  if (coordinates.length <= 120) {
    return coordinates.map((coordinate) => [...coordinate]);
  }

  const samples: Coordinate[] = [];
  const lastIndex = coordinates.length - 1;

  for (let sampleIndex = 0; sampleIndex < 120; sampleIndex += 1) {
    const sourceIndex = Math.round((sampleIndex / 119) * lastIndex);
    samples.push([...coordinates[sourceIndex]]);
  }

  return samples;
}

/** Symmetric sampled deviation used only when exact route hashes differ. */
function sampledSymmetricDeviation(
  first: readonly Coordinate[],
  second: readonly Coordinate[],
): number {
  let maximumDeviation = 0;

  for (const point of sampledVertices(first)) {
    maximumDeviation = Math.max(
      maximumDeviation,
      pointToPolylineDistance(point, second),
    );
  }

  for (const point of sampledVertices(second)) {
    maximumDeviation = Math.max(
      maximumDeviation,
      pointToPolylineDistance(point, first),
    );
  }

  return maximumDeviation;
}

/** Creates one cell-loader wrapper that records logical engine cache misses. */
function measuredCellLoader(
  loader: PrecomputedBinaryRoutingCellLoader,
  measurements: PolicyMeasurements,
): PrecomputedBinaryRoutingCellLoader {
  return async (
    key: CellKey,
    signal: AbortSignal,
  ): Promise<PrecomputedBinaryRoutingCell> => {
    const cell = await loader(key, signal);
    measurements.cellLoadKeys.push(key);
    measurements.decodedBytes += cell.buffer.byteLength;
    return cell;
  };
}

/** Records graph-cache behaviour without changing routing decisions. */
function recordNetworkAccess(
  measurements: PolicyMeasurements,
  diagnostic: RoutingNetworkAccessDiagnostic,
): void {
  if (diagnostic.outcome === 'built') {
    measurements.graphBuildCount += 1;
    measurements.graphBuiltBytes += diagnostic.estimatedBytes;
  } else {
    measurements.graphReuseCount += 1;
  }
}

/** Executes one complete synthetic route creation with a fresh engine cache. */
async function runPolicy(
  scenario: RoutingSimulatorScenario,
  policy: RoutingSimulatorPolicy,
  rawLoader: PrecomputedBinaryRoutingCellLoader,
  compressedCellSizes: ReadonlyMap<CellKey, number>,
  signal: AbortSignal,
): Promise<InternalPolicyResult> {
  const measurements: PolicyMeasurements = {
    cellLoadKeys: [],
    decodedBytes: 0,
    graphBuildCount: 0,
    graphReuseCount: 0,
    graphBuiltBytes: 0,
    metricAttempts: [],
    legacyAttempts: [],
  };
  const engine = new DynamicRoutingNetworkEngine({
    precomputedBinaryCellLoader: measuredCellLoader(rawLoader, measurements),
    binaryCorridorPolicy: policy as BinaryRoutingCorridorPolicy,
    onCertifiedRoutingAttempt: (diagnostic) => {
      measurements.metricAttempts.push(diagnostic);
    },
    onLegacyRoutingAttempt: (diagnostic) => {
      measurements.legacyAttempts.push(diagnostic);
    },
    onRoutingNetworkAccess: (diagnostic) => {
      recordNetworkAccess(measurements, diagnostic);
    },
  });
  const startTime = performance.now();
  const sections: InternalSectionResult[] = [];

  try {
    const firstClick = scenario.waypoints[0];
    const snappedStart = await engine.snap(firstClick, signal);
    let currentWaypoint = snappedStart
      ? [...snappedStart]
      : [...firstClick];

    for (let index = 1; index < scenario.waypoints.length; index += 1) {
      const target = scenario.waypoints[index];
      assertNetworkRouteSectionDistance(currentWaypoint, target);
      const path = await engine.route(currentWaypoint, target, signal);
      const coordinates = path
        ? path.coordinates.map((coordinate) => [...coordinate])
        : [[...currentWaypoint], [...target]];

      sections.push({
        sectionIndex: index - 1,
        routed: path !== null,
        coordinateCount: coordinates.length,
        distanceMetres: routeDistance(coordinates),
        geometryHash: geometryHash(coordinates),
        coordinates,
      });
      currentWaypoint = path
        ? [...coordinates[coordinates.length - 1]]
        : [...target];
    }
  } finally {
    engine.dispose();
  }

  const uniqueCellKeys = new Set(measurements.cellLoadKeys);
  let compressedBytes: number | null =
    compressedCellSizes.size > 0 ? 0 : null;

  if (compressedBytes !== null) {
    for (const key of measurements.cellLoadKeys) {
      const size = compressedCellSizes.get(key);
      if (size === undefined) {
        compressedBytes = null;
        break;
      }
      compressedBytes += size;
    }
  }

  const metricOutcomeCounts: Record<string, number> = {};
  for (const attempt of measurements.metricAttempts) {
    metricOutcomeCounts[attempt.outcome] =
      (metricOutcomeCounts[attempt.outcome] ?? 0) + 1;
  }

  return {
    policy,
    waypointCount: scenario.waypoints.length,
    sectionCount: sections.length,
    routedSectionCount: sections.filter((section) => section.routed).length,
    straightSectionCount: sections.filter((section) => !section.routed).length,
    uniqueCellCount: uniqueCellKeys.size,
    cellLoadCount: measurements.cellLoadKeys.length,
    compressedBytes,
    decodedBytes: measurements.decodedBytes,
    graphBuildCount: measurements.graphBuildCount,
    graphReuseCount: measurements.graphReuseCount,
    graphBuiltBytes: measurements.graphBuiltBytes,
    metricAttemptCount: measurements.metricAttempts.length,
    legacyAttemptCount: measurements.legacyAttempts.length,
    metricOutcomeCounts,
    routedDistanceMetres: sections.reduce(
      (total, section) => total + section.distanceMetres,
      0,
    ),
    elapsedMilliseconds: performance.now() - startTime,
    sections,
  };
}

/** Compares routing outcomes without treating equal-cost alternatives as errors. */
function comparePolicies(
  legacy: InternalPolicyResult,
  certified: InternalPolicyResult,
): RoutingSimulatorComparison {
  let exactSectionCount = 0;
  let differentGeometrySectionCount = 0;
  let routingOutcomeMismatchCount = 0;
  let maximumSectionDistanceDifferenceMetres = 0;
  let maximumSampledDeviationMetres = 0;
  const sectionCount = Math.max(
    legacy.sections.length,
    certified.sections.length,
  );

  for (let index = 0; index < sectionCount; index += 1) {
    const legacySection = legacy.sections[index];
    const certifiedSection = certified.sections[index];

    if (!legacySection || !certifiedSection) {
      routingOutcomeMismatchCount += 1;
      continue;
    }

    maximumSectionDistanceDifferenceMetres = Math.max(
      maximumSectionDistanceDifferenceMetres,
      Math.abs(
        legacySection.distanceMetres - certifiedSection.distanceMetres,
      ),
    );

    if (legacySection.routed !== certifiedSection.routed) {
      routingOutcomeMismatchCount += 1;
    }

    if (
      legacySection.geometryHash === certifiedSection.geometryHash &&
      legacySection.coordinateCount === certifiedSection.coordinateCount
    ) {
      exactSectionCount += 1;
      continue;
    }

    differentGeometrySectionCount += 1;
    maximumSampledDeviationMetres = Math.max(
      maximumSampledDeviationMetres,
      sampledSymmetricDeviation(
        legacySection.coordinates,
        certifiedSection.coordinates,
      ),
    );
  }

  return {
    exactSectionCount,
    differentGeometrySectionCount,
    routingOutcomeMismatchCount,
    maximumSectionDistanceDifferenceMetres,
    maximumSampledDeviationMetres,
  };
}

/** Removes temporary coordinates before posting compact result rows. */
function publicPolicyResult(
  result: InternalPolicyResult,
): RoutingSimulatorPolicyResult {
  return {
    ...result,
    sections: result.sections.map(({ coordinates: _coordinates, ...section }) =>
      section,
    ),
  };
}

/** Runs the current request sequentially to keep browser memory predictable. */
async function runBatch(
  request: Extract<RoutingSimulatorWorkerRequest, { type: 'start' }>,
  controller: AbortController,
): Promise<void> {
  const baseUrl = normalizeRoutingDataBaseUrl(request.routingDataBaseUrl);

  if (!baseUrl) {
    throw new Error('A routing-data base URL is required.');
  }

  const { sizes, warning } = await loadCompressedCellSizes(
    baseUrl,
    controller.signal,
  );
  const legacyLoader = createPrecomputedBinaryRoutingCellLoader(baseUrl);
  const certifiedLoader = createPrecomputedBinaryRoutingCellLoader(baseUrl);

  for (let index = 0; index < request.scenarios.length; index += 1) {
    if (controller.signal.aborted) {
      throw controller.signal.reason ?? new DOMException('Aborted', 'AbortError');
    }

    const scenario = request.scenarios[index];
    // Alternate execution order so browser HTTP caching does not systematically
    // make the same policy look faster. Intrinsic byte counts remain independent.
    const certifiedFirst = index % 2 === 1;
    const firstPolicy = certifiedFirst ? 'certified' : 'legacy';
    const secondPolicy = certifiedFirst ? 'legacy' : 'certified';
    const first = await runPolicy(
      scenario,
      firstPolicy,
      firstPolicy === 'legacy' ? legacyLoader : certifiedLoader,
      sizes,
      controller.signal,
    );
    const second = await runPolicy(
      scenario,
      secondPolicy,
      secondPolicy === 'legacy' ? legacyLoader : certifiedLoader,
      sizes,
      controller.signal,
    );
    const legacy = first.policy === 'legacy' ? first : second;
    const certified = first.policy === 'certified' ? first : second;
    const result: RoutingSimulatorScenarioResult = {
      scenario: {
        id: scenario.id,
        sourceFilename: scenario.sourceFilename,
        sourceName: scenario.sourceName,
        scenarioLabel: scenario.scenarioLabel,
        sourceDistanceMetres: scenario.sourceDistanceMetres,
        waypointCount: scenario.waypoints.length,
      },
      legacy: publicPolicyResult(legacy),
      certified: publicPolicyResult(certified),
      comparison: comparePolicies(legacy, certified),
    };

    postResponse({
      type: 'progress',
      completed: index + 1,
      total: request.scenarios.length,
      result,
    });
  }

  postResponse({ type: 'complete', warning });
}

addEventListener(
  'message',
  (event: MessageEvent<RoutingSimulatorWorkerRequest>) => {
    if (event.data.type === 'cancel') {
      activeController?.abort(new DOMException('Cancelled', 'AbortError'));
      return;
    }

    activeController?.abort(new DOMException('Superseded', 'AbortError'));
    const controller = new AbortController();
    activeController = controller;

    void runBatch(event.data, controller)
      .catch((error) => {
        if (controller.signal.aborted) {
          postResponse({ type: 'cancelled' });
          return;
        }

        postResponse({
          type: 'error',
          name: error instanceof Error ? error.name : 'Error',
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
      })
      .finally(() => {
        if (activeController === controller) {
          activeController = null;
        }
      });
  },
);
