/**
 * Business context: provides an opt-in static public-transport stop catalog for
 * local development experiments. The complete FOT dataset is fetched only once,
 * normalized into passenger stops, indexed in LV95 grid cells, and filtered by
 * viewport extent so OpenLayers still receives only geographically useful stops.
 * Production keeps the GeoAdmin identify provider unless an explicit local URL
 * is configured.
 */
import type { Extent } from 'ol/extent.js';
import {
  normalizePublicTransportStop,
  PUBLIC_TRANSPORT_STOPS_LAYER_ID,
  type PublicTransportStop,
} from './publicTransportStopModel';

/** Current generated-catalog schema version. */
const LOCAL_CATALOG_VERSION = 2;

/**
 * Spatial grid size in metres.
 * Ten-kilometre cells keep the national index small while limiting each viewport
 * lookup to nearby buckets instead of scanning roughly 25,000 passenger stops.
 */
const LOCAL_CATALOG_GRID_SIZE_METERS = 10_000;

/** Compact record emitted by the local offline preparation script. */
type LocalCatalogRecord = [
  id: string,
  name: string,
  meansOfTransportIndex: number,
  stopTypeIndex: number,
  east: number,
  north: number,
];

/** Serialized local artifact loaded by the browser during the experiment. */
interface LocalCatalogPayload {
  /** Schema version guarding incompatible local artifacts. */
  version: number;
  /** Source dataset identifier kept for provenance validation. */
  source: string;
  /** ISO generation timestamp for diagnostics only. */
  generatedAt?: string;
  /** Deduplicated raw transport descriptions referenced by record index. */
  meansOfTransport: unknown[];
  /** Deduplicated raw stop-type descriptions referenced by record index. */
  stopTypes: unknown[];
  /** Compact raw stop records normalized after dictionary expansion. */
  records: unknown[];
}

/** In-memory grid built once from one static local artifact. */
interface LocalCatalogIndex {
  /** Passenger stops bucketed by 10 km LV95 cells. */
  cells: Map<string, PublicTransportStop[]>;
}

let cachedCatalogUrl: string | null = null;
let cachedCatalogPromise: Promise<LocalCatalogIndex> | null = null;

function gridCoordinate(value: number): number {
  return Math.floor(value / LOCAL_CATALOG_GRID_SIZE_METERS);
}

function gridKey(eastCell: number, northCell: number): string {
  return `${eastCell}:${northCell}`;
}

function parseLocalCatalogRecord(
  value: unknown,
  meansOfTransport: string[],
  stopTypes: string[],
): PublicTransportStop | null {
  if (!Array.isArray(value) || value.length < 6) {
    return null;
  }

  const [id, name, meansOfTransportIndex, stopTypeIndex, east, north] = value;
  if (
    typeof id !== 'string' ||
    typeof name !== 'string' ||
    typeof meansOfTransportIndex !== 'number' ||
    !Number.isInteger(meansOfTransportIndex) ||
    meansOfTransportIndex < 0 ||
    meansOfTransportIndex >= meansOfTransport.length ||
    typeof stopTypeIndex !== 'number' ||
    !Number.isInteger(stopTypeIndex) ||
    stopTypeIndex < 0 ||
    stopTypeIndex >= stopTypes.length ||
    typeof east !== 'number' ||
    !Number.isFinite(east) ||
    typeof north !== 'number' ||
    !Number.isFinite(north)
  ) {
    return null;
  }

  return normalizePublicTransportStop({
    id,
    name,
    meansOfTransport: meansOfTransport[meansOfTransportIndex],
    stopType: stopTypes[stopTypeIndex],
    coordinate: [east, north],
  });
}

/** Validates one generated string dictionary before record indexes are trusted. */
function parseStringDictionary(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value
    : null;
}

