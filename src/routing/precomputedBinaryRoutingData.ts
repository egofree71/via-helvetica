/**
 * Business context: loads compact Geneva graph cells generated from official
 * swissTLM3D data. The parser validates the versioned binary contract, payload
 * integrity, geographic bounds, and graph references before exposing zero-copy
 * typed-array views to the routing Worker.
 */
import type { Extent } from 'ol/extent.js';
import {
  isLittleEndianRuntime,
  PRECOMPUTED_BINARY_CHECKSUM,
  PRECOMPUTED_BINARY_COORDINATE_MARGIN_METRES,
  PRECOMPUTED_BINARY_COST_SCALE,
  PRECOMPUTED_BINARY_FORMAT,
  PRECOMPUTED_BINARY_FORMAT_VERSION,
  PRECOMPUTED_BINARY_HEADER_BYTES,
  PRECOMPUTED_BINARY_MAGIC,
  PRECOMPUTED_BINARY_MAX_ELEVATION_METRES,
  PRECOMPUTED_BINARY_MIN_ELEVATION_METRES,
  PRECOMPUTED_BINARY_NO_ELEVATION,
  PRECOMPUTED_BINARY_PAYLOAD_CRC32_OFFSET,
  PRECOMPUTED_BINARY_XY_SCALE,
  PRECOMPUTED_BINARY_Z_SCALE,
  precomputedBinaryCrc32,
  precomputedBinaryLayout,
  type PrecomputedBinaryRoutingCell,
} from './precomputedBinaryRoutingFormat';
import {
  MAX_ROUTING_COST_FACTOR,
  MIN_ROUTING_COST_FACTOR,
} from './precomputedRoutingGraph';
import { extentForCellKey, type CellKey } from './routingGrid';
import { RoutingCoverageError } from './routingCoverage';
import {
  LOCAL_PRECOMPUTED_BINARY_ROUTING_BASE_URL,
  normalizeRoutingDataBaseUrl,
} from './routingConfig';

/** Exact grid size shared by corridor selection and all Geneva experiments. */
const EXPECTED_CELL_SIZE_METRES = 2_400;
/** Cost-model revision embedded in every compatible manifest. */
const EXPECTED_COST_MODEL_VERSION = 1;
/**
 * Edges shorter than one metre are more sensitive to centimetre coordinate
 * quantization, so their cost is validated with an absolute ceiling instead of
 * a factor ratio.
 */
const COST_FACTOR_VALIDATION_MIN_LENGTH_METRES = 1;
/** Maximum plausible cost for a sub-metre source edge. */
const MAX_SHORT_EDGE_COST = 5;
/** One retry absorbs a transient network, cache, or partial-response failure. */
const BINARY_PROVIDER_MAX_ATTEMPTS = 2;
/** Small retry delay in milliseconds; long backoff would make GeoAdmin fallback feel broken. */
const BINARY_PROVIDER_RETRY_DELAY_MILLISECONDS = 150;

/** Validated manifest describing the bounded binary-data experiment. */
interface PrecomputedBinaryRoutingManifest {
  /** Binary contract version accepted by the current Worker. */
  version: number;
  /** Coordinate reference system shared by the map and routing graph. */
  projection: string;
  /** Width and height in metres of one routing-grid cell. */
  cellSizeMetres: number;
  /** Complete LV95 extraction rectangle covered by the manifest. */
  extent: [number, number, number, number];
  /** In-region cells that contain at least one graph edge. */
  nonEmptyCellKeys: Set<CellKey>;
  /** Dataset-wide upper bound used to validate global node IDs. */
  globalNodeCount: number;
  /** Dataset-wide upper bound used to validate global edge IDs. */
  globalEdgeCount: number;
  /** Validated relative path template for raw binary cells. */
  cellPathTemplate: string;
  /** Optional validated relative path template for explicit Brotli payloads. */
  precompressedCellPathTemplate: string | null;
}

