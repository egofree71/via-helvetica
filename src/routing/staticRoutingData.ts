/**
 * Business context: loads the experimental static Geneva routing cells created
 * from the official swissTLM3D GeoPackage. The files already contain normalized
 * road attributes and a precomputed hiking flag, so local routing can be tested
 * without GeoAdmin identify requests or browser-side road/hiking geometry merge.
 */
import { extentForCellKey, type CellKey } from './routingGrid';
import { RoutingCoverageError } from './routingCoverage';
import {
  readStaticRoutingCell,
  readStaticRoutingExtent,
  STATIC_ROUTING_FORMAT,
  STATIC_ROUTING_FORMAT_VERSION,
  type StaticCellPayload,
} from './staticRoutingCellFormat';
import type { SwissTlmNetworkData } from './swissTlmApi';

/** Root URL copied unchanged by Vite from the public directory. */
const STATIC_ROUTING_ROOT = '/routing-data/geneva';
/** Exact grid size shared with the browser routing engine. */
const EXPECTED_CELL_SIZE_METRES = 2_400;

/** Manifest describing the bounded static-data region. */
interface StaticRoutingManifest {
  /** File-format version validated before any routing cell is trusted. */
  version: number;
  /** Coordinate system used by every cell coordinate. */
  projection: string;
  /** Width and height of one routing cell in metres. */
  cellSizeMetres: number;
  /** Closed LV95 bounding box covered by the experimental data. */
  extent: [number, number, number, number];
  /** Exact non-empty cells written by the offline extraction. */
  nonEmptyCellKeys: Set<CellKey>;
}

/** Untrusted JSON representation of the static routing manifest. */
interface StaticRoutingManifestPayload {
  version?: unknown;
  format?: unknown;
  projection?: unknown;
  cellSizeMetres?: unknown;
  extent?: unknown;
  nonEmptyCellKeys?: unknown;
}

/** Raised when the local static experiment is asked to route outside Geneva. */
export class StaticRoutingCoverageError extends RoutingCoverageError {
  constructor() {
    super(
      'StaticRoutingCoverageError',
      'The static Geneva routing experiment does not cover this area.',
    );
  }
}

let manifestPromise: Promise<StaticRoutingManifest> | null = null;

/** Loads and validates the single small manifest shared by all static cells. */
async function loadManifest(): Promise<StaticRoutingManifest> {
  if (manifestPromise) {
    return manifestPromise;
  }

  manifestPromise = fetch(`${STATIC_ROUTING_ROOT}/manifest.json`)
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`Static routing manifest request failed (${response.status}).`);
      }

      const payload = (await response.json()) as StaticRoutingManifestPayload;
      const extent = readStaticRoutingExtent(payload.extent);
      const rawCellKeys = payload.nonEmptyCellKeys;
      const nonEmptyCellKeys = Array.isArray(rawCellKeys)
        ? rawCellKeys.filter(
            (key): key is CellKey =>
              typeof key === 'string' && /^-?\d+:-?\d+$/.test(key),
          )
        : null;

      if (
        payload.version !== STATIC_ROUTING_FORMAT_VERSION ||
        payload.format !== STATIC_ROUTING_FORMAT ||
        payload.projection !== 'EPSG:2056' ||
        payload.cellSizeMetres !== EXPECTED_CELL_SIZE_METRES ||
        !extent ||
        !nonEmptyCellKeys ||
        !Array.isArray(rawCellKeys) ||
        nonEmptyCellKeys.length !== rawCellKeys.length
      ) {
        throw new Error('Static routing manifest is invalid or incompatible.');
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
      // A transient development-server failure must not poison all later route
      // attempts for the rest of the page session.
      manifestPromise = null;
      throw error;
    });

  return manifestPromise;
}

/** Returns whether a complete routing cell lies inside the generated region. */
function manifestContainsCell(
  manifest: StaticRoutingManifest,
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
 * Loads one pre-generated Geneva routing cell.
 *
 * @param key - Exact 2.4 km routing-grid key requested by the engine.
 * @param signal - Abort signal owned by the current route operation.
 * @returns Normalized road data; a missing file inside coverage means an empty cell.
 * @throws {StaticRoutingCoverageError} When the requested cell is outside the experiment.
 * @throws {Error} When the manifest or cell contents are malformed or unavailable.
 */
export async function fetchStaticGenevaRoutingCell(
  key: CellKey,
  signal: AbortSignal,
): Promise<SwissTlmNetworkData> {
  const manifest = await loadManifest();

  if (!manifestContainsCell(manifest, key)) {
    throw new StaticRoutingCoverageError();
  }

  if (!manifest.nonEmptyCellKeys.has(key)) {
    return { roads: [], hikingTrails: [] };
  }

  const [column, row] = key.split(':');
  const response = await fetch(
    `${STATIC_ROUTING_ROOT}/cells/${column}_${row}.json`,
    { signal },
  );

  // A missing listed file indicates an incomplete installation rather than an
  // empty cell; unlisted cells were already handled from the manifest above.
  if (response.status === 404) {
    throw new Error(`Static routing cell ${key} is missing.`);
  }

  if (!response.ok) {
    throw new Error(`Static routing cell ${key} request failed (${response.status}).`);
  }

  const cell = readStaticRoutingCell(
    (await response.json()) as StaticCellPayload,
    key,
  );

  return { roads: cell.roads, hikingTrails: [] };
}
