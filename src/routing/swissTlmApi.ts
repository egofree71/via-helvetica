/**
 * Business context: retrieves the swissTLM3D road network and optional official
 * hiking-trail enrichment used by the browser-side router. GeoAdmin's identify API
 * is queried in bounded tiles, dense tiles are subdivided to respect the
 * per-request result cap, and overlapping responses are normalized and
 * deduplicated before graph construction.
 */
import type { Coordinate } from 'ol/coordinate.js';
import type { Extent } from 'ol/extent.js';
import { isAbortedRequest } from '../network/abort';

/** Official GeoAdmin identify endpoint used for bounded vector queries. */
const IDENTIFY_ENDPOINT =
  'https://api3.geo.admin.ch/rest/services/ech/MapServer/identify';
/** swissTLM3D road and path layer used to build the pedestrian graph. */
const ROAD_LAYER_ID = 'ch.swisstopo.swisstlm3d-strassen';
/**
 * Official hiking-trail portrayal used only as optional routing enrichment.
 * GeoAdmin does not advertise tooltip/feature inspection for this layer, so a
 * failure must never make the required road-and-path network unavailable.
 */
const HIKING_LAYER_ID = 'ch.swisstopo.swisstlm3d-wanderwege';
/**
 * Initial request tile width and height in metres. Smaller tiles reduce the
 * chance of hitting the API result cap.
 */
const TILE_SIZE = 1_200;
/** Maximum number of features returned per layer by one identify request. */
const RESULT_LIMIT = 200;
/**
 * Maximum quadtree depth. At 1,200 metres this permits cells down to 150 metres
 * before failing explicitly.
 */
const MAX_SUBDIVISION_DEPTH = 3;
/**
 * Maximum number of initial tile requests in flight. Recursive child requests
 * stay sequential within each worker.
 */
const REQUEST_CONCURRENCY = 4;
/** Coordinate precision in metres used only for deterministic fallback IDs. */
const FALLBACK_ID_PRECISION = 0.1;
/** Maximum time allowed for one GeoAdmin identify attempt. */
const REQUEST_TIMEOUT_MS = 15_000;
/** Minimum pause before the single retry of a transient request failure. */
const RETRY_BASE_DELAY_MS = 400;
/** Random extra pause that prevents concurrent failed tiles retrying together. */
const RETRY_JITTER_MS = 600;
/**
 * Long server-requested pauses are not retried inside an interactive route edit.
 * Waiting longer would make the operation appear frozen and could still violate
 * the provider's requested retry window.
 */
const MAX_RETRY_AFTER_MS = 15_000;
/** HTTP statuses that are commonly transient and safe to retry once. */
const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 502, 503, 504]);

/** Distinguishes a bounded request timeout from an intentional route cancellation. */
class GeoAdminRequestTimeoutError extends Error {
  constructor() {
    super(`GeoAdmin identify request timed out after ${REQUEST_TIMEOUT_MS} ms.`);
    this.name = 'GeoAdminRequestTimeoutError';
  }
}

/** HTTP failure retaining its status so layer-specific fallbacks stay selective. */
class GeoAdminIdentifyHttpError extends Error {
  /** HTTP status returned by GeoAdmin. */
  readonly status: number;

  constructor(status: number) {
    super(`GeoAdmin identify request failed (${status}).`);
    this.name = 'GeoAdminIdentifyHttpError';
    this.status = status;
  }
}

/** Untrusted GeoJSON-like geometry returned by GeoAdmin. */
interface IdentifyGeometry {
  /** Geometry type; only LineString and MultiLineString are accepted. */
  type?: string;
  /** Raw coordinate payload validated before it enters routing code. */
  coordinates?: unknown;
}

/** One untrusted feature result returned by the identify endpoint. */
interface IdentifyResult {
  /** Preferred provider feature identifier when available. */
  featureId?: string | number;
  /** Alternate feature identifier used by some response variants. */
  id?: string | number;
  /** Layer identifier used to separate roads from the hiking overlay. */
  layerBodId?: string;
  /** Optional raw geometry. */
  geometry?: IdentifyGeometry;
  /** Preferred attribute container returned by current GeoAdmin responses. */
  properties?: Record<string, unknown>;
  /** Legacy attribute container accepted for compatibility. */
  attributes?: Record<string, unknown>;
}

/** Top-level identify response; all fields remain optional because the API is external. */
interface IdentifyResponse {
  /** Feature results, or no value for an empty/malformed response. */
  results?: IdentifyResult[];
}