/** Untrusted JSON representation of the binary graph manifest. */
interface PrecomputedBinaryRoutingManifestPayload {
  /** Untrusted binary contract version. */
  version?: unknown;
  /** Untrusted format discriminator. */
  format?: unknown;
  /** Untrusted coordinate reference system name. */
  projection?: unknown;
  /** Untrusted routing-grid cell size in metres. */
  cellSizeMetres?: unknown;
  /** Untrusted generated LV95 extent. */
  extent?: unknown;
  /** Untrusted list of non-empty routing-grid keys. */
  nonEmptyCellKeys?: unknown;
  /** Untrusted fixed header size in bytes. */
  headerBytes?: unknown;
  /** Untrusted XY fixed-point units per metre. */
  coordinateScalePerMetre?: unknown;
  /** Untrusted elevation fixed-point units per metre. */
  elevationScalePerMetre?: unknown;
  /** Untrusted edge-cost fixed-point units per cost unit. */
  costScalePerUnit?: unknown;
  /** Untrusted dataset-wide node count. */
  globalNodeCount?: unknown;
  /** Untrusted dataset-wide edge count. */
  globalEdgeCount?: unknown;
  /** Untrusted relative raw-cell path template. */
  cellPathTemplate?: unknown;
  /** Untrusted relative precompressed-cell path template. */
  precompressedCellPathTemplate?: unknown;
  /** Untrusted payload-integrity algorithm name. */
  payloadChecksum?: unknown;
  /** Untrusted coordinate-validation margin in metres. */
  coordinateValidationMarginMetres?: unknown;
  /** Untrusted pedestrian cost-model revision. */
  costModelVersion?: unknown;
}

/** Binary-search lookup created without per-ID JavaScript Set entries. */
interface ValidatedIdLookup {
  /** Returns the original array index for a global ID, or -1 when absent. */
  findLocalIndex(globalId: number): number;
}

/** Raised when the bounded binary Geneva experiment is asked to route elsewhere. */
export class PrecomputedBinaryRoutingCoverageError extends RoutingCoverageError {
  constructor() {
    super(
      'PrecomputedBinaryRoutingCoverageError',
      'The precomputed binary Geneva routing experiment does not cover this area.',
    );
  }
}

/** Mutable state isolated per local or remote binary-data root. */
interface PrecomputedBinaryRoutingProviderState {
  /** Shared manifest request for this provider instance. */
  manifestPromise: Promise<PrecomputedBinaryRoutingManifest> | null;
  /** Cached native Brotli capability for this Worker runtime. */
  brotliDecompressionSupported: boolean | null;
}

/**
 * Loads and validates one compact graph cell for the session routing engine.
 * @param key - Routing-grid key requested by the corridor builder.
 * @param signal - Caller cancellation propagated to manifest and cell requests.
 * @returns A validated cell backed by its downloaded binary buffer.
 * @throws {Error} For provider, compatibility, integrity, or coverage failures.
 */
export type PrecomputedBinaryRoutingCellLoader = (
  key: CellKey,
  signal: AbortSignal,
) => Promise<PrecomputedBinaryRoutingCell>;

/** Validates a finite four-number extent. */
function readExtent(value: unknown): [number, number, number, number] | null {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    value.some(
      (member) => typeof member !== 'number' || !Number.isFinite(member),
    ) ||
    value[0] >= value[2] ||
    value[1] >= value[3]
  ) {
    return null;
  }

  return [value[0], value[1], value[2], value[3]];
}

/** Accepts only relative cell templates controlled by the generated manifest. */
function readCellPathTemplate(value: unknown, suffix: string): string | null {
  if (
    typeof value !== 'string' ||
    value.includes('..') ||
    value.startsWith('/') ||
    !value.includes('{column}') ||
    !value.includes('{row}') ||
    !value.endsWith(suffix)
  ) {
    return null;
  }

  return value;
}

/** Builds a relative cell path from a validated manifest template. */
function cellPath(template: string, key: CellKey): string {
  const [column, row] = key.split(':');
  return template
    .replace('{column}', column)
    .replace('{row}', row);
}

