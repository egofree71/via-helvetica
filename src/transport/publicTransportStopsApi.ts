/**
 * Business context: loads official BAV public-transport stops around the current
 * map viewport. Production uses bounded GeoAdmin identify requests, while an
 * explicit development setting can swap in a manually prepared local catalog so
 * the static-data architecture can be evaluated without changing map consumers.
 */
import type { Extent } from 'ol/extent.js';
import type { Language } from '../i18n/translations';
import { LV95_VIEW_RESOLUTIONS } from '../map/projection';
import {
  parsePublicTransportStop,
  PUBLIC_TRANSPORT_STOPS_LAYER_ID,
  type PublicTransportStop,
} from './publicTransportStopModel';
import { loadPublicTransportStopsFromLocalCatalog } from './publicTransportStopsLocalCatalog';

/** GeoAdmin identify endpoint used for viewport feature loading. */
const IDENTIFY_ENDPOINT =
  'https://api3.geo.admin.ch/rest/services/ech/MapServer/identify';

/**
 * Returns the optional Vite-served static catalog configured for local experiments.
 * Reading the value at call time lets tests explicitly choose their provider instead
 * of inheriting a developer's `.env.local` setting at module-import time.
 */
function getLocalPublicTransportStopsUrl(): string {
  return (import.meta.env.VITE_PUBLIC_TRANSPORT_STOPS_LOCAL_URL ?? '').trim();
}

/**
 * Reports whether viewport stop loading currently uses the static local catalog.
 * The map runtime uses this capability flag to refresh cheap in-memory coverage
 * proactively during pans without applying the same request rate to GeoAdmin.
 */
export function isLocalPublicTransportStopsCatalogEnabled(): boolean {
  return getLocalPublicTransportStopsUrl().length > 0;
}

/** Maximum number of features returned by one GeoAdmin identify request. */
const IDENTIFY_RESULT_LIMIT = 200;

/**
 * Maximum recursive viewport subdivision depth.
 * Dense city centres can exceed the API limit, while a bounded depth prevents
 * one map movement from creating an accidental request storm.
 */
const MAX_SUBDIVISION_DEPTH = 5;

/** Browser display density in dots per inch sent to GeoAdmin identify. */
const IDENTIFY_DPI = 96;

/**
 * Highest native zoom used to describe portrayal scale to GeoAdmin.
 * Closer levels expose platform and operating sub-points instead of stable
 * passenger stops, so only the scale context is capped while the buffered
 * request envelope still controls which geometries are returned.
 */
const PUBLIC_TRANSPORT_IDENTIFY_MAX_ZOOM = 25;

/** Minimum map resolution in metres per CSS pixel used for identification. */
const PUBLIC_TRANSPORT_IDENTIFY_MIN_RESOLUTION =
  LV95_VIEW_RESOLUTIONS[PUBLIC_TRANSPORT_IDENTIFY_MAX_ZOOM];

/** JSON envelope returned by the GeoAdmin identify service. */
interface IdentifyResponse {
  /** Loosely typed feature records owned by the external provider. */
  results?: unknown[];
}

/** Viewport context required to load and filter nearby passenger stops. */
export interface PublicTransportStopsLoadContext {
  /** Buffered EPSG:2056 envelope whose stop geometries must be returned. */
  requestExtent: Extent;
  /** Real visible EPSG:2056 extent used only for identify portrayal scale. */
  viewportExtent: Extent;
  /** Current map canvas size in CSS pixels. */
  imageSize: [number, number];
  /** Language requested for official names and attribute values. */
  language: Language;
}

/**
 * Returns the extent used only to communicate portrayal scale to GeoAdmin.
 *
 * @param extent - Real viewport extent in EPSG:2056.
 * @param imageSize - Current map canvas size in CSS pixels.
 * @returns The real extent at ordinary scales, or a wider scale-only extent
 * when the user zooms beyond the stable passenger-stop publication level.
 */
function createIdentifyScaleExtent(
  extent: Extent,
  imageSize: [number, number],
): Extent {
  const currentResolution = Math.max(
    (extent[2] - extent[0]) / Math.max(imageSize[0], 1),
    (extent[3] - extent[1]) / Math.max(imageSize[1], 1),
  );

  if (currentResolution >= PUBLIC_TRANSPORT_IDENTIFY_MIN_RESOLUTION) {
    return extent;
  }

  const centerX = (extent[0] + extent[2]) / 2;
  const centerY = (extent[1] + extent[3]) / 2;
  const halfWidth =
    (imageSize[0] * PUBLIC_TRANSPORT_IDENTIFY_MIN_RESOLUTION) / 2;
  const halfHeight =
    (imageSize[1] * PUBLIC_TRANSPORT_IDENTIFY_MIN_RESOLUTION) / 2;

  return [
    centerX - halfWidth,
    centerY - halfHeight,
    centerX + halfWidth,
    centerY + halfHeight,
  ];
}