/** One bounded identify request in the adaptive quadtree. */
interface TileRequest {
  /** Request extent in EPSG:2056 map coordinates. */
  extent: Extent;
  /** Current subdivision depth, starting at zero. */
  depth: number;
}

/** Normalized swissTLM3D attributes used by the routing cost model. */
export interface SwissTlmRoadAttributes {
  /** swissTLM3D object-type code describing road/path width and role. */
  objectType?: number;
  /** Traffic-restriction code used to identify pedestrian access and prohibitions. */
  restriction?: number;
  /** Surface code used for a small paved/unpaved preference adjustment. */
  surface?: number;
  /** Network-importance code used to penalize major roads. */
  importance?: number;
}

/** Normalized line feature suitable for graph construction. */
export interface SwissTlmLineFeature {
  /** Stable provider identifier, or a deterministic geometry fallback. */
  id: string;
  /** One or more validated line strings in EPSG:2056, preserving elevation when supplied. */
  lines: Coordinate[][];
  /** Normalized road attributes; hiking-overlay features usually leave them empty. */
  attributes: SwissTlmRoadAttributes;
  /**
   * Precomputed hiking classification when the source can attach it directly
   * to the road feature. GeoAdmin road features leave this undefined and still
   * use geometric matching against the optional hiking layer.
   */
  isHikingTrail?: boolean;
}

/** Combined source data needed to build one RoutingNetwork. */
export interface SwissTlmNetworkData {
  /** Road and path features that become graph edges. */
  roads: SwissTlmLineFeature[];
  /** Hiking-overlay features used to classify preferred graph edges. */
  hikingTrails: SwissTlmLineFeature[];
}

/** Diagnostics measured from one real GeoAdmin network load. */
export interface SwissTlmNetworkDiagnostics {
  /** Number of road coordinates accepted after geometry validation. */
  roadCoordinates: number;
  /** Number of accepted road coordinates carrying a finite Z value. */
  roadCoordinatesWithZ: number;
  /** Number of provider IDs reused for a different validated geometry. */
  conflictingFeatureIds: number;
}

/** Result of collision-safe source-feature merging. */
export interface SwissTlmFeatureMergeResult {
  /** Deduplicated features, retaining conflicting geometries under derived IDs. */
  features: SwissTlmLineFeature[];
  /** Number of same-ID/different-geometry conflicts observed. */
  conflictingFeatureIds: number;
}

/** Progress snapshot for a tiled network load. */
export interface NetworkLoadProgress {
  /** Number of identify requests that have completed. */
  completedRequests: number;
  /** Current expected request count, which can grow when dense tiles subdivide. */
  totalRequests: number;
}

/** Normalized contents and raw result counts for one identify tile. */
interface ParsedTile {
  /** Valid road/path features found in the tile. */
  roads: SwissTlmLineFeature[];
  /** Valid hiking-overlay features found in the tile. */
  hikingTrails: SwissTlmLineFeature[];
  /** Raw road result count used to detect an API-capped response. */
  roadResultCount: number;
  /** Raw hiking result count used to detect an API-capped response. */
  hikingResultCount: number;
}

/** Receives progress updates while requests and subdivisions complete. */
type ProgressCallback = (progress: NetworkLoadProgress) => void;

/** Optional behavior for a bounded swissTLM3D network load. */
export interface NetworkLoadOptions {
  /** Accept a tile with no roads, which is necessary near lakes and national borders. */
  allowEmpty?: boolean;
  /** Called whenever completed or expected request counts change. */
  onProgress?: ProgressCallback;
  /**
   * Returns whether the shared routing session should still request optional
   * hiking geometry. A callback keeps concurrently loaded cells synchronized
   * after the first layer-specific failure.
   */
  shouldRequestHikingEnrichment?: () => boolean;
  /**
   * Disables hiking enrichment for the shared routing session after GeoAdmin
   * rejects the non-guaranteed combined layer request.
   */
  onHikingEnrichmentUnavailable?: () => void;
  /** Receives measured ID and Z diagnostics for the completed bounded load. */
  onDiagnostics?: (diagnostics: SwissTlmNetworkDiagnostics) => void;
}