/**
 * Loads and validates the manifest shared by one binary provider instance.
 * @param baseUrl - Normalized dataset root containing `manifest.json`.
 * @param state - Provider-local cache for the single in-flight manifest request.
 * @returns The validated dataset contract used by subsequent cell requests.
 * @throws {Error} When delivery fails or any contract field is incompatible.
 */
async function loadManifest(
  baseUrl: string,
  state: PrecomputedBinaryRoutingProviderState,
): Promise<PrecomputedBinaryRoutingManifest> {
  if (state.manifestPromise) {
    return state.manifestPromise;
  }

  state.manifestPromise = fetch(`${baseUrl}/manifest.json`)
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(
          `Precomputed binary routing manifest request failed (${response.status}).`,
        );
      }

      const payload =
        (await response.json()) as PrecomputedBinaryRoutingManifestPayload;
      const extent = readExtent(payload.extent);
      const rawCellKeys = payload.nonEmptyCellKeys;
      const nonEmptyCellKeys = Array.isArray(rawCellKeys)
        ? rawCellKeys.filter(
            (key): key is CellKey =>
              typeof key === 'string' && /^-?\d+:-?\d+$/.test(key),
          )
        : null;
      const cellPathTemplate = readCellPathTemplate(
        payload.cellPathTemplate,
        '.bin',
      );
      const precompressedCellPathTemplate =
        payload.precompressedCellPathTemplate === undefined
          ? null
          : readCellPathTemplate(
              payload.precompressedCellPathTemplate,
              '.bin.br',
            );

      if (
        payload.version !== PRECOMPUTED_BINARY_FORMAT_VERSION ||
        payload.format !== PRECOMPUTED_BINARY_FORMAT ||
        payload.projection !== 'EPSG:2056' ||
        payload.cellSizeMetres !== EXPECTED_CELL_SIZE_METRES ||
        payload.headerBytes !== PRECOMPUTED_BINARY_HEADER_BYTES ||
        payload.coordinateScalePerMetre !== PRECOMPUTED_BINARY_XY_SCALE ||
        payload.elevationScalePerMetre !== PRECOMPUTED_BINARY_Z_SCALE ||
        payload.costScalePerUnit !== PRECOMPUTED_BINARY_COST_SCALE ||
        payload.payloadChecksum !== PRECOMPUTED_BINARY_CHECKSUM ||
        payload.coordinateValidationMarginMetres !==
          PRECOMPUTED_BINARY_COORDINATE_MARGIN_METRES ||
        payload.costModelVersion !== EXPECTED_COST_MODEL_VERSION ||
        !Number.isInteger(payload.globalNodeCount) ||
        typeof payload.globalNodeCount !== 'number' ||
        payload.globalNodeCount <= 0 ||
        !Number.isInteger(payload.globalEdgeCount) ||
        typeof payload.globalEdgeCount !== 'number' ||
        payload.globalEdgeCount <= 0 ||
        !extent ||
        !nonEmptyCellKeys ||
        !Array.isArray(rawCellKeys) ||
        nonEmptyCellKeys.length !== rawCellKeys.length ||
        !cellPathTemplate ||
        (payload.precompressedCellPathTemplate !== undefined &&
          !precompressedCellPathTemplate)
      ) {
        throw new Error(
          'Precomputed binary routing manifest is invalid or incompatible.',
        );
      }

      return {
        version: payload.version,
        projection: payload.projection,
        cellSizeMetres: payload.cellSizeMetres,
        extent,
        nonEmptyCellKeys: new Set(nonEmptyCellKeys),
        globalNodeCount: payload.globalNodeCount,
        globalEdgeCount: payload.globalEdgeCount,
        cellPathTemplate,
        precompressedCellPathTemplate,
      };
    })
    .catch((error) => {
      state.manifestPromise = null;
      throw error;
    });

  return state.manifestPromise;
}

/**
 * Checks complete-cell coverage rather than point overlap so a boundary halo
 * cannot silently claim data that was never generated.
 * @param manifest - Validated bounded dataset contract.
 * @param key - Routing-grid key selected for the current corridor.
 * @returns `true` only when the complete cell lies inside the generated extent.
 */
