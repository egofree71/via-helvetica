/**
 * Business context: retrieves one terrain elevation for explicit map-position
 * inspection without building a route profile. The request stays independent
 * from itinerary metrics so a desktop right-click can fail without affecting
 * route planning or any current itinerary.
 */
import type { Coordinate } from 'ol/coordinate.js';
import { MAP_PROJECTION_CODE } from './projection';

/** Official GeoAdmin endpoint returning the height at one Swiss coordinate. */
const POINT_HEIGHT_ENDPOINT =
  'https://api3.geo.admin.ch/rest/services/height';

/** Untrusted response shape returned by the point-height service. */
interface PointHeightPayload {
  /** Terrain height, currently returned by GeoAdmin as a numeric string. */
  height?: unknown;
}

/** Parses a finite provider number without accepting arbitrary values. */
function readFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsedValue = Number(value);
    return Number.isFinite(parsedValue) ? parsedValue : null;
  }

  return null;
}

/**
 * Fetches the terrain elevation for one native LV95 map coordinate.
 *
 * @param coordinate - Point in the application's EPSG:2056 map projection.
 * @param signal - Abort signal invalidated by a newer click, dismissal, or unmount.
 * @returns Terrain elevation in metres.
 * @throws {Error} When the provider fails or returns an invalid height.
 */
export async function fetchPointHeight(
  coordinate: Coordinate,
  signal: AbortSignal,
): Promise<number> {
  const [easting, northing] = coordinate;

  if (!Number.isFinite(easting) || !Number.isFinite(northing)) {
    throw new Error('Point-height lookup requires a finite LV95 coordinate.');
  }

  const requestUrl = new URL(POINT_HEIGHT_ENDPOINT);
  requestUrl.searchParams.set('easting', easting.toFixed(2));
  requestUrl.searchParams.set('northing', northing.toFixed(2));
  requestUrl.searchParams.set('sr', MAP_PROJECTION_CODE.replace('EPSG:', ''));

  const response = await fetch(requestUrl, { signal });

  if (!response.ok) {
    throw new Error(`Point-height request failed with ${response.status}.`);
  }

  const payload: unknown = await response.json();

  if (!payload || typeof payload !== 'object') {
    throw new Error('Point-height response is not an object.');
  }

  const heightMeters = readFiniteNumber(
    (payload as PointHeightPayload).height,
  );

  if (heightMeters === null) {
    throw new Error('Point-height response contains no valid height.');
  }

  return heightMeters;
}