/** Splits an extent into fixed-size initial requests. */
function createTiles(extent: Extent): TileRequest[] {
  const [minX, minY, maxX, maxY] = extent;
  const tiles: TileRequest[] = [];

  for (let x = minX; x < maxX; x += TILE_SIZE) {
    for (let y = minY; y < maxY; y += TILE_SIZE) {
      tiles.push({
        extent: [
          x,
          y,
          Math.min(x + TILE_SIZE, maxX),
          Math.min(y + TILE_SIZE, maxY),
        ],
        depth: 0,
      });
    }
  }

  return tiles;
}

/** Divides a capped tile into four equal child requests. */
function subdivideTile(tile: TileRequest): TileRequest[] {
  const [minX, minY, maxX, maxY] = tile.extent;
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const depth = tile.depth + 1;

  return [
    { extent: [minX, minY, centerX, centerY], depth },
    { extent: [centerX, minY, maxX, centerY], depth },
    { extent: [minX, centerY, centerX, maxY], depth },
    { extent: [centerX, centerY, maxX, maxY], depth },
  ];
}

/** Reads the first finite numeric value from known case variants of an external attribute name. */
function readNumber(
  properties: Record<string, unknown>,
  names: string[],
): number | undefined {
  for (const name of names) {
    const value = properties[name];

    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string') {
      const parsedValue = Number(value);

      if (Number.isFinite(parsedValue)) {
        return parsedValue;
      }
    }
  }

  return undefined;
}

/** Validates an external coordinate and preserves a finite optional elevation. */
function normalizeCoordinate(value: unknown): Coordinate | null {
  if (!Array.isArray(value) || value.length < 2) {
    return null;
  }

  const [x, y, z] = value;

  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    !Number.isFinite(x) ||
    !Number.isFinite(y)
  ) {
    return null;
  }

  return typeof z === 'number' && Number.isFinite(z) ? [x, y, z] : [x, y];
}

/**
 * Splits an external line at invalid coordinates. Dropping a bad midpoint and
 * joining its neighbours would create a synthetic road segment across missing
 * provider data.
 */
function normalizeLine(value: unknown): Coordinate[][] {
  if (!Array.isArray(value)) {
    return [];
  }

  const lines: Coordinate[][] = [];
  let currentLine: Coordinate[] = [];

  const flush = () => {
    if (currentLine.length >= 2) {
      lines.push(currentLine);
    }
    currentLine = [];
  };

  for (const member of value) {
    const coordinate = normalizeCoordinate(member);

    if (!coordinate) {
      flush();
      continue;
    }

    currentLine.push(coordinate);
  }

  flush();
  return lines;
}

/** Converts supported GeoJSON line types into validated coordinate arrays. */
function readLines(geometry: IdentifyGeometry | undefined): Coordinate[][] {
  if (!geometry || !Array.isArray(geometry.coordinates)) {
    return [];
  }

  if (geometry.type === 'LineString') {
    return normalizeLine(geometry.coordinates);
  }

  if (geometry.type === 'MultiLineString') {
    return geometry.coordinates.flatMap(normalizeLine);
  }

  return [];
}

/** Creates a compact deterministic fingerprint from every validated vertex. */
function geometrySignature(lines: Coordinate[][]): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mix = (value: bigint) => {
    hash ^= BigInt.asUintN(64, value);
    hash = BigInt.asUintN(64, hash * prime);
  };

  for (const line of lines) {
    mix(-1n);
    for (const coordinate of line) {
      mix(-2n);
      for (const value of coordinate) {
        mix(BigInt(Math.round(value / FALLBACK_ID_PRECISION)));
      }
    }
  }

  return hash.toString(16).padStart(16, '0');
}

/**
 * Merges features without trusting a provider ID to be globally unique across
 * identify requests. A conflicting geometry is retained under a derived key
 * instead of silently replacing a different road.
 */
export function mergeSwissTlmFeatures(
  values: Iterable<SwissTlmLineFeature>,
): SwissTlmFeatureMergeResult {
  const features = new Map<string, SwissTlmLineFeature>();
  const signatures = new Map<string, string>();
  let conflictingFeatureIds = 0;

  for (const feature of values) {
    const signature = geometrySignature(feature.lines);
    const existingSignature = signatures.get(feature.id);

    if (existingSignature === undefined) {
      features.set(feature.id, feature);
      signatures.set(feature.id, signature);
      continue;
    }

    if (existingSignature === signature) {
      continue;
    }

    const signatureId = `${feature.id}#${signature}`;

    // A conflicting geometry can itself cross several request tiles. Its
    // derived signature must therefore deduplicate repeated copies just like
    // the provider ID does for the first geometry.
    if (signatures.get(signatureId) === signature) {
      continue;
    }

    conflictingFeatureIds += 1;
    let derivedId = signatureId;
    let suffix = 2;

    while (features.has(derivedId)) {
      derivedId = `${signatureId}-${suffix}`;
      suffix += 1;
    }

    const retainedFeature = { ...feature, id: derivedId };
    features.set(derivedId, retainedFeature);
    signatures.set(derivedId, signature);
  }

  return { features: [...features.values()], conflictingFeatureIds };
}