function manifestContainsCell(
  manifest: PrecomputedBinaryRoutingManifest,
  key: CellKey,
): boolean {
  const [cellMinX, cellMinY, cellMaxX, cellMaxY] = extentForCellKey(key);
  const [minX, minY, maxX, maxY] = manifest.extent;

  return (
    cellMinX >= minX &&
    cellMinY >= minY &&
    cellMaxX <= maxX &&
    cellMaxY <= maxY
  );
}

/**
 * Creates the empty in-region cell used for known gaps in the extraction.
 * @param key - Covered cell absent from the manifest's non-empty list.
 * @param manifest - Dataset-wide counts copied into the empty cell contract.
 * @returns A valid zero-node, zero-edge cell that requires no network request.
 */
function emptyCell(
  key: CellKey,
  manifest: PrecomputedBinaryRoutingManifest,
): PrecomputedBinaryRoutingCell {
  const buffer = new ArrayBuffer(PRECOMPUTED_BINARY_HEADER_BYTES);
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
    globalNodeCount: manifest.globalNodeCount,
    globalEdgeCount: manifest.globalEdgeCount,
    sourceRoadFeatures: 0,
    buffer,
  };
}

/**
 * Expands the validation extent because source geometries are assigned whole to
 * intersecting cells and may legitimately continue beyond the extraction edge.
 * @param expectedKey - Cell being decoded when no dataset extent is available.
 * @param datasetExtent - Complete generated extent from the validated manifest.
 * @returns LV95 bounds enlarged by the binary contract's safety margin.
 */
function coordinateValidationExtent(
  expectedKey: CellKey,
  datasetExtent?: Extent,
): Extent {
  const [minX, minY, maxX, maxY] = datasetExtent ?? extentForCellKey(expectedKey);
  return [
    minX - PRECOMPUTED_BINARY_COORDINATE_MARGIN_METRES,
    minY - PRECOMPUTED_BINARY_COORDINATE_MARGIN_METRES,
    maxX + PRECOMPUTED_BINARY_COORDINATE_MARGIN_METRES,
    maxY + PRECOMPUTED_BINARY_COORDINATE_MARGIN_METRES,
  ];
}

/**
 * Validates unique bounded IDs while retaining a typed binary-search lookup.
 * Sorting indexes avoids the object-heavy `Set<number>` cost on every cell.
 * @param ids - Global IDs stored by one binary column.
 * @param globalCount - Exclusive dataset-wide upper bound for those IDs.
 * @param label - Diagnostic label included in validation failures.
 * @returns A local-index lookup backed only by typed arrays.
 * @throws {Error} When an ID is duplicated or outside the global range.
 */