/** Splits one EPSG:2056 extent into four non-overlapping quadrants. */
function subdivideExtent(extent: Extent): Extent[] {
  const centerX = (extent[0] + extent[2]) / 2;
  const centerY = (extent[1] + extent[3]) / 2;

  return [
    [extent[0], extent[1], centerX, centerY],
    [centerX, extent[1], extent[2], centerY],
    [extent[0], centerY, centerX, extent[3]],
    [centerX, centerY, extent[2], extent[3]],
  ];
}

/**
 * Requests one envelope and recursively subdivides responses that hit the cap.
 *
 * @param extent - Geometry envelope whose features must be returned.
 * @param context - Real viewport scale, image size, and requested language.
 * @param signal - Abort signal for superseded map movements.
 * @param depth - Current bounded subdivision depth.
 * @returns Raw GeoAdmin identify records for this envelope and its children.
 * @throws {Error} When GeoAdmin responds with a non-success status.
 */
async function fetchStopsForExtent(
  extent: Extent,
  context: PublicTransportStopsLoadContext,
  signal: AbortSignal,
  depth: number,
): Promise<unknown[]> {
  const parameters = new URLSearchParams({
    geometry: extent.join(','),
    geometryType: 'esriGeometryEnvelope',
    geometryFormat: 'geojson',
    layers: `all:${PUBLIC_TRANSPORT_STOPS_LAYER_ID}`,
    tolerance: '0',
    mapExtent: createIdentifyScaleExtent(
      context.viewportExtent,
      context.imageSize,
    ).join(','),
    imageDisplay: `${Math.round(context.imageSize[0])},${Math.round(context.imageSize[1])},${IDENTIFY_DPI}`,
    returnGeometry: 'true',
    sr: '2056',
    lang: context.language,
    limit: String(IDENTIFY_RESULT_LIMIT),
  });
  const response = await fetch(`${IDENTIFY_ENDPOINT}?${parameters}`, {
    signal,
  });

  if (!response.ok) {
    throw new Error(
      `Public-transport stop loading failed with ${response.status}.`,
    );
  }

  const payload = (await response.json()) as IdentifyResponse;
  const results = Array.isArray(payload.results) ? payload.results : [];

  if (
    results.length < IDENTIFY_RESULT_LIMIT ||
    depth >= MAX_SUBDIVISION_DEPTH
  ) {
    return results;
  }

  // Hitting the provider cap means the response may be truncated. Subdividing
  // the same geometry envelope preserves complete stop coverage without
  // increasing the untrusted per-request result limit.
  const nestedResults = await Promise.all(
    subdivideExtent(extent).map((cell) =>
      fetchStopsForExtent(cell, context, signal, depth + 1),
    ),
  );

  return nestedResults.flat();
}

/**
 * Loads passenger stops for one buffered envelope around the visible map.
 *
 * @param context - Request envelope, real viewport scale, and interface language.
 * @param signal - Abort signal for superseded pans, zooms, or layer hiding.
 * @returns Passenger stops deduplicated strictly by official feature identifier.
 * @throws {Error} When the configured stop provider cannot load valid data.
 */
export async function loadPublicTransportStops(
  context: PublicTransportStopsLoadContext,
  signal: AbortSignal,
): Promise<PublicTransportStop[]> {
  const localCatalogUrl = getLocalPublicTransportStopsUrl();
  if (localCatalogUrl) {
    return loadPublicTransportStopsFromLocalCatalog(
      localCatalogUrl,
      context.requestExtent,
      signal,
    );
  }

  const rawResults = await fetchStopsForExtent(
    context.requestExtent,
    context,
    signal,
    0,
  );
  const stops = new Map<string, PublicTransportStop>();

  for (const rawResult of rawResults) {
    const stop = parsePublicTransportStop(rawResult);

    if (stop) {
      stops.set(stop.id, stop);
    }
  }

  // Recursive viewport subdivision can return the same feature more than
  // once. Only exact-ID duplicates are removed; distinct nearby facilities are
  // never merged by name or distance because they may expose different boards.
  return [...stops.values()];
}
