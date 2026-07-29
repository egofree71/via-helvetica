/**
 * Business context: derives the compact planning statistics shown for the
 * current route. Distance is calculated immediately in the browser. Editable
 * routes use GeoAdmin's elevation service, while imported GPX files reuse their
 * complete embedded elevations when possible. The ordered profile samples also
 * feed the Swiss hiking-time polynomial published by Schweizer Wanderwege.
 */
import type { Coordinate } from 'ol/coordinate.js';
import LineString from 'ol/geom/LineString.js';
import { getDistance, getLength } from 'ol/sphere.js';
import {
  MAP_PROJECTION_CODE,
  toWgs84Coordinates,
} from '../map/projection';

/** Official GeoAdmin endpoint returning elevations along an LV95 polyline. */
const ELEVATION_PROFILE_ENDPOINT =
  'https://api3.geo.admin.ch/rest/services/profile.json';
/** Target spacing in metres between elevation samples along the route. */
const PROFILE_SAMPLE_INTERVAL_METERS = 20;
/** Minimum profile size required to calculate ascent and descent. */
const PROFILE_MIN_SAMPLE_POINTS = 2;
/**
 * Maximum combined response size requested from the profile service. Independent
 * route segments share this budget so provider fragmentation cannot multiply
 * profile size while ordinary hikes retain roughly 20 metre sampling.
 */
const PROFILE_MAX_SAMPLE_POINTS = 1_000;
/**
 * Maximum amount of route vertices sent to GeoAdmin. The service accepts up to
 * roughly 5,000 coordinates; staying below that cap leaves room for future
 * endpoint changes and limits request-body size.
 */
const PROFILE_MAX_INPUT_COORDINATES = 4_000;
/**
 * Number of neighbouring samples on either side used by the service's moving
 * average. A small value reduces terrain noise without flattening genuine
 * climbs over normal hiking distances.
 */
const PROFILE_SMOOTHING_OFFSET = 2;
/**
 * Coefficients of the 15th-degree Swiss hiking-time polynomial.
 *
 * Schweizer Wanderwege published these numeric parameters in
 * "Wanderzeitberechnung, Version 2020.2" dated 8 June 2020. The polynomial
 * returns minutes per kilometre for a slope expressed in percent. Keeping the
 * coefficients in ascending degree order makes the source table easy to audit;
 * evaluation below uses Horner's method for numerical stability.
 */
const SWISS_HIKING_TIME_COEFFICIENTS = [
  14.271,
  0.36992,
  0.025922,
  -0.0014384,
  0.000032105,
  0.0000081542,
  -9.0261e-8,
  -2.0757e-8,
  1.0192e-10,
  2.8588e-11,
  -5.7466e-14,
  -2.1842e-14,
  1.5176e-17,
  8.6894e-18,
  -1.3584e-21,
  -1.4026e-21,
] as const;
/**
 * Published validity boundary of the polynomial. Clamping avoids extrapolating
 * the high-degree curve when a short sampled section exceeds a 40 percent
 * slope because of genuine terrain or residual elevation noise.
 */
const SWISS_HIKING_TIME_MAX_SLOPE_PERCENT = 40;

/** Availability state for altitude-dependent itinerary figures. */
export type RouteElevationStatus = 'loading' | 'ready' | 'error';

/** One ordered elevation sample along the route. */
export interface RouteElevationPoint {
  /** Cumulative distance from the start of the route in metres. */
  distanceMeters: number;
  /** Profile elevation in metres. */
  elevationMeters: number;
}

/** Elevation values used by the route summary and optional profile chart. */
export interface RouteElevationSummary {
  /** Accumulated positive elevation change in metres. */
  ascentMeters: number;
  /** Accumulated negative elevation change in metres, expressed positively. */
  descentMeters: number;
  /** Ordered samples used by the elevation chart. */
  points: RouteElevationPoint[];
}

/** One imported GPX segment with a complete altitude for every map coordinate. */
export interface ImportedRouteElevationSegment {
  /** Ordered segment geometry in EPSG:2056. */
  coordinates: Coordinate[];
  /** Embedded GPX elevations matching the coordinate array one-for-one. */
  elevationsMeters: number[];
}

/** Monotone lookup state reused while sampling one imported elevation series. */
interface ImportedElevationCursor {
  /** First source point whose distance is at or beyond the current sample. */
  upperIndex: number;
}

/** Untrusted altitude container returned by the profile service. */
interface ElevationProfileAltitudes {
  /** Combined best-available terrain model value. */
  COMB?: unknown;
}