function buildLocalCatalogIndex(payload: LocalCatalogPayload): LocalCatalogIndex {
  const meansOfTransport = parseStringDictionary(payload.meansOfTransport);
  const stopTypes = parseStringDictionary(payload.stopTypes);
  if (
    payload.version !== LOCAL_CATALOG_VERSION ||
    payload.source !== PUBLIC_TRANSPORT_STOPS_LAYER_ID ||
    !meansOfTransport ||
    !stopTypes ||
    !Array.isArray(payload.records)
  ) {
    throw new Error('Unsupported local public-transport stop catalog.');
  }

  const cells = new Map<string, PublicTransportStop[]>();
  const seenStopIds = new Set<string>();
  for (const rawRecord of payload.records) {
    const stop = parseLocalCatalogRecord(
      rawRecord,
      meansOfTransport,
      stopTypes,
    );
    if (!stop || seenStopIds.has(stop.id)) continue;
    seenStopIds.add(stop.id);

    const key = gridKey(
      gridCoordinate(stop.coordinate[0]),
      gridCoordinate(stop.coordinate[1]),
    );
    const bucket = cells.get(key);
    if (bucket) {
      bucket.push(stop);
    } else {
      cells.set(key, [stop]);
    }
  }

  return { cells };
}

async function loadLocalCatalogIndex(url: string): Promise<LocalCatalogIndex> {
  if (cachedCatalogPromise && cachedCatalogUrl === url) {
    return cachedCatalogPromise;
  }

  const loadPromise = fetch(url).then(async (response) => {
    if (!response.ok) {
      throw new Error(
        `Local public-transport stop catalog failed with ${response.status}.`,
      );
    }

    return buildLocalCatalogIndex(
      (await response.json()) as LocalCatalogPayload,
    );
  });
  const retryablePromise = loadPromise.catch((error) => {
    // A failed first local experiment must be retryable after the generated
    // file is corrected or replaced without requiring a page reload. Do not
    // clear a newer cache if a different URL was configured in the meantime.
    if (cachedCatalogUrl === url) {
      cachedCatalogPromise = null;
      cachedCatalogUrl = null;
    }
    throw error;
  });

  cachedCatalogUrl = url;
  cachedCatalogPromise = retryablePromise;
  return retryablePromise;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('The operation was aborted.', 'AbortError');
  }
}

/**
 * Loads passenger stops from one generated local static catalog.
 *
 * The national file is intentionally not tied to a viewport AbortSignal: once a
 * developer opts into the experiment, finishing the single lazy download is more
 * useful than repeatedly restarting it during pans. Superseded viewport calls
 * are still discarded before and after the shared load.
 *
 * @param url - Vite-served URL of the generated local catalog.
 * @param extent - Buffered LV95 viewport extent to query.
 * @param signal - Abort signal used to discard superseded viewport results.
 * @returns Passenger stops contained by the requested extent.
 * @throws {Error} When the local artifact cannot be loaded or is incompatible.
 */
export async function loadPublicTransportStopsFromLocalCatalog(
  url: string,
  extent: Extent,
  signal: AbortSignal,
): Promise<PublicTransportStop[]> {
  throwIfAborted(signal);
  const index = await loadLocalCatalogIndex(url);
  throwIfAborted(signal);

  const minEastCell = gridCoordinate(extent[0]);
  const minNorthCell = gridCoordinate(extent[1]);
  const maxEastCell = gridCoordinate(extent[2]);
  const maxNorthCell = gridCoordinate(extent[3]);
  const stops: PublicTransportStop[] = [];

  for (let eastCell = minEastCell; eastCell <= maxEastCell; eastCell += 1) {
    for (
      let northCell = minNorthCell;
      northCell <= maxNorthCell;
      northCell += 1
    ) {
      const bucket = index.cells.get(gridKey(eastCell, northCell));
      if (!bucket) continue;

      for (const stop of bucket) {
        const [east, north] = stop.coordinate;
        if (
          east >= extent[0] &&
          east <= extent[2] &&
          north >= extent[1] &&
          north <= extent[3]
        ) {
          stops.push(stop);
        }
      }
    }
  }

  return stops;
}

/** Resets module-level state for deterministic unit tests. */
export function resetLocalPublicTransportStopsCatalogForTests(): void {
  cachedCatalogUrl = null;
  cachedCatalogPromise = null;
}