/**
 * Normalizes one GeoAdmin feature while tolerating response-field variants.
 * @returns A valid line feature, or `null` when geometry is missing or unusable.
 */
function parseFeature(result: IdentifyResult): SwissTlmLineFeature | null {
  const lines = readLines(result.geometry);

  if (lines.length === 0) {
    return null;
  }

  const properties = result.properties ?? result.attributes ?? {};
  // Provider IDs are retained for diagnostics, while the full-geometry
  // fingerprint supplies a stable fallback when the response has no ID.
  const providerId = result.featureId ?? result.id;
  const fallbackId = `geometry:${geometrySignature(lines)}`;

  return {
    id: providerId === undefined ? fallbackId : String(providerId),
    lines,
    attributes: {
      objectType: readNumber(properties, ['objektart', 'OBJEKTART']),
      restriction: readNumber(properties, [
        'verkehrsbeschraenkung',
        'VERKEHRSBESCHRAENKUNG',
      ]),
      surface: readNumber(properties, ['belagsart', 'BELAGSART']),
      importance: readNumber(properties, [
        'verkehrsbedeutung',
        'VERKEHRSBEDEUTUNG',
      ]),
    },
  };
}

/**
 * Separates and normalizes road and hiking results while retaining raw counts
 * for cap detection.
 */
function parseTile(response: IdentifyResponse): ParsedTile {
  const roads: SwissTlmLineFeature[] = [];
  const hikingTrails: SwissTlmLineFeature[] = [];
  let roadResultCount = 0;
  let hikingResultCount = 0;

  for (const result of response.results ?? []) {
    if (result.layerBodId === ROAD_LAYER_ID) {
      roadResultCount += 1;
      const feature = parseFeature(result);

      if (feature) {
        roads.push(feature);
      }
    } else if (result.layerBodId === HIKING_LAYER_ID) {
      hikingResultCount += 1;
      const feature = parseFeature(result);

      if (feature) {
        hikingTrails.push(feature);
      }
    }
  }

  return {
    roads,
    hikingTrails,
    roadResultCount,
    hikingResultCount,
  };
}

/** Creates the randomized pause used when no provider delay is supplied. */
function createRetryDelay(): number {
  return RETRY_BASE_DELAY_MS + Math.random() * RETRY_JITTER_MS;
}

/** Reads a Retry-After header expressed as seconds or as an HTTP date. */
function readRetryAfterMs(response: Response): number | null {
  const value = response.headers.get('Retry-After');

  if (!value) {
    return null;
  }

  const seconds = Number(value);

  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1_000;
  }

  const retryDate = Date.parse(value);
  return Number.isFinite(retryDate) ? Math.max(0, retryDate - Date.now()) : null;
}

/**
 * Returns the delay for the single retry, or `null` when the response should be
 * surfaced immediately. A long Retry-After is deliberately not shortened.
 */
function getResponseRetryDelay(response: Response): number | null {
  if (!RETRYABLE_HTTP_STATUSES.has(response.status)) {
    return null;
  }

  if (response.status !== 429) {
    return createRetryDelay();
  }

  const retryAfterMs = readRetryAfterMs(response);

  if (retryAfterMs === null) {
    return createRetryDelay();
  }

  return retryAfterMs <= MAX_RETRY_AFTER_MS ? retryAfterMs : null;
}

/** Waits before a retry while still reacting immediately to route cancellation. */
function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'));
  }

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      signal.removeEventListener('abort', handleAbort);
      resolve();
    }, delayMs);

    const handleAbort = () => {
      clearTimeout(timeoutId);
      reject(new DOMException('Aborted', 'AbortError'));
    };

    signal.addEventListener('abort', handleAbort, { once: true });
  });
}

/** Response and optional successful payload produced by one bounded attempt. */
interface IdentifyAttemptResult {
  /** Raw response retained for status and Retry-After handling. */
  response: Response;
  /** Parsed JSON payload, present only for a successful response. */
  payload?: IdentifyResponse;
}