/** One untrusted elevation sample returned by GeoAdmin. */
interface ElevationProfilePoint {
  /** Available terrain-model altitudes for the sample. */
  alts?: ElevationProfileAltitudes;
  /** Cumulative distance from the start of the requested profile. */
  dist?: unknown;
}

/** Returns a finite number from an external numeric value or numeric string. */
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

/** Copies one native LV95 map coordinate for the profile-service payload. */
function mapCoordinateToLv95(coordinate: Coordinate): Coordinate {
  return [coordinate[0], coordinate[1]];
}

/**
 * Reduces very dense route geometry while preserving the first and last point.
 *
 * The elevation service resamples the complete polyline itself, so uniformly
 * retaining up to 4,000 source vertices is sufficient for height lookup while
 * preventing oversized request bodies on unusually detailed routes.
 */
function limitProfileCoordinates(coordinates: Coordinate[]): Coordinate[] {
  if (coordinates.length <= PROFILE_MAX_INPUT_COORDINATES) {
    return coordinates;
  }

  const limitedCoordinates: Coordinate[] = [];
  const lastIndex = coordinates.length - 1;

  for (let index = 0; index < PROFILE_MAX_INPUT_COORDINATES; index += 1) {
    const sourceIndex = Math.round(
      (index * lastIndex) / (PROFILE_MAX_INPUT_COORDINATES - 1),
    );
    limitedCoordinates.push(coordinates[sourceIndex]);
  }

  return limitedCoordinates;
}

/** Calculates the ideal amount of elevation samples before applying a budget. */
function targetProfileSampleCount(distanceMeters: number): number {
  return Math.max(
    PROFILE_MIN_SAMPLE_POINTS,
    Math.ceil(distanceMeters / PROFILE_SAMPLE_INTERVAL_METERS) + 1,
  );
}

/** Applies the global safety cap to one continuous route profile. */
function profileSampleCount(distanceMeters: number): number {
  return Math.min(
    PROFILE_MAX_SAMPLE_POINTS,
    targetProfileSampleCount(distanceMeters),
  );
}

/** Measurable route segment paired with its geodesic length and sample budget. */
interface MeasurableProfileSegment {
  /** Independent route geometry in EPSG:2056. */
  segment: Coordinate[];
  /** Geodesic segment length in metres. */
  distanceMeters: number;
  /** Number of elevation points requested for this segment. */
  sampleCount: number;
}

/**
 * Shares the global profile budget across independent route segments.
 *
 * Every measurable segment keeps at least its two endpoints. Remaining points
 * are distributed in proportion to the density each segment would request on
 * its own, while largest fractional remainders consume the final rounding slots.
 *
 * @param segments - Independent route geometries in EPSG:2056.
 * @returns Measurable segments with a combined sample count no greater than 1,000.
 * @throws {Error} When more independent segments exist than the budget can represent.
 */
function allocateSegmentProfileSamples(
  segments: Coordinate[][],
): MeasurableProfileSegment[] {
  const measurableSegments = segments
    .map((segment) => ({
      segment,
      distanceMeters: calculateRouteDistance(segment),
    }))
    .filter(
      ({ segment, distanceMeters }) =>
        segment.length >= 2 && distanceMeters > 0,
    );

  if (
    measurableSegments.length * PROFILE_MIN_SAMPLE_POINTS >
    PROFILE_MAX_SAMPLE_POINTS
  ) {
    throw new Error(
      'Elevation profile contains too many independent route segments.',
    );
  }

  const desiredSampleCounts = measurableSegments.map(({ distanceMeters }) =>
    targetProfileSampleCount(distanceMeters),
  );
  const desiredTotal = desiredSampleCounts.reduce(
    (total, sampleCount) => total + sampleCount,
    0,
  );

  if (desiredTotal <= PROFILE_MAX_SAMPLE_POINTS) {
    return measurableSegments.map((segment, index) => ({
      ...segment,
      sampleCount: desiredSampleCounts[index],
    }));
  }

  const minimumTotal =
    measurableSegments.length * PROFILE_MIN_SAMPLE_POINTS;
  const remainingBudget = PROFILE_MAX_SAMPLE_POINTS - minimumTotal;
  const desiredExtraCounts = desiredSampleCounts.map(
    (sampleCount) => sampleCount - PROFILE_MIN_SAMPLE_POINTS,
  );
  const desiredExtraTotal = desiredExtraCounts.reduce(
    (total, sampleCount) => total + sampleCount,
    0,
  );
  const allocations = desiredExtraCounts.map((desiredExtraCount, index) => {
    const exactShare =
      (remainingBudget * desiredExtraCount) / desiredExtraTotal;
    const allocatedExtraCount = Math.floor(exactShare);

    return {
      index,
      allocatedExtraCount,
      remainder: exactShare - allocatedExtraCount,
    };
  });
  let unallocatedPoints =
    remainingBudget -
    allocations.reduce(
      (total, allocation) => total + allocation.allocatedExtraCount,
      0,
    );

  // Largest remainders keep the proportional distribution deterministic while
  // ensuring rounding never pushes the combined provider request above 1,000.
  for (const allocation of [...allocations].sort(
    (first, second) =>
      second.remainder - first.remainder || first.index - second.index,
  )) {
    if (unallocatedPoints === 0) {
      break;
    }

    allocation.allocatedExtraCount += 1;
    unallocatedPoints -= 1;
  }

  return measurableSegments.map((segment, index) => ({
    ...segment,
    sampleCount:
      PROFILE_MIN_SAMPLE_POINTS + allocations[index].allocatedExtraCount,
  }));
}