function validateIdLookup(
  ids: Uint32Array,
  globalCount: number,
  label: string,
): ValidatedIdLookup {
  const sortedLocalIndexes = new Uint32Array(ids.length);
  for (let index = 0; index < ids.length; index += 1) {
    sortedLocalIndexes[index] = index;
  }
  sortedLocalIndexes.sort((first, second) => ids[first] - ids[second]);

  let previousId = -1;
  for (const localIndex of sortedLocalIndexes) {
    const id = ids[localIndex];
    if (id >= globalCount || id === previousId) {
      throw new Error(`Precomputed binary routing cell has invalid ${label} IDs.`);
    }
    previousId = id;
  }

  return {
    findLocalIndex(globalId: number): number {
      let low = 0;
      let high = sortedLocalIndexes.length - 1;

      while (low <= high) {
        const middle = (low + high) >>> 1;
        const localIndex = sortedLocalIndexes[middle];
        const candidate = ids[localIndex];

        if (candidate === globalId) {
          return localIndex;
        }
        if (candidate < globalId) {
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }

      return -1;
    },
  };
}

/**
 * Checks whether one fixed-point node lies in plausible geographic bounds.
 * @param x - Quantized LV95 X value.
 * @param y - Quantized LV95 Y value.
 * @param z - Quantized elevation or the explicit no-elevation sentinel.
 * @param allowedExtent - Dataset bounds enlarged for complete edge geometries.
 * @returns Whether all present coordinate components satisfy the contract.
 */
function coordinateIsValid(
  x: number,
  y: number,
  z: number,
  allowedExtent: Extent,
): boolean {
  if (
    x === PRECOMPUTED_BINARY_NO_ELEVATION ||
    y === PRECOMPUTED_BINARY_NO_ELEVATION
  ) {
    return false;
  }

  const xMetres = x / PRECOMPUTED_BINARY_XY_SCALE;
  const yMetres = y / PRECOMPUTED_BINARY_XY_SCALE;

  if (
    xMetres < allowedExtent[0] ||
    yMetres < allowedExtent[1] ||
    xMetres > allowedExtent[2] ||
    yMetres > allowedExtent[3]
  ) {
    return false;
  }

  if (z === PRECOMPUTED_BINARY_NO_ELEVATION) {
    return true;
  }

  const elevation = z / PRECOMPUTED_BINARY_Z_SCALE;
  return (
    elevation >= PRECOMPUTED_BINARY_MIN_ELEVATION_METRES &&
    elevation <= PRECOMPUTED_BINARY_MAX_ELEVATION_METRES
  );
}

/**
 * Rejects costs that cannot plausibly come from the current pedestrian model.
 * @param costValue - Quantized edge cost stored in the cell.
 * @param startX - Quantized LV95 X of the first endpoint.
 * @param startY - Quantized LV95 Y of the first endpoint.
 * @param endX - Quantized LV95 X of the second endpoint.
 * @param endY - Quantized LV95 Y of the second endpoint.
 * @returns Whether the decoded cost is consistent with edge length and model bounds.
 */
function edgeCostIsValid(
  costValue: number,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): boolean {
  const deltaX = (endX - startX) / PRECOMPUTED_BINARY_XY_SCALE;
  const deltaY = (endY - startY) / PRECOMPUTED_BINARY_XY_SCALE;
  const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
  const cost = costValue / PRECOMPUTED_BINARY_COST_SCALE;

  if (!Number.isFinite(distance) || distance <= 0 || !Number.isFinite(cost)) {
    return false;
  }

  if (distance < COST_FACTOR_VALIDATION_MIN_LENGTH_METRES) {
    return cost <= MAX_SHORT_EDGE_COST;
  }

  const factor = cost / distance;
  return (
    factor >= MIN_ROUTING_COST_FACTOR &&
    factor <= MAX_ROUTING_COST_FACTOR
  );
}

/**
 * Parses and validates one binary cell without copying its columnar arrays.
 * @param buffer - Complete response body returned by the static host.
 * @param expectedKey - Routing-grid key encoded by the requested URL.
 * @param datasetExtent - Optional complete generated extent for coordinate checks.
 * @returns Typed-array views backed by the supplied buffer.
 * @throws {Error} For truncated, corrupted, malformed, or incompatible data.
 */
export function readPrecomputedBinaryRoutingCell(
  buffer: ArrayBuffer,
  expectedKey: CellKey,
  datasetExtent?: Extent,
): PrecomputedBinaryRoutingCell {
  if (!isLittleEndianRuntime()) {
    throw new Error(
      'Precomputed binary routing cells require a little-endian runtime.',
    );
  }

  if (buffer.byteLength < PRECOMPUTED_BINARY_HEADER_BYTES) {
    throw new Error(`Precomputed binary routing cell ${expectedKey} is truncated.`);
  }

  const bytes = new Uint8Array(buffer);
  const magic = String.fromCharCode(
    ...bytes.subarray(0, PRECOMPUTED_BINARY_MAGIC.length),
  );
  const view = new DataView(buffer);
  const version = view.getUint16(4, true);
  const headerBytes = view.getUint16(6, true);
  const column = view.getInt32(8, true);
  const row = view.getInt32(12, true);
  const nodeCount = view.getUint32(16, true);
  const edgeCount = view.getUint32(20, true);
  const sourceRoadFeatures = view.getUint32(24, true);
  const xyScale = view.getUint32(28, true);
  const zScale = view.getUint32(32, true);
  const costScale = view.getUint32(36, true);
  const storedNodeIdsOffset = view.getUint32(40, true);
  const storedEdgeIdsOffset = view.getUint32(44, true);
  const storedEdgeFlagsOffset = view.getUint32(48, true);
  const storedByteLength = view.getUint32(52, true);
  const globalNodeCount = view.getUint32(56, true);
  const globalEdgeCount = view.getUint32(60, true);
  const storedPayloadCrc32 = view.getUint32(
    PRECOMPUTED_BINARY_PAYLOAD_CRC32_OFFSET,
    true,
  );
  const key = `${column}:${row}` as CellKey;
  let layout;

  try {
    layout = precomputedBinaryLayout(nodeCount, edgeCount);
  } catch {
    throw new Error(
      `Precomputed binary routing cell ${expectedKey} is invalid or incompatible.`,
    );
  }

  if (
    magic !== PRECOMPUTED_BINARY_MAGIC ||
    version !== PRECOMPUTED_BINARY_FORMAT_VERSION ||
    headerBytes !== PRECOMPUTED_BINARY_HEADER_BYTES ||
    key !== expectedKey ||
    xyScale !== PRECOMPUTED_BINARY_XY_SCALE ||
    zScale !== PRECOMPUTED_BINARY_Z_SCALE ||
    costScale !== PRECOMPUTED_BINARY_COST_SCALE ||
    storedNodeIdsOffset !== layout.nodeIdsOffset ||
    storedEdgeIdsOffset !== layout.edgeIdsOffset ||
    storedEdgeFlagsOffset !== layout.edgeFlagsOffset ||
    storedByteLength !== layout.byteLength ||
    buffer.byteLength !== layout.byteLength ||
    globalNodeCount === 0 ||
    globalEdgeCount === 0 ||
    storedPayloadCrc32 !==
      precomputedBinaryCrc32(bytes, PRECOMPUTED_BINARY_HEADER_BYTES)
  ) {
    throw new Error(
      `Precomputed binary routing cell ${expectedKey} is invalid or incompatible.`,
    );
  }

  const nodeIds = new Uint32Array(buffer, layout.nodeIdsOffset, nodeCount);
  const nodeX = new Int32Array(buffer, layout.nodeXOffset, nodeCount);
  const nodeY = new Int32Array(buffer, layout.nodeYOffset, nodeCount);
  const nodeZ = new Int32Array(buffer, layout.nodeZOffset, nodeCount);
  const edgeIds = new Uint32Array(buffer, layout.edgeIdsOffset, edgeCount);
  const edgeStartNodeIds = new Uint32Array(
    buffer,
    layout.edgeStartOffset,
    edgeCount,
  );
  const edgeEndNodeIds = new Uint32Array(
    buffer,
    layout.edgeEndOffset,
    edgeCount,
  );
  const edgeCosts = new Uint32Array(buffer, layout.edgeCostOffset, edgeCount);
  const edgeFlags = new Uint8Array(buffer, layout.edgeFlagsOffset, edgeCount);
  const allowedExtent = coordinateValidationExtent(expectedKey, datasetExtent);
  const nodeLookup = validateIdLookup(nodeIds, globalNodeCount, 'node');
  validateIdLookup(edgeIds, globalEdgeCount, 'edge');

  for (let index = 0; index < nodeCount; index += 1) {
    if (!coordinateIsValid(nodeX[index], nodeY[index], nodeZ[index], allowedExtent)) {
      throw new Error(
        `Precomputed binary routing cell ${expectedKey} has an invalid coordinate.`,
      );
    }
  }

  for (let index = 0; index < edgeCount; index += 1) {
    const startNodeId = edgeStartNodeIds[index];
    const endNodeId = edgeEndNodeIds[index];
    const startLocalIndex = nodeLookup.findLocalIndex(startNodeId);
    const endLocalIndex = nodeLookup.findLocalIndex(endNodeId);

    if (
      startNodeId === endNodeId ||
      startLocalIndex < 0 ||
      endLocalIndex < 0 ||
      edgeCosts[index] === 0 ||
      edgeFlags[index] > 1 ||
      !edgeCostIsValid(
        edgeCosts[index],
        nodeX[startLocalIndex],
        nodeY[startLocalIndex],
        nodeX[endLocalIndex],
        nodeY[endLocalIndex],
      )
    ) {
      throw new Error(
        `Precomputed binary routing cell ${expectedKey} has an invalid edge.`,
      );
    }
  }

  return {
    key,
    nodeIds,
    nodeX,
    nodeY,
    nodeZ,
    edgeIds,
    edgeStartNodeIds,
    edgeEndNodeIds,
    edgeCosts,
    edgeFlags,
    globalNodeCount,
    globalEdgeCount,
    sourceRoadFeatures,
    buffer,
  };
}

/** Returns whether an error represents cancellation owned by the caller. */
function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException || error instanceof Error) &&
    error.name === 'AbortError'
  );
}