/**
 * Executes one complete identify attempt with its own timeout while preserving
 * the caller-owned signal. The timeout covers response headers and JSON body
 * consumption, while the explicit flag keeps it distinct from route cancellation.
 */
async function fetchIdentifyAttempt(
  url: string,
  signal: AbortSignal,
): Promise<IdentifyAttemptResult> {
  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  const attemptController = new AbortController();
  let timedOut = false;

  const handleAbort = () => {
    attemptController.abort();
  };

  signal.addEventListener('abort', handleAbort, { once: true });
  const timeoutId = setTimeout(() => {
    timedOut = true;
    attemptController.abort();
  }, REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: attemptController.signal });

    if (!response.ok) {
      return { response };
    }

    return {
      response,
      payload: (await response.json()) as IdentifyResponse,
    };
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }

    if (timedOut) {
      throw new GeoAdminRequestTimeoutError();
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
    signal.removeEventListener('abort', handleAbort);
  }
}

/** Network failures exposed by fetch are TypeError; timeouts use a named error. */
function isRetryableFetchFailure(error: unknown): boolean {
  return error instanceof TypeError || error instanceof GeoAdminRequestTimeoutError;
}

/**
 * Fetches one identify tile for an explicit layer set.
 * @param tile - Tile extent and current subdivision depth.
 * @param layerIds - Technical GeoAdmin layers requested together.
 * @param signal - Abort signal owned by the current route operation.
 * @returns Normalized tile contents and cap-detection counts.
 * @throws {Error} When both attempts fail or GeoAdmin returns a non-retryable status.
 * @throws {DOMException} When the route operation is intentionally aborted.
 */
async function fetchTileForLayers(
  tile: TileRequest,
  layerIds: string[],
  signal: AbortSignal,
): Promise<ParsedTile> {
  const extentText = tile.extent.join(',');
  const parameters = new URLSearchParams({
    geometryType: 'esriGeometryEnvelope',
    geometry: extentText,
    imageDisplay: '1024,1024,96',
    mapExtent: extentText,
    tolerance: '0',
    layers: `all:${layerIds.join(',')}`,
    returnGeometry: 'true',
    geometryFormat: 'geojson',
    sr: '2056',
    lang: 'en',
    limit: String(RESULT_LIMIT),
  });
  const requestUrl = `${IDENTIFY_ENDPOINT}?${parameters}`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let result: IdentifyAttemptResult;

    try {
      result = await fetchIdentifyAttempt(requestUrl, signal);
    } catch (error) {
      if (attempt === 0 && isRetryableFetchFailure(error)) {
        await waitForRetry(createRetryDelay(), signal);
        continue;
      }

      throw error;
    }

    if (result.response.ok) {
      return parseTile(result.payload ?? {});
    }

    const retryDelay =
      attempt === 0 ? getResponseRetryDelay(result.response) : null;

    if (retryDelay !== null) {
      await waitForRetry(retryDelay, signal);
      continue;
    }

    throw new GeoAdminIdentifyHttpError(result.response.status);
  }

  throw new Error('GeoAdmin identify request failed after retry.');
}

/**
 * Loads roads and optional hiking enrichment without doubling requests during
 * normal operation. The combined request preserves today's efficient path; if
 * that non-guaranteed layer combination fails, the same tile is retried with the
 * road-and-path layer alone.
 */
async function fetchTile(
  tile: TileRequest,
  signal: AbortSignal,
  options: NetworkLoadOptions,
): Promise<ParsedTile> {
  if (options.shouldRequestHikingEnrichment?.() === false) {
    return fetchTileForLayers(tile, [ROAD_LAYER_ID], signal);
  }

  try {
    return await fetchTileForLayers(
      tile,
      [ROAD_LAYER_ID, HIKING_LAYER_ID],
      signal,
    );
  } catch (error) {
    if (isAbortedRequest(error, signal)) {
      throw error;
    }

    // Timeouts, network failures, rate limiting, and temporary service errors
    // affect the whole endpoint and should remain visible after their normal
    // retry. A non-retryable HTTP rejection can instead be caused by the
    // optional layer combination, so only that case receives a road-only retry.
    if (
      !(error instanceof GeoAdminIdentifyHttpError) ||
      RETRYABLE_HTTP_STATUSES.has(error.status)
    ) {
      throw error;
    }

    // Hiking classification improves route choice but does not define the
    // routable graph. Falling back here keeps route planning available if the
    // non-advertised identify behavior for the hiking layer changes or fails.
    // The callback also prevents later cells from repeating the rejected layer
    // combination for the rest of the routing Worker session.
    options.onHikingEnrichmentUnavailable?.();
    return fetchTileForLayers(tile, [ROAD_LAYER_ID], signal);
  }
}