/**
 * Calculates geodesic route length from the displayed native LV95 geometry.
 * @param coordinates - Ordered route vertices in EPSG:2056.
 * @returns Horizontal distance in metres, or zero for fewer than two points.
 */
export function calculateRouteDistance(coordinates: Coordinate[]): number {
  if (coordinates.length < 2) {
    return 0;
  }

  const line = new LineString(
    coordinates.map((coordinate) => [coordinate[0], coordinate[1]]),
  );
  return getLength(line, { projection: MAP_PROJECTION_CODE });
}

/** Calculates total geodesic length without inventing links across GPX gaps. */
export function calculateRouteSegmentsDistance(segments: Coordinate[][]): number {
  return segments.reduce(
    (total, segment) => total + calculateRouteDistance(segment),
    0,
  );
}

/** Measures cumulative geodesic distances at each imported GPX coordinate. */
function measureImportedSegment(coordinates: Coordinate[]): number[] {
  const lonLatCoordinates = toWgs84Coordinates(coordinates);
  const cumulativeDistances = [0];

  for (let index = 1; index < lonLatCoordinates.length; index += 1) {
    cumulativeDistances.push(
      cumulativeDistances[cumulativeDistances.length - 1] +
        getDistance(lonLatCoordinates[index - 1], lonLatCoordinates[index]),
    );
  }

  return cumulativeDistances;
}

/**
 * Interpolates an imported GPX elevation at one cumulative segment distance.
 * Samples are requested in ascending order, so the shared cursor advances only
 * forward instead of rescanning a dense recording from its first point.
 *
 * @param cumulativeDistances - Ordered source-point distances in metres.
 * @param elevationsMeters - Elevations matching the source points one-for-one.
 * @param distanceMeters - Requested segment-local cumulative distance.
 * @param cursor - Mutable monotone lookup position for this segment only.
 * @returns Linearly interpolated elevation in metres.
 */
function importedElevationAtDistance(
  cumulativeDistances: number[],
  elevationsMeters: number[],
  distanceMeters: number,
  cursor: ImportedElevationCursor,
): number {
  if (distanceMeters <= 0) {
    return elevationsMeters[0];
  }

  const lastIndex = cumulativeDistances.length - 1;
  const totalDistanceMeters = cumulativeDistances[lastIndex];

  if (distanceMeters >= totalDistanceMeters) {
    cursor.upperIndex = lastIndex;
    return elevationsMeters[lastIndex];
  }

  while (
    cursor.upperIndex < cumulativeDistances.length &&
    cumulativeDistances[cursor.upperIndex] < distanceMeters
  ) {
    cursor.upperIndex += 1;
  }

  const lowerIndex = Math.max(0, cursor.upperIndex - 1);
  const lowerDistance = cumulativeDistances[lowerIndex];
  const upperDistance = cumulativeDistances[cursor.upperIndex];
  const distanceSpan = upperDistance - lowerDistance;
  const fraction =
    distanceSpan > 0
      ? (distanceMeters - lowerDistance) / distanceSpan
      : 0;

  return (
    elevationsMeters[lowerIndex] +
    (elevationsMeters[cursor.upperIndex] - elevationsMeters[lowerIndex]) *
      fraction
  );
}

/**
 * Builds a regular profile from complete elevations embedded in a GPX file.
 *
 * GPX track points are often distributed irregularly because they preserve map
 * bends as well as profile samples. Resampling the embedded altitude function at
 * the same roughly 20 metre interval used by GeoAdmin prevents dense bends from
 * producing a visibly jagged chart while retaining the file's own elevations.
 * Deliberate gaps remain independent for distance and elevation accumulation.
 *
 * @param segments - Imported map geometry with complete matching elevations.
 * @returns Combined route statistics and regularly spaced profile samples.
 * @throws {Error} If no segment contains a valid measurable elevation series.
 */
