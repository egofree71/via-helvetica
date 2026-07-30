/**
 * Business context: loads Geneva graph cells compiled offline from the official
 * swissTLM3D GeoPackage. Nodes, pedestrian filtering, hiking preference, and
 * final edge costs are already resolved, so the Worker only joins requested
 * cells, builds adjacency and snapping indexes, and runs A*.
 */
import type { Coordinate } from 'ol/coordinate.js';
import {
  precomputedNodeKey,
  type PrecomputedRoutingGraphData,
  type PrecomputedRoutingNode,
  type PrecomputedRoutingSegment,
} from './precomputedRoutingGraph';
import { extentForCellKey, type CellKey } from './routingGrid';
import { RoutingCoverageError } from './routingCoverage';

/** Root URL copied unchanged by Vite from the public directory. */
const PRECOMPUTED_ROUTING_ROOT = '/routing-data/geneva-precomputed';
/** Current graph-cell format generated for the second Geneva experiment. */
const PRECOMPUTED_FORMAT_VERSION = 1;
/** Exact grid size shared with geometry cells and corridor selection. */
const EXPECTED_CELL_SIZE_METRES = 2_400;

/** Validated manifest describing the bounded precomputed-data region. */
interface PrecomputedRoutingManifest {
  /** File-format version checked before cell data is trusted. */
  version: number;
  /** Coordinate system used by every node coordinate. */
  projection: string;
  /** Width and height of one routing cell in metres. */
  cellSizeMetres: number;
  /** Closed LV95 bounding box covered by the experiment. */
  extent: [number, number, number, number];
  /** Exact non-empty graph cells written by the offline compiler. */
  nonEmptyCellKeys: Set<CellKey>;
}

/** Untrusted JSON representation of the graph manifest. */
interface PrecomputedRoutingManifestPayload {
  version?: unknown;
  format?: unknown;
  projection?: unknown;
  cellSizeMetres?: unknown;
  extent?: unknown;
  nonEmptyCellKeys?: unknown;
}

/** Compact node tuple containing its original 2D/3D source coordinate. */
type PrecomputedNodePayload = [unknown, unknown, unknown?];
/** Compact segment tuple: local endpoint indexes, final cost, and hiking flag. */
type PrecomputedSegmentPayload = [unknown, unknown, unknown, unknown?];

/** Untrusted compact graph-cell payload. */
interface PrecomputedCellPayload {
  /** File-format version. */
  v?: unknown;
  /** Routing-grid key represented by this file. */
  k?: unknown;
  /** Exact cell extent in LV95. */
  e?: unknown;
  /** Local node table referenced by segment endpoint indexes. */
  n?: unknown;
  /** Precomputed walkable segments. */
  s?: unknown;
  /** Source-road count retained only for diagnostics. */
  f?: unknown;
}

/** Raised when the precomputed Geneva experiment is asked to route elsewhere. */
export class PrecomputedRoutingCoverageError extends RoutingCoverageError {
  constructor() {
    super(
      'PrecomputedRoutingCoverageError',
      'The precomputed Geneva routing experiment does not cover this area.',
    );
  }
}

let manifestPromise: Promise<PrecomputedRoutingManifest> | null = null;

/** Validates a finite four-number extent. */
function readExtent(value: unknown): [number, number, number, number] | null {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    value.some((member) => typeof member !== 'number' || !Number.isFinite(member))
  ) {
    return null;
  }

  return [value[0], value[1], value[2], value[3]];
}

/** Loads and validates the manifest shared by all precomputed cells. */
async function loadManifest(): Promise<PrecomputedRoutingManifest> {
  if (manifestPromise) {
    return manifestPromise;
  }

  manifestPromise = fetch(`${PRECOMPUTED_ROUTING_ROOT}/manifest.json`)
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(
          `Precomputed routing manifest request failed (${response.status}).`,
        );
      }

      const payload = (await response.json()) as PrecomputedRoutingManifestPayload;
      const extent = readExtent(payload.extent);
      const rawCellKeys = payload.nonEmptyCellKeys;
      const nonEmptyCellKeys = Array.isArray(rawCellKeys)
        ? rawCellKeys.filter(
            (key): key is CellKey =>
              typeof key === 'string' && /^-?\d+:-?\d+$/.test(key),
          )
        : null;

      if (
        payload.version !== PRECOMPUTED_FORMAT_VERSION ||
        payload.format !== 'via-helvetica-precomputed-routing-graph' ||
        payload.projection !== 'EPSG:2056' ||
        payload.cellSizeMetres !== EXPECTED_CELL_SIZE_METRES ||
        !extent ||
        !nonEmptyCellKeys ||
        !Array.isArray(rawCellKeys) ||
        nonEmptyCellKeys.length !== rawCellKeys.length
      ) {
        throw new Error('Precomputed routing manifest is invalid or incompatible.');
      }

      return {
        version: payload.version,
        projection: payload.projection,
        cellSizeMetres: payload.cellSizeMetres,
        extent,
        nonEmptyCellKeys: new Set(nonEmptyCellKeys),
      };
    })
    .catch((error) => {
      // A temporary development-server failure must not poison every later
      // route request for the rest of the Worker session.
      manifestPromise = null;
      throw error;
    });

  return manifestPromise;
}