/**
 * Maps values with a fixed runner count so one route operation cannot flood the
 * public GeoAdmin endpoint. These runners are asynchronous lanes inside the
 * routing Worker, not additional Web Workers.
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
 * Loads a bounded swissTLM3D road network through the official GeoAdmin API.
 *
 * The API caps each layer at 200 results per request. Fixed-size requests keep
 * the scale detailed enough for paths, while dense cells are subdivided when
 * they reach that cap. This loader is designed for dynamic local routing, not
 * for downloading or retaining the national data set.
 *
 * @param extent - Requested EPSG:2056 extent in map units/metres.
 * @param signal - Abort signal for the current route operation.
 * @param options - Empty-cell handling and optional progress reporting.
 * @returns Deduplicated road features plus hiking enrichment when available.
 * @throws {Error} When the required road request fails, no roads are returned
 * while empty data is disallowed, or road subdivision cannot get below the cap.
 * @throws {DOMException} When the operation is aborted.
 */
export async function fetchSwissTlmNetworkData(
  extent: Extent,
  signal: AbortSignal,
  options: NetworkLoadOptions = {},
): Promise<SwissTlmNetworkData> {
  const initialTiles = createTiles(extent);
  let completedRequests = 0;
  let totalRequests = initialTiles.length;

  const reportProgress = () => {
    options.onProgress?.({ completedRequests, totalRequests });
  };

  const fetchRecursively = async (
    tile: TileRequest,
  ): Promise<ParsedTile[]> => {
    const result = await fetchTile(tile, signal, options);
    completedRequests += 1;
    reportProgress();

    // Road truncation can remove graph connectivity and must remain a hard
    // error. Hiking truncation only weakens route preference, so it may be
    // accepted at the smallest tile instead of blocking the complete route.
    const roadsReachedLimit = result.roadResultCount >= RESULT_LIMIT;
    const hikingReachedLimit = result.hikingResultCount >= RESULT_LIMIT;

    if (!roadsReachedLimit && !hikingReachedLimit) {
      return [result];
    }

    if (tile.depth >= MAX_SUBDIVISION_DEPTH) {
      if (roadsReachedLimit) {
        throw new Error(
          'A swissTLM3D road request still reached the 200-feature limit after subdivision.',
        );
      }

      return [result];
    }

    const childTiles = subdivideTile(tile);
    totalRequests += childTiles.length;
    reportProgress();

    const childResults: ParsedTile[] = [];

    // Child cells are deliberately fetched sequentially inside each worker so
    // subdivision cannot create an uncontrolled burst of API requests.
    for (const childTile of childTiles) {
      childResults.push(...(await fetchRecursively(childTile)));
    }

    return childResults;
  };

  reportProgress();

  const tileGroups = await mapWithConcurrency(
    initialTiles,
    REQUEST_CONCURRENCY,
    fetchRecursively,
  );

  const tiles = tileGroups.flat();
  const roadMerge = mergeSwissTlmFeatures(tiles.flatMap((tile) => tile.roads));
  const hikingMerge = mergeSwissTlmFeatures(
    tiles.flatMap((tile) => tile.hikingTrails),
  );

  if (roadMerge.features.length === 0 && !options.allowEmpty) {
    throw new Error('The GeoAdmin API returned no swissTLM3D roads.');
  }

  let roadCoordinates = 0;
  let roadCoordinatesWithZ = 0;

  for (const feature of roadMerge.features) {
    for (const line of feature.lines) {
      for (const coordinate of line) {
        roadCoordinates += 1;
        if (Number.isFinite(coordinate[2])) {
          roadCoordinatesWithZ += 1;
        }
      }
    }
  }

  options.onDiagnostics?.({
    roadCoordinates,
    roadCoordinatesWithZ,
    conflictingFeatureIds:
      roadMerge.conflictingFeatureIds + hikingMerge.conflictingFeatureIds,
  });

  return {
    roads: roadMerge.features,
    hikingTrails: hikingMerge.features,
  };
}