/**
 * Waits before the single provider retry while remaining immediately cancellable.
 * @param signal - Caller cancellation that must interrupt the retry delay.
 * @returns A promise resolved after the short delay.
 * @throws {DOMException} When the caller aborts before or during the delay.
 */
function waitForProviderRetry(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(
      signal.reason ?? new DOMException('Aborted', 'AbortError'),
    );
  }

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, BINARY_PROVIDER_RETRY_DELAY_MILLISECONDS);
    const onAbort = (): void => {
      clearTimeout(timeoutId);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Creates a native Brotli stream when the current browser exposes one.
 * @param state - Provider-local capability cache avoiding repeated exceptions.
 * @returns A decompression stream, or `null` when Brotli is unavailable.
 */
function createBrotliDecompressionStream(
  state: PrecomputedBinaryRoutingProviderState,
): DecompressionStream | null {
  if (
    state.brotliDecompressionSupported === false ||
    typeof DecompressionStream === 'undefined'
  ) {
    return null;
  }

  try {
    const stream = new DecompressionStream('brotli' as never);
    state.brotliDecompressionSupported = true;
    return stream;
  } catch {
    state.brotliDecompressionSupported = false;
    return null;
  }
}

/**
 * Downloads and decodes a precompressed cell when native Brotli is available.
 * @param baseUrl - Normalized dataset root.
 * @param state - Provider-local Brotli capability state.
 * @param relativePath - Validated manifest path ending in `.bin.br`.
 * @param signal - Caller cancellation propagated to `fetch`.
 * @returns The decompressed buffer, or `null` to request the raw fallback.
 * @throws {Error} For non-404 HTTP failures or unusable response bodies.
 */
async function fetchBrotliCell(
  baseUrl: string,
  state: PrecomputedBinaryRoutingProviderState,
  relativePath: string,
  signal: AbortSignal,
): Promise<ArrayBuffer | null> {
  const decompressor = createBrotliDecompressionStream(state);

  if (!decompressor) {
    return null;
  }

  const response = await fetch(`${baseUrl}/${relativePath}`, { signal });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok || !response.body) {
    throw new Error(
      `Precomputed Brotli routing cell request failed (${response.status}).`,
    );
  }

  return new Response(response.body.pipeThrough(decompressor)).arrayBuffer();
}