/** Returns whether a complete routing cell lies inside the generated region. */
function manifestContainsCell(
  manifest: PrecomputedRoutingManifest,
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

/** Reads a finite source coordinate while preserving optional elevation. */
function readCoordinate(payload: PrecomputedNodePayload): Coordinate | null {
  const [x, y, z] = payload;

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

/** Validates one global graph node from the compact local node table. */
function readNode(value: unknown): PrecomputedRoutingNode | null {
  if (!Array.isArray(value) || value.length < 2 || value.length > 3) {
    return null;
  }

  const payload = value as PrecomputedNodePayload;
  const coordinate = readCoordinate(payload);

  if (!coordinate) {
    return null;
  }

  return { key: precomputedNodeKey(coordinate), coordinate };
}

/** Validates one segment and resolves its local node indexes to global keys. */
function readSegment(
  value: unknown,
  nodes: PrecomputedRoutingNode[],
): PrecomputedRoutingSegment | null {
  if (!Array.isArray(value) || value.length < 3 || value.length > 4) {
    return null;
  }

  const [startIndex, endIndex, cost, hikingFlag] =
    value as PrecomputedSegmentPayload;

  if (
    !Number.isInteger(startIndex) ||
    !Number.isInteger(endIndex) ||
    typeof startIndex !== 'number' ||
    typeof endIndex !== 'number' ||
    startIndex < 0 ||
    endIndex < 0 ||
    startIndex >= nodes.length ||
    endIndex >= nodes.length ||
    startIndex === endIndex ||
    typeof cost !== 'number' ||
    !Number.isFinite(cost) ||
    cost <= 0 ||
    (hikingFlag !== undefined && hikingFlag !== 0 && hikingFlag !== 1)
  ) {
    return null;
  }

  return {
    startNodeKey: nodes[startIndex].key,
    endNodeKey: nodes[endIndex].key,
    cost,
    isHikingTrail: hikingFlag === 1,
  };
}

/** Validates one downloaded precomputed graph cell. */
function readCell(
  payload: PrecomputedCellPayload,
  expectedKey: CellKey,
): PrecomputedRoutingGraphData {
  if (
    payload.v !== PRECOMPUTED_FORMAT_VERSION ||
    payload.k !== expectedKey ||
    !readExtent(payload.e) ||
    !Array.isArray(payload.n) ||
    !Array.isArray(payload.s) ||
    !Number.isInteger(payload.f) ||
    typeof payload.f !== 'number' ||
    payload.f < 0
  ) {
    throw new Error(`Precomputed routing cell ${expectedKey} is invalid.`);
  }

  const nodes = payload.n
    .map(readNode)
    .filter((node): node is PrecomputedRoutingNode => node !== null);

  if (nodes.length !== payload.n.length) {
    throw new Error(`Precomputed routing cell ${expectedKey} has invalid nodes.`);
  }

  const segments = payload.s
    .map((segment) => readSegment(segment, nodes))
    .filter(
      (segment): segment is PrecomputedRoutingSegment => segment !== null,
    );

  if (segments.length !== payload.s.length) {
    throw new Error(`Precomputed routing cell ${expectedKey} has invalid segments.`);
  }

  return {
    nodes,
    segments,
    sourceRoadFeatures: payload.f,
    sourceHikingFeatures: 0,
  };
}

/**
 * Loads one offline-compiled Geneva graph cell.
 *
 * @param key - Exact 2.4 km routing-grid key requested by the engine.
 * @param signal - Abort signal owned by the current routing operation.
 * @returns Portable graph data; an unlisted in-region cell is empty.
 * @throws {PrecomputedRoutingCoverageError} Outside the generated region.
 * @throws {Error} When installed files are missing, malformed, or unavailable.
 */
export async function fetchPrecomputedGenevaRoutingCell(
  key: CellKey,
  signal: AbortSignal,
): Promise<PrecomputedRoutingGraphData> {
  const manifest = await loadManifest();

  if (!manifestContainsCell(manifest, key)) {
    throw new PrecomputedRoutingCoverageError();
  }

  if (!manifest.nonEmptyCellKeys.has(key)) {
    return {
      nodes: [],
      segments: [],
      sourceRoadFeatures: 0,
      sourceHikingFeatures: 0,
    };
  }

  const [column, row] = key.split(':');
  const response = await fetch(
    `${PRECOMPUTED_ROUTING_ROOT}/cells/${column}_${row}.json`,
    { signal },
  );

  if (response.status === 404) {
    throw new Error(`Precomputed routing cell ${key} is missing.`);
  }

  if (!response.ok) {
    throw new Error(
      `Precomputed routing cell ${key} request failed (${response.status}).`,
    );
  }

  return readCell((await response.json()) as PrecomputedCellPayload, key);
}
