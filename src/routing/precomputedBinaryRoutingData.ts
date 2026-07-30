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

/** Root URL copied unchanged by Vite from the development public directory. */
const PRECOMPUTED_BINARY_ROUTING_ROOT =
  '/routing-data/geneva-precomputed-binary';
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

/** Validated manifest describing the bounded binary-data experiment. */
interface PrecomputedBinaryRoutingManifest {
  version: number;
  projection: string;
  cellSizeMetres: number;
  extent: [number, number, number, number];
  nonEmptyCellKeys: Set<CellKey>;
  globalNodeCount: number;
  globalEdgeCount: number;
  cellPathTemplate: string;
  precompressedCellPathTemplate: string | null;
}

/** Untrusted JSON representation of the binary graph manifest. */
interface PrecomputedBinaryRoutingManifestPayload {
  version?: unknown;
  format?: unknown;
  projection?: unknown;
  cellSizeMetres?: unknown;
  extent?: unknown;
  nonEmptyCellKeys?: unknown;
  headerBytes?: unknown;
  coordinateScalePerMetre?: unknown;
  elevationScalePerMetre?: unknown;
  costScalePerUnit?: unknown;
  globalNodeCount?: unknown;
  globalEdgeCount?: unknown;
  cellPathTemplate?: unknown;
  precompressedCellPathTemplate?: unknown;
  payloadChecksum?: unknown;
  coordinateValidationMarginMetres?: unknown;
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

let manifestPromise: Promise<PrecomputedBinaryRoutingManifest> | null = null;
let brotliDecompressionSupported: boolean | null = null;

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

/** Loads and validates the manifest shared by all binary cells. */
async function loadManifest(): Promise<PrecomputedBinaryRoutingManifest> {
  if (manifestPromise) {
    return manifestPromise;
  }

  manifestPromise = fetch(`${PRECOMPUTED_BINARY_ROUTING_ROOT}/manifest.json`)
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
      manifestPromise = null;
      throw error;
    });

  return manifestPromise;
}

/** Returns whether a complete routing cell lies inside the generated region. */
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

/** Returns the empty in-region cell used for known gaps in the extraction. */
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

/** Returns a dataset extent expanded for complete source features at its edge. */
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

/** Returns whether one fixed-point node lies in plausible geographic bounds. */
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

/** Rejects costs that cannot plausibly come from the current pedestrian model. */
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

/** Returns a native Brotli stream when the current browser exposes one. */
function createBrotliDecompressionStream(): DecompressionStream | null {
  if (
    brotliDecompressionSupported === false ||
    typeof DecompressionStream === 'undefined'
  ) {
    return null;
  }

  try {
    const stream = new DecompressionStream('brotli' as never);
    brotliDecompressionSupported = true;
    return stream;
  } catch {
    brotliDecompressionSupported = false;
    return null;
  }
}

/** Downloads and decodes a precompressed cell when native Brotli is available. */
async function fetchBrotliCell(
  relativePath: string,
  signal: AbortSignal,
): Promise<ArrayBuffer | null> {
  const decompressor = createBrotliDecompressionStream();

  if (!decompressor) {
    return null;
  }

  const response = await fetch(
    `${PRECOMPUTED_BINARY_ROUTING_ROOT}/${relativePath}`,
    { signal },
  );

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

/** Downloads the uncompressed binary fallback for browsers without Brotli streams. */
async function fetchUncompressedCell(
  relativePath: string,
  key: CellKey,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  const response = await fetch(
    `${PRECOMPUTED_BINARY_ROUTING_ROOT}/${relativePath}`,
    { signal },
  );

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
 * Loads one binary Geneva graph cell.
 * @param key - Exact 2.4 km routing-grid key requested by the engine.
 * @param signal - Abort signal owned by the current routing operation.
 * @returns Validated typed-array graph data; an unlisted in-region cell is empty.
 * @throws {PrecomputedBinaryRoutingCoverageError} Outside the generated region.
 * @throws {Error} When installed files are missing, malformed, or unavailable.
 */
export async function fetchPrecomputedBinaryGenevaRoutingCell(
  key: CellKey,
  signal: AbortSignal,
): Promise<PrecomputedBinaryRoutingCell> {
  const manifest = await loadManifest();

  if (!manifestContainsCell(manifest, key)) {
    throw new PrecomputedBinaryRoutingCoverageError();
  }

  if (!manifest.nonEmptyCellKeys.has(key)) {
    return emptyCell(key, manifest);
  }

  const compressedBuffer = manifest.precompressedCellPathTemplate
    ? await fetchBrotliCell(
        cellPath(manifest.precompressedCellPathTemplate, key),
        signal,
      )
    : null;
  const buffer =
    compressedBuffer ??
    (await fetchUncompressedCell(
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