export function createImportedRouteElevationSummary(
  segments: ImportedRouteElevationSegment[],
): RouteElevationSummary {
  let ascentMeters = 0;
  let descentMeters = 0;
  let cumulativeRouteDistanceMeters = 0;
  const points: RouteElevationPoint[] = [];

  for (const segment of segments) {
    if (
      segment.coordinates.length < 2 ||
      segment.coordinates.length !== segment.elevationsMeters.length ||
      segment.elevationsMeters.some((elevation) => !Number.isFinite(elevation))
    ) {
      continue;
    }

    const cumulativeDistances = measureImportedSegment(segment.coordinates);
    const segmentDistanceMeters =
      cumulativeDistances[cumulativeDistances.length - 1] ?? 0;

    if (segmentDistanceMeters <= 0) {
      continue;
    }

    const sampleCount = profileSampleCount(segmentDistanceMeters);
    const segmentPoints: RouteElevationPoint[] = [];
    const elevationCursor: ImportedElevationCursor = { upperIndex: 1 };

    for (let index = 0; index < sampleCount; index += 1) {
      const distanceMeters =
        sampleCount === 1
          ? 0
          : (index / (sampleCount - 1)) * segmentDistanceMeters;
      segmentPoints.push({
        distanceMeters: cumulativeRouteDistanceMeters + distanceMeters,
        elevationMeters: importedElevationAtDistance(
          cumulativeDistances,
          segment.elevationsMeters,
          distanceMeters,
          elevationCursor,
        ),
      });
    }

    for (let index = 1; index < segmentPoints.length; index += 1) {
      const difference =
        segmentPoints[index].elevationMeters -
        segmentPoints[index - 1].elevationMeters;

      if (difference > 0) {
        ascentMeters += difference;
      } else {
        descentMeters -= difference;
      }
    }

    points.push(...segmentPoints);
    cumulativeRouteDistanceMeters += segmentDistanceMeters;
  }

  if (points.length < PROFILE_MIN_SAMPLE_POINTS) {
    throw new Error('Imported elevation profile contains too few valid samples.');
  }

  return { ascentMeters, descentMeters, points };
}

/**
 * Retrieves elevation profiles for independent GPX segments and combines their
 * totals without adding ascent, descent, or distance across deliberate gaps.
 *
 * @param segments - Independent itinerary lines in EPSG:2056.
 * @param signal - Abort signal used when another GPX or route replaces the request.
 * @returns Combined ascent, descent, and cumulative samples without gap connectors.
 * @throws {Error} If no usable segment profile can be retrieved or validated.
 */
export async function fetchRouteSegmentsElevationSummary(
  segments: Coordinate[][],
  signal: AbortSignal,
): Promise<RouteElevationSummary> {
  let ascentMeters = 0;
  let descentMeters = 0;
  let cumulativeDistanceMeters = 0;
  const points: RouteElevationPoint[] = [];
  const measurableSegments = allocateSegmentProfileSamples(segments);

  for (const { segment, distanceMeters, sampleCount } of measurableSegments) {
    const summary = await fetchRouteElevationSummary(
      segment,
      distanceMeters,
      signal,
      sampleCount,
    );

    ascentMeters += summary.ascentMeters;
    descentMeters += summary.descentMeters;
    points.push(
      ...summary.points.map((point) => ({
        ...point,
        distanceMeters: point.distanceMeters + cumulativeDistanceMeters,
      })),
    );
    cumulativeDistanceMeters += distanceMeters;
  }

  if (points.length < PROFILE_MIN_SAMPLE_POINTS) {
    throw new Error('Elevation profile contains too few valid samples.');
  }

  return { ascentMeters, descentMeters, points };
}

/**
 * Retrieves and accumulates smoothed elevations along the current route.
 *
 * @param coordinates - Ordered route vertices in EPSG:2056.
 * @param distanceMeters - Already calculated route distance used to size the profile.
 * @param signal - Abort signal used when route history changes before completion.
 * @param requestedSampleCount - Optional share of a multi-segment global budget.
 * @returns Total ascent and descent in metres.
 * @throws {Error} If the route, sample budget, or profile response is invalid.
 */