/**
 * Downloads the uncompressed fallback for browsers without Brotli streams.
 * @param baseUrl - Normalized dataset root.
 * @param relativePath - Validated manifest path ending in `.bin`.
 * @param key - Cell key included in actionable delivery errors.
 * @param signal - Caller cancellation propagated to `fetch`.
 * @returns The complete binary response body.
 * @throws {Error} When the cell is missing or the request fails.
 */
async function fetchUncompressedCell(
  baseUrl: string,
  relativePath: string,
  key: CellKey,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  const response = await fetch(`${baseUrl}/${relativePath}`, { signal });

  if (response.status === 404) {
    throw new Error(`Precomputed binary routing cell ${key} is missing.`);
  }

  if (!response.ok) {
    throw new Error(
      `Precomputed binary routing cell ${key} request failed (${response.status}).`,
    );
  }

  return response.arrayBuffer();
}

/**
 * Loads and validates one cell without applying retry policy.
 * @param baseUrl - Normalized dataset root.
 * @param state - Provider-local manifest and Brotli state.
 * @param key - Routing-grid key requested by the corridor builder.
 * @param signal - Caller cancellation propagated through all network work.
 * @returns A validated compact graph cell, including known empty coverage.
 * @throws {Error} For coverage, delivery, integrity, or manifest mismatches.
 */