export async function fetchRouteElevationSummary(
  coordinates: Coordinate[],
  distanceMeters: number,
  signal: AbortSignal,
  requestedSampleCount = profileSampleCount(distanceMeters),
): Promise<RouteElevationSummary> {
  if (coordinates.length < 2 || distanceMeters <= 0) {
    throw new Error('An elevation profile requires a route line.');
  }

  if (
    !Number.isInteger(requestedSampleCount) ||
    requestedSampleCount < PROFILE_MIN_SAMPLE_POINTS ||
    requestedSampleCount > PROFILE_MAX_SAMPLE_POINTS
  ) {
    throw new Error('Elevation profile sample count is outside safe limits.');
  }

  const profileCoordinates = limitProfileCoordinates(coordinates).map(
    mapCoordinateToLv95,
  );
  const geometry = {
    type: 'LineString',
    coordinates: profileCoordinates.map(([easting, northing]) => [
      Number(easting.toFixed(2)),
      Number(northing.toFixed(2)),
    ]),
  };
  const requestUrl = new URL(ELEVATION_PROFILE_ENDPOINT);
  requestUrl.searchParams.set('sr', '2056');
  requestUrl.searchParams.set(
    'nb_points',
    String(requestedSampleCount),
  );
  requestUrl.searchParams.set('offset', String(PROFILE_SMOOTHING_OFFSET));

  /*
   * GeoAdmin accepts the GeoJSON LineString directly as the POST body. Keeping
   * numeric options in the query avoids wrapping the geometry in a provider-
   * specific payload and mirrors the service's documented parameter contract.
   */
  const response = await fetch(requestUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(geometry),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Elevation profile request failed with ${response.status}.`);
  }

  const payload: unknown = await response.json();

  if (!Array.isArray(payload)) {
    throw new Error('Elevation profile response is not an array.');
  }

  const points = payload
    .map((point): RouteElevationPoint | null => {
      if (!point || typeof point !== 'object') {
        return null;
      }

      const profilePoint = point as ElevationProfilePoint;
      const elevationMeters = readFiniteNumber(profilePoint.alts?.COMB);
      const distanceMeters = readFiniteNumber(profilePoint.dist);

      if (elevationMeters === null || distanceMeters === null) {
        return null;
      }

      return {
        distanceMeters,
        elevationMeters,
      };
    })
    .filter((point): point is RouteElevationPoint => point !== null);

  if (points.length < PROFILE_MIN_SAMPLE_POINTS) {
    throw new Error('Elevation profile contains too few valid samples.');
  }

  let ascentMeters = 0;
  let descentMeters = 0;

  for (let index = 1; index < points.length; index += 1) {
    const difference =
      points[index].elevationMeters - points[index - 1].elevationMeters;

    if (difference > 0) {
      ascentMeters += difference;
    } else {
      descentMeters -= difference;
    }
  }

  return {
    ascentMeters,
    descentMeters,
    points,
  };
}

/** Evaluates the Swiss minutes-per-kilometre polynomial at one slope. */
function hikingMinutesPerKilometre(slopePercent: number): number {
  let minutesPerKilometre = 0;

  for (
    let index = SWISS_HIKING_TIME_COEFFICIENTS.length - 1;
    index >= 0;
    index -= 1
  ) {
    minutesPerKilometre =
      minutesPerKilometre * slopePercent +
      SWISS_HIKING_TIME_COEFFICIENTS[index];
  }

  return minutesPerKilometre;
}

/**
 * Applies the Schweizer Wanderwege hiking-time model section by section.
 *
 * Using each pair of ordered elevation samples preserves the model's important
 * non-linear behaviour: moderate descents can be as fast as level walking,
 * while steep ascents and descents take progressively longer. Repeated profile
 * distances mark gaps between independent GPX segments and are ignored.
 *
 * @param points - Ordered cumulative-distance and elevation profile samples.
 * @returns Estimated walking time in minutes, excluding breaks.
 */
export function estimateHikingDuration(
  points: RouteElevationPoint[],
): number {
  let durationMinutes = 0;

  for (let index = 1; index < points.length; index += 1) {
    const previousPoint = points[index - 1];
    const currentPoint = points[index];
    const horizontalDistanceMeters =
      currentPoint.distanceMeters - previousPoint.distanceMeters;

    if (
      !Number.isFinite(horizontalDistanceMeters) ||
      horizontalDistanceMeters <= 0
    ) {
      continue;
    }

    const elevationDifferenceMeters =
      currentPoint.elevationMeters - previousPoint.elevationMeters;
    const rawSlopePercent =
      (100 * elevationDifferenceMeters) / horizontalDistanceMeters;
    const slopePercent = Math.min(
      SWISS_HIKING_TIME_MAX_SLOPE_PERCENT,
      Math.max(-SWISS_HIKING_TIME_MAX_SLOPE_PERCENT, rawSlopePercent),
    );

    durationMinutes +=
      (horizontalDistanceMeters / 1_000) *
      hikingMinutesPerKilometre(slopePercent);
  }

  return durationMinutes;
}