async function fetchPrecomputedBinaryRoutingCellOnce(
  baseUrl: string,
  state: PrecomputedBinaryRoutingProviderState,
  key: CellKey,
  signal: AbortSignal,
): Promise<PrecomputedBinaryRoutingCell> {
  const manifest = await loadManifest(baseUrl, state);

  if (!manifestContainsCell(manifest, key)) {
    throw new PrecomputedBinaryRoutingCoverageError();
  }

  if (!manifest.nonEmptyCellKeys.has(key)) {
    return emptyCell(key, manifest);
  }

  const compressedBuffer = manifest.precompressedCellPathTemplate
    ? await fetchBrotliCell(
        baseUrl,
        state,
        cellPath(manifest.precompressedCellPathTemplate, key),
        signal,
      )
    : null;
  const buffer =
    compressedBuffer ??
    (await fetchUncompressedCell(
      baseUrl,
      cellPath(manifest.cellPathTemplate, key),
      key,
      signal,
    ));
  const cell = readPrecomputedBinaryRoutingCell(buffer, key, manifest.extent);

  if (
    cell.globalNodeCount !== manifest.globalNodeCount ||
    cell.globalEdgeCount !== manifest.globalEdgeCount
  ) {
    throw new Error(
      `Precomputed binary routing cell ${key} does not match its manifest.`,
    );
  }

  return cell;
}

/**
 * Creates an isolated binary-cell loader for one local or remote dataset root.
 * @param rawBaseUrl - Directory containing `manifest.json` and its relative cells.
 * @returns A session-scoped loader with a shared manifest and one retry.
 * @throws {Error} When the base URL is empty or unsafe.
 */
export function createPrecomputedBinaryGenevaRoutingCellLoader(
  rawBaseUrl: string,
): PrecomputedBinaryRoutingCellLoader {
  const baseUrl = normalizeRoutingDataBaseUrl(rawBaseUrl);

  if (!baseUrl) {
    throw new Error('Precomputed binary routing requires a data base URL.');
  }

  const state: PrecomputedBinaryRoutingProviderState = {
    manifestPromise: null,
    brotliDecompressionSupported: null,
  };

  return async (key, signal) => {
    for (let attempt = 1; attempt <= BINARY_PROVIDER_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await fetchPrecomputedBinaryRoutingCellOnce(
          baseUrl,
          state,
          key,
          signal,
        );
      } catch (error) {
        if (
          signal.aborted ||
          isAbortError(error) ||
          error instanceof PrecomputedBinaryRoutingCoverageError ||
          attempt === BINARY_PROVIDER_MAX_ATTEMPTS
        ) {
          throw error;
        }

        // A failed manifest or corrupted cached response is re-fetched rather
        // than pinning the first failure for the full Worker session.
        state.manifestPromise = null;
        console.warn(
          `[Via Helvetica] Retrying precomputed routing cell ${key} after a provider failure.`,
          error,
        );
        await waitForProviderRetry(signal);
      }
    }

    throw new Error('Precomputed binary routing retry loop terminated unexpectedly.');
  };
}

/** Default local-development loader retained for direct module tests. */
export const fetchPrecomputedBinaryGenevaRoutingCell =
  createPrecomputedBinaryGenevaRoutingCellLoader(
    LOCAL_PRECOMPUTED_BINARY_ROUTING_BASE_URL,
  );

