/**
 * Business context: exports the itinerary currently presented by Via Helvetica
 * as a standalone GPX 1.1 track. Editable sections and independent read-only
 * route segments are simplified within a sub-metre tolerance while preserving
 * endpoints and deliberate gaps. Smoothed elevation samples are embedded when
 * available so compatible applications do not need to rebuild a noisier terrain
 * profile.
 */
import type { Coordinate } from 'ol/coordinate.js';
import { getDistance } from 'ol/sphere.js';
import type { RouteClosure, RouteStep } from '../map/routeState';
import { toWgs84 } from '../map/projection';
import type { RouteElevationPoint } from '../metrics/routeMetrics';

/** Language-neutral fallback used if a route name contains no valid filename characters. */
const GPX_FILENAME_FALLBACK = 'via-helvetica-route';
/** Decimal places for WGS 84 coordinates; seven digits provide sub-metre precision. */
const GPX_COORDINATE_PRECISION = 7;
/** Decimal places for elevation values supplied by the terrain profile service. */
const GPX_ELEVATION_PRECISION = 1;
/** Maximum ground deviation accepted while simplifying one routed section. */
const GPX_GEOMETRY_SIMPLIFICATION_TOLERANCE_METERS = 0.5;
/** Near-identical profile distances are replaced before elevation interpolation. */
const GPX_PROFILE_DISTANCE_DUPLICATE_TOLERANCE_METERS = 0.01;
/**
 * Regular profile samples closer than this to an exported geometry vertex are
 * omitted because that vertex receives the same interpolated elevation.
 */
const GPX_PROFILE_SAMPLE_MERGE_TOLERANCE_METERS = 1;
/** Mean Earth radius used only for a local metre-scale simplification plane. */
const EARTH_RADIUS_METERS = 6_371_008.8;
/** Squared map-unit distance used to avoid exact or sub-decimetre duplicates. */
const GPX_DUPLICATE_COORDINATE_DISTANCE_SQUARED = 0.01;

/**
 * Converts a route name into a portable GPX filename while preserving readable
 * spaces and Unicode characters. Browser save dialogs may still let the user
 * rename the file afterwards, but the initial filename and internal GPX name
 * now originate from the same value.
 *
 * @param routeName - Name entered in the export dialog.
 * @returns Filename ending in `.gpx`.
 */
function createGpxFilename(routeName: string): string {
  const withoutExtension = routeName.trim().replace(/\.gpx$/i, '');
  const sanitizedName = withoutExtension
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/[. ]+$/g, '')
    .trim();

  return `${sanitizedName || GPX_FILENAME_FALLBACK}.gpx`;
}

/** One GPX track point assembled from route geometry and optional terrain elevation. */
interface GpxTrackPoint {
  /** WGS 84 longitude and latitude in that order. */
  coordinate: Coordinate;
  /** Smoothed terrain elevation in metres, or `null` when no profile is available. */
  elevationMeters: number | null;
}

/** Route geometry prepared for distance-based interpolation. */
interface MeasuredRoute {
  /** Retained export coordinates in EPSG:2056. */
  coordinates: Coordinate[];
  /** WGS 84 coordinates used for geodesic segment lengths and GPX output. */
  lonLatCoordinates: Coordinate[];
  /** Cumulative geodesic distance at each retained export vertex, in metres. */
  cumulativeDistances: number[];
  /** Total geodesic route distance in metres. */
  totalDistanceMeters: number;
}

/** Geographic bounds written into GPX metadata for faster initial framing. */
interface GpxBounds {
  minLatitude: number;
  minLongitude: number;
  maxLatitude: number;
  maxLongitude: number;
}

/** One GPX track segment ready for XML serialization. */
interface GpxTrackSegment {
  /** Ordered points belonging to one continuous source line. */
  points: GpxTrackPoint[];
}

/** Simplified export geometry paired with the distance scale used by its profile. */
interface PreparedRouteSegment {
  /** Simplified geometry used for GPX coordinates. */
  route: MeasuredRoute;
  /** Distance of the unsimplified source segment in metres. */
  profileDistanceMeters: number;
}

/**
 * Escapes text inserted into XML nodes.
 * @param value - Untrusted or application-provided text.
 * @returns XML-safe text content.
 */
function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** Returns squared distance in map units without allocating an OpenLayers geometry. */
function coordinateDistanceSquared(
  first: Coordinate,
  second: Coordinate,
): number {
  const deltaX = first[0] - second[0];
  const deltaY = first[1] - second[1];
  return deltaX * deltaX + deltaY * deltaY;
}

/** Appends one coordinate unless it is effectively identical to the previous one. */
function appendExportCoordinate(
  coordinates: Coordinate[],
  coordinate: Coordinate,
): void {
  const previousCoordinate = coordinates[coordinates.length - 1];

  if (
    !previousCoordinate ||
    coordinateDistanceSquared(previousCoordinate, coordinate) >
      GPX_DUPLICATE_COORDINATE_DISTANCE_SQUARED
  ) {
    coordinates.push([coordinate[0], coordinate[1]]);
  }
}

/** Local metric coordinate used only by the geometry simplifier. */
interface LocalMetricCoordinate {
  x: number;
  y: number;
}

/**
 * Converts WGS 84 coordinates to a small local equirectangular plane.
 *
 * Route sections are short compared with the Earth radius, so this provides a
 * stable metre-scale perpendicular distance for GPX simplification. Original
 * LV95 coordinates are retained for interpolation and transformed only at
 * output.
 */
function createLocalMetricCoordinates(
  coordinates: Coordinate[],
): LocalMetricCoordinate[] {
  const lonLatCoordinates = coordinates.map((coordinate) =>
    toWgs84(coordinate),
  );
  const referenceLatitudeRadians =
    (lonLatCoordinates.reduce(
      (total, coordinate) => total + coordinate[1],
      0,
    ) /
      lonLatCoordinates.length) *
    (Math.PI / 180);
  const longitudeScale =
    EARTH_RADIUS_METERS * Math.cos(referenceLatitudeRadians) * (Math.PI / 180);
  const latitudeScale = EARTH_RADIUS_METERS * (Math.PI / 180);

  return lonLatCoordinates.map(([longitude, latitude]) => ({
    x: longitude * longitudeScale,
    y: latitude * latitudeScale,
  }));
}

/** Returns squared distance from one point to a finite segment in a local plane. */
function pointToSegmentDistanceSquared(
  point: LocalMetricCoordinate,
  start: LocalMetricCoordinate,
  end: LocalMetricCoordinate,
): number {
  const segmentX = end.x - start.x;
  const segmentY = end.y - start.y;
  const segmentLengthSquared = segmentX * segmentX + segmentY * segmentY;

  if (segmentLengthSquared === 0) {
    const deltaX = point.x - start.x;
    const deltaY = point.y - start.y;
    return deltaX * deltaX + deltaY * deltaY;
  }

  const projection = Math.max(
    0,
    Math.min(
      1,
      ((point.x - start.x) * segmentX +
        (point.y - start.y) * segmentY) /
        segmentLengthSquared,
    ),
  );
  const closestX = start.x + projection * segmentX;
  const closestY = start.y + projection * segmentY;
  const deltaX = point.x - closestX;
  const deltaY = point.y - closestY;
  return deltaX * deltaX + deltaY * deltaY;
}

/**
 * Simplifies one route section with iterative Ramer-Douglas-Peucker.
 *
 * Section endpoints are always retained. Since each editable route section is
 * bounded by user waypoints, simplifying sections independently also preserves
 * every waypoint and the optional loop-closing junction.
 */
function simplifyRouteSection(coordinates: Coordinate[]): Coordinate[] {
  const deduplicatedCoordinates: Coordinate[] = [];

  for (const coordinate of coordinates) {
    appendExportCoordinate(deduplicatedCoordinates, coordinate);
  }

  if (deduplicatedCoordinates.length <= 2) {
    return deduplicatedCoordinates;
  }

  const localCoordinates = createLocalMetricCoordinates(
    deduplicatedCoordinates,
  );
  const keepCoordinate = new Array<boolean>(
    deduplicatedCoordinates.length,
  ).fill(false);
  const lastIndex = deduplicatedCoordinates.length - 1;
  const pendingRanges: Array<[number, number]> = [[0, lastIndex]];
  const toleranceSquared =
    GPX_GEOMETRY_SIMPLIFICATION_TOLERANCE_METERS ** 2;

  keepCoordinate[0] = true;
  keepCoordinate[lastIndex] = true;

  while (pendingRanges.length > 0) {
    const [startIndex, endIndex] = pendingRanges.pop()!;
    let farthestIndex = -1;
    let farthestDistanceSquared = toleranceSquared;

    for (let index = startIndex + 1; index < endIndex; index += 1) {
      const distanceSquared = pointToSegmentDistanceSquared(
        localCoordinates[index],
        localCoordinates[startIndex],
        localCoordinates[endIndex],
      );

      if (distanceSquared > farthestDistanceSquared) {
        farthestDistanceSquared = distanceSquared;
        farthestIndex = index;
      }
    }

    if (farthestIndex >= 0) {
      keepCoordinate[farthestIndex] = true;
      pendingRanges.push([startIndex, farthestIndex]);
      pendingRanges.push([farthestIndex, endIndex]);
    }
  }

  return deduplicatedCoordinates.filter(
    (_coordinate, index) => keepCoordinate[index],
  );
}

/**
 * Collects export geometry while simplifying each independently routed section.
 * User waypoints remain section endpoints and are therefore never removed.
 */
function collectExportCoordinates(
  steps: RouteStep[],
  closure: RouteClosure | null,
): Coordinate[] {
  const coordinates: Coordinate[] = [];

  for (const step of steps) {
    if (step.segment && step.segment.length >= 2) {
      for (const coordinate of simplifyRouteSection(step.segment)) {
        appendExportCoordinate(coordinates, coordinate);
      }
    } else {
      appendExportCoordinate(coordinates, step.waypoint);
    }
  }

  if (closure?.segment && closure.segment.length >= 2) {
    for (const coordinate of simplifyRouteSection(closure.segment)) {
      appendExportCoordinate(coordinates, coordinate);
    }
  }

  return coordinates;
}

/**
 * Measures the displayed route once so coordinates can be interpolated at the
 * same regular distances used by the elevation profile.
 * @param coordinates - Ordered route vertices in EPSG:2056.
 * @returns Route coordinates and cumulative geodesic distances.
 */
function measureRoute(coordinates: Coordinate[]): MeasuredRoute {
  const lonLatCoordinates = coordinates.map((coordinate) =>
    toWgs84(coordinate),
  );
  const cumulativeDistances = [0];

  for (let index = 1; index < lonLatCoordinates.length; index += 1) {
    const segmentDistance = getDistance(
      lonLatCoordinates[index - 1],
      lonLatCoordinates[index],
    );
    cumulativeDistances.push(
      cumulativeDistances[cumulativeDistances.length - 1] + segmentDistance,
    );
  }

  return {
    coordinates,
    lonLatCoordinates,
    cumulativeDistances,
    totalDistanceMeters:
      cumulativeDistances[cumulativeDistances.length - 1] ?? 0,
  };
}

/**
 * Returns the route coordinate at a cumulative distance.
 *
 * Interpolation remains in the map projection between adjacent original
 * vertices, while cumulative lookup uses geodesic metre distances. The caller
 * processes targets in ascending order and reuses the returned upper index, so
 * the cursor crosses every route segment at most once.
 *
 * @param route - Pre-measured route geometry.
 * @param distanceMeters - Target cumulative distance from the route start.
 * @param upperIndex - First candidate vertex after the previous target.
 * @returns Interpolated WGS 84 coordinate and the reusable upper index.
 */
function coordinateAtDistance(
  route: MeasuredRoute,
  distanceMeters: number,
  upperIndex: number,
): { coordinate: Coordinate; upperIndex: number } {
  if (distanceMeters <= 0) {
    return {
      coordinate: [...route.lonLatCoordinates[0]],
      upperIndex,
    };
  }

  if (distanceMeters >= route.totalDistanceMeters) {
    return {
      coordinate: [
        ...route.lonLatCoordinates[route.lonLatCoordinates.length - 1],
      ],
      upperIndex: route.cumulativeDistances.length - 1,
    };
  }

  let resolvedUpperIndex = Math.max(1, upperIndex);

  while (
    resolvedUpperIndex < route.cumulativeDistances.length - 1 &&
    route.cumulativeDistances[resolvedUpperIndex] < distanceMeters
  ) {
    resolvedUpperIndex += 1;
  }

  const lowerIndex = resolvedUpperIndex - 1;
  const lowerDistance = route.cumulativeDistances[lowerIndex];
  const upperDistance = route.cumulativeDistances[resolvedUpperIndex];
  const segmentDistance = upperDistance - lowerDistance;
  const fraction =
    segmentDistance > 0
      ? (distanceMeters - lowerDistance) / segmentDistance
      : 0;
  const lowerCoordinate = route.coordinates[lowerIndex];
  const upperCoordinate = route.coordinates[resolvedUpperIndex];
  const interpolatedMapCoordinate: Coordinate = [
    lowerCoordinate[0] +
      (upperCoordinate[0] - lowerCoordinate[0]) * fraction,
    lowerCoordinate[1] +
      (upperCoordinate[1] - lowerCoordinate[1]) * fraction,
  ];

  return {
    coordinate: toWgs84(interpolatedMapCoordinate),
    upperIndex: resolvedUpperIndex,
  };
}

/**
 * Normalizes untrusted profile input into strictly increasing finite samples.
 * @param points - Smoothed distance/elevation samples used by the profile chart.
 * @returns Ordered samples with duplicate distances removed.
 */
function normalizeElevationPoints(
  points: RouteElevationPoint[],
): RouteElevationPoint[] {
  const sortedPoints = points
    .filter(
      (point) =>
        Number.isFinite(point.distanceMeters) &&
        Number.isFinite(point.elevationMeters),
    )
    .slice()
    .sort((first, second) => first.distanceMeters - second.distanceMeters);
  const normalizedPoints: RouteElevationPoint[] = [];

  for (const point of sortedPoints) {
    const previousPoint = normalizedPoints[normalizedPoints.length - 1];

    if (
      previousPoint &&
      Math.abs(point.distanceMeters - previousPoint.distanceMeters) <=
        GPX_PROFILE_DISTANCE_DUPLICATE_TOLERANCE_METERS
    ) {
      // The later value replaces a duplicate distance so interpolation never
      // divides by an effectively zero profile section.
      normalizedPoints[normalizedPoints.length - 1] = point;
    } else {
      normalizedPoints.push(point);
    }
  }

  return normalizedPoints;
}

/** Returns finite elevation samples in provider order without collapsing gap boundaries. */
function sortFiniteElevationPoints(
  points: RouteElevationPoint[],
): RouteElevationPoint[] {
  return points
    .filter(
      (point) =>
        Number.isFinite(point.distanceMeters) &&
        Number.isFinite(point.elevationMeters),
    )
    .slice()
    .sort((first, second) => first.distanceMeters - second.distanceMeters);
}

/**
 * Extracts one segment-local profile from a cumulative multi-segment profile.
 *
 * GeoAdmin returns the final sample of one segment and the first sample of the
 * next segment at the same cumulative distance. Keeping the first duplicate for
 * the ending segment and the last duplicate for the starting segment preserves
 * both elevations without inventing a climb across a deliberate geometry gap.
 *
 * @param points - Finite cumulative profile samples in ascending order.
 * @param startDistanceMeters - Cumulative distance at the segment start.
 * @param endDistanceMeters - Cumulative distance at the segment end.
 * @param segmentIndex - Zero-based segment position.
 * @param segmentCount - Number of exported segments.
 * @returns Profile samples shifted to segment-local cumulative distances.
 */
function collectSegmentElevationPoints(
  points: RouteElevationPoint[],
  startDistanceMeters: number,
  endDistanceMeters: number,
  segmentIndex: number,
  segmentCount: number,
): RouteElevationPoint[] {
  const matchingPoints = points.filter(
    (point) =>
      point.distanceMeters >=
        startDistanceMeters - GPX_PROFILE_DISTANCE_DUPLICATE_TOLERANCE_METERS &&
      point.distanceMeters <=
        endDistanceMeters + GPX_PROFILE_DISTANCE_DUPLICATE_TOLERANCE_METERS,
  );

  if (segmentIndex > 0) {
    const startBoundaryIndexes = matchingPoints
      .map((point, index) =>
        Math.abs(point.distanceMeters - startDistanceMeters) <=
        GPX_PROFILE_DISTANCE_DUPLICATE_TOLERANCE_METERS
          ? index
          : -1,
      )
      .filter((index) => index >= 0);

    if (startBoundaryIndexes.length > 1) {
      const lastStartBoundaryIndex =
        startBoundaryIndexes[startBoundaryIndexes.length - 1];
      matchingPoints.splice(0, lastStartBoundaryIndex);
    }
  }

  if (segmentIndex < segmentCount - 1) {
    const firstEndBoundaryIndex = matchingPoints.findIndex(
      (point) =>
        Math.abs(point.distanceMeters - endDistanceMeters) <=
        GPX_PROFILE_DISTANCE_DUPLICATE_TOLERANCE_METERS,
    );

    if (firstEndBoundaryIndex >= 0) {
      matchingPoints.splice(firstEndBoundaryIndex + 1);
    }
  }

  return matchingPoints.map((point) => ({
    distanceMeters: Math.max(
      0,
      Math.min(
        endDistanceMeters - startDistanceMeters,
        point.distanceMeters - startDistanceMeters,
      ),
    ),
    elevationMeters: point.elevationMeters,
  }));
}

/**
 * Interpolates smoothed elevation at one distance along the profile.
 *
 * Profile distances are consumed in ascending order, so the reusable cursor
 * advances monotonically and visits each profile section at most once.
 *
 * @param points - Strictly increasing normalized elevation samples.
 * @param distanceMeters - Distance in the profile service's own distance scale.
 * @param upperIndex - First candidate sample after the previous target.
 * @returns Interpolated elevation and the reusable upper index.
 */
function elevationAtDistance(
  points: RouteElevationPoint[],
  distanceMeters: number,
  upperIndex: number,
): { elevationMeters: number; upperIndex: number } {
  if (distanceMeters <= points[0].distanceMeters) {
    return {
      elevationMeters: points[0].elevationMeters,
      upperIndex,
    };
  }

  const lastPoint = points[points.length - 1];

  if (distanceMeters >= lastPoint.distanceMeters) {
    return {
      elevationMeters: lastPoint.elevationMeters,
      upperIndex: points.length - 1,
    };
  }

  let resolvedUpperIndex = Math.max(1, upperIndex);

  while (
    resolvedUpperIndex < points.length - 1 &&
    points[resolvedUpperIndex].distanceMeters < distanceMeters
  ) {
    resolvedUpperIndex += 1;
  }

  const lowerPoint = points[resolvedUpperIndex - 1];
  const upperPoint = points[resolvedUpperIndex];
  const profileSectionDistance =
    upperPoint.distanceMeters - lowerPoint.distanceMeters;
  const fraction =
    profileSectionDistance > 0
      ? (distanceMeters - lowerPoint.distanceMeters) /
        profileSectionDistance
      : 0;

  return {
    elevationMeters:
      lowerPoint.elevationMeters +
      (upperPoint.elevationMeters - lowerPoint.elevationMeters) * fraction,
    upperIndex: resolvedUpperIndex,
  };
}

/** Merges two sorted distance collections without repeated array insertion. */
function mergeSortedDistances(
  geometryDistances: number[],
  profileDistances: number[],
): number[] {
  const mergedDistances: number[] = [];
  let geometryIndex = 0;
  let profileIndex = 0;

  while (
    geometryIndex < geometryDistances.length ||
    profileIndex < profileDistances.length
  ) {
    const geometryDistance = geometryDistances[geometryIndex];
    const profileDistance = profileDistances[profileIndex];

    if (
      profileDistance === undefined ||
      (geometryDistance !== undefined && geometryDistance <= profileDistance)
    ) {
      mergedDistances.push(geometryDistance);
      geometryIndex += 1;
    } else {
      mergedDistances.push(profileDistance);
      profileIndex += 1;
    }
  }

  return mergedDistances;
}

/**
 * Projects profile samples onto route distance and removes samples already
 * represented by a nearby geometry vertex or accepted profile sample.
 */
function collectAdditionalProfileDistances(
  route: MeasuredRoute,
  points: RouteElevationPoint[],
  firstProfileDistance: number,
  profileDistanceSpan: number,
): number[] {
  const profileRouteDistances: number[] = [];
  let nextGeometryIndex = 0;

  for (const point of points) {
    const routeDistance = Math.min(
      route.totalDistanceMeters,
      Math.max(
        0,
        ((point.distanceMeters - firstProfileDistance) /
          profileDistanceSpan) *
          route.totalDistanceMeters,
      ),
    );

    while (
      nextGeometryIndex < route.cumulativeDistances.length &&
      route.cumulativeDistances[nextGeometryIndex] < routeDistance
    ) {
      nextGeometryIndex += 1;
    }

    const previousGeometryDistance =
      route.cumulativeDistances[nextGeometryIndex - 1];
    const nextGeometryDistance =
      route.cumulativeDistances[nextGeometryIndex];
    const previousProfileDistance =
      profileRouteDistances[profileRouteDistances.length - 1];
    const isNearExistingDistance =
      (previousGeometryDistance !== undefined &&
        Math.abs(routeDistance - previousGeometryDistance) <=
          GPX_PROFILE_SAMPLE_MERGE_TOLERANCE_METERS) ||
      (nextGeometryDistance !== undefined &&
        Math.abs(nextGeometryDistance - routeDistance) <=
          GPX_PROFILE_SAMPLE_MERGE_TOLERANCE_METERS) ||
      (previousProfileDistance !== undefined &&
        Math.abs(routeDistance - previousProfileDistance) <=
          GPX_PROFILE_SAMPLE_MERGE_TOLERANCE_METERS);

    if (!isNearExistingDistance) {
      profileRouteDistances.push(routeDistance);
    }
  }

  return profileRouteDistances;
}

/**
 * Merges simplified route vertices with regular elevation samples.
 *
 * Simplified section vertices preserve visible swissTLM3D bends and every user
 * waypoint. Adding profile distances ensures long straight sections still
 * contain enough GPX points for another application to reproduce the same
 * smooth altitude curve. A profile point very close to an existing geometry
 * vertex is unnecessary because that vertex receives an interpolated altitude.
 *
 * @param route - Pre-measured simplified export geometry.
 * @param elevationPoints - Smoothed profile samples already shown in the UI.
 * @returns GPX points with interpolated WGS 84 coordinates and elevations.
 */
function createElevationAwareTrackPoints(
  route: MeasuredRoute,
  elevationPoints: RouteElevationPoint[],
): GpxTrackPoint[] | null {
  const normalizedElevationPoints = normalizeElevationPoints(elevationPoints);

  if (
    normalizedElevationPoints.length < 2 ||
    route.totalDistanceMeters <= 0
  ) {
    return null;
  }

  const firstProfileDistance =
    normalizedElevationPoints[0].distanceMeters;
  const lastProfileDistance =
    normalizedElevationPoints[normalizedElevationPoints.length - 1]
      .distanceMeters;
  const profileDistanceSpan = lastProfileDistance - firstProfileDistance;

  if (profileDistanceSpan <= 0) {
    return null;
  }

  const additionalProfileDistances = collectAdditionalProfileDistances(
    route,
    normalizedElevationPoints,
    firstProfileDistance,
    profileDistanceSpan,
  );
  const mergedDistances = mergeSortedDistances(
    route.cumulativeDistances,
    additionalProfileDistances,
  );
  const trackPoints: GpxTrackPoint[] = [];
  let routeUpperIndex = 1;
  let profileUpperIndex = 1;

  for (const routeDistance of mergedDistances) {
    const profileDistance =
      firstProfileDistance +
      (routeDistance / route.totalDistanceMeters) * profileDistanceSpan;
    const coordinateResult = coordinateAtDistance(
      route,
      routeDistance,
      routeUpperIndex,
    );
    const elevationResult = elevationAtDistance(
      normalizedElevationPoints,
      profileDistance,
      profileUpperIndex,
    );

    routeUpperIndex = coordinateResult.upperIndex;
    profileUpperIndex = elevationResult.upperIndex;
    trackPoints.push({
      coordinate: coordinateResult.coordinate,
      elevationMeters: elevationResult.elevationMeters,
    });
  }

  return trackPoints;
}

/** Creates geometry-only GPX points when no valid elevation profile is available. */
function createGeometryTrackPoints(route: MeasuredRoute): GpxTrackPoint[] {
  return route.lonLatCoordinates.map((coordinate) => ({
    coordinate: [...coordinate],
    elevationMeters: null,
  }));
}

/** Calculates geographic bounds from the exact points written to the GPX track. */
function calculateTrackBounds(trackPoints: GpxTrackPoint[]): GpxBounds {
  let minLatitude = Number.POSITIVE_INFINITY;
  let minLongitude = Number.POSITIVE_INFINITY;
  let maxLatitude = Number.NEGATIVE_INFINITY;
  let maxLongitude = Number.NEGATIVE_INFINITY;

  for (const point of trackPoints) {
    const [longitude, latitude] = point.coordinate;
    minLatitude = Math.min(minLatitude, latitude);
    minLongitude = Math.min(minLongitude, longitude);
    maxLatitude = Math.max(maxLatitude, latitude);
    maxLongitude = Math.max(maxLongitude, longitude);
  }

  return {
    minLatitude,
    minLongitude,
    maxLatitude,
    maxLongitude,
  };
}

/** Serializes GPX metadata bounds with the same precision as track points. */
function serializeBounds(bounds: GpxBounds): string {
  return (
    `<bounds minlat="${bounds.minLatitude.toFixed(GPX_COORDINATE_PRECISION)}" ` +
    `minlon="${bounds.minLongitude.toFixed(GPX_COORDINATE_PRECISION)}" ` +
    `maxlat="${bounds.maxLatitude.toFixed(GPX_COORDINATE_PRECISION)}" ` +
    `maxlon="${bounds.maxLongitude.toFixed(GPX_COORDINATE_PRECISION)}" />`
  );
}

/** Serializes one GPX track point with optional elevation. */
function serializeTrackPoint(point: GpxTrackPoint): string {
  const [longitude, latitude] = point.coordinate;
  const attributes = `lat="${latitude.toFixed(GPX_COORDINATE_PRECISION)}" lon="${longitude.toFixed(GPX_COORDINATE_PRECISION)}"`;

  if (point.elevationMeters === null) {
    return `      <trkpt ${attributes} />`;
  }

  return `      <trkpt ${attributes}>\n        <ele>${point.elevationMeters.toFixed(GPX_ELEVATION_PRECISION)}</ele>\n      </trkpt>`;
}

/**
 * Serializes one continuous GPX track segment without connecting it to adjacent
 * source lines.
 *
 * @param segment - Ordered points belonging to one continuous geometry.
 * @returns XML for one `<trkseg>` node.
 */
function serializeTrackSegment(segment: GpxTrackSegment): string {
  const serializedTrackPoints = segment.points
    .map(serializeTrackPoint)
    .join('\n');

  return `    <trkseg>\n${serializedTrackPoints}\n    </trkseg>`;
}

/**
 * Builds the shared GPX 1.1 envelope around one or more continuous segments.
 *
 * @param trackSegments - Non-empty continuous geometries to serialize.
 * @param generatedAt - Timestamp written to GPX metadata.
 * @param routeName - Track name written to metadata and track nodes.
 * @returns Complete UTF-8 GPX 1.1 XML document.
 */
function createGpxDocument(
  trackSegments: GpxTrackSegment[],
  generatedAt: Date,
  routeName: string,
): string {
  const trackPoints = trackSegments.flatMap((segment) => segment.points);
  const serializedTrackSegments = trackSegments
    .map(serializeTrackSegment)
    .join('\n');
  const serializedBounds = serializeBounds(calculateTrackBounds(trackPoints));
  const escapedRouteName = escapeXml(routeName);

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Via Helvetica" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${escapedRouteName}</name>
    <time>${generatedAt.toISOString()}</time>
    ${serializedBounds}
  </metadata>
  <trk>
    <name>${escapedRouteName}</name>
${serializedTrackSegments}
  </trk>
</gpx>
`;
}

/**
 * Builds a GPX 1.1 track from a sub-metre simplification of the displayed route.
 * @param steps - Applied route steps in display order.
 * @param generatedAt - Timestamp written to GPX metadata.
 * @param routeName - Localized track name written to metadata and track nodes.
 * @param elevationPoints - Optional smoothed profile samples to embed as `<ele>` values.
 * @param closure - Optional dedicated section returning the last waypoint to the first.
 * @returns Complete UTF-8 XML document.
 * @throws {Error} If the route does not contain at least two coordinates.
 */
export function createRouteGpx(
  steps: RouteStep[],
  generatedAt: Date = new Date(),
  routeName = 'Via Helvetica route',
  elevationPoints: RouteElevationPoint[] = [],
  closure: RouteClosure | null = null,
): string {
  const coordinates = collectExportCoordinates(steps, closure);

  if (coordinates.length < 2) {
    throw new Error('A GPX route requires at least two coordinates.');
  }

  const route = measureRoute(coordinates);

  return createGpxDocument(
    [
      {
        points:
          createElevationAwareTrackPoints(route, elevationPoints) ??
          createGeometryTrackPoints(route),
      },
    ],
    generatedAt,
    routeName,
  );
}

/**
 * Builds a GPX 1.1 track from independent read-only itinerary segments.
 *
 * Each source line becomes its own `<trkseg>`, so gaps in public or imported
 * geometry remain gaps after export. The cumulative elevation profile is split
 * back into segment-local samples before interpolation.
 *
 * @param segments - Independent itinerary lines in EPSG:2056.
 * @param generatedAt - Timestamp written to GPX metadata.
 * @param routeName - Localized track name written to metadata and track nodes.
 * @param elevationPoints - Optional cumulative profile samples to embed as `<ele>` values.
 * @returns Complete UTF-8 XML document.
 * @throws {Error} If no segment contains at least two distinct coordinates.
 */
export function createRouteSegmentsGpx(
  segments: Coordinate[][],
  generatedAt: Date = new Date(),
  routeName = 'Via Helvetica route',
  elevationPoints: RouteElevationPoint[] = [],
): string {
  const preparedSegments = segments
    .map((segment): PreparedRouteSegment | null => {
      const sourceCoordinates: Coordinate[] = [];

      for (const coordinate of segment) {
        appendExportCoordinate(sourceCoordinates, coordinate);
      }

      if (sourceCoordinates.length < 2) {
        return null;
      }

      const sourceRoute = measureRoute(sourceCoordinates);
      const route = measureRoute(simplifyRouteSection(sourceCoordinates));

      if (
        sourceRoute.totalDistanceMeters <= 0 ||
        route.totalDistanceMeters <= 0
      ) {
        return null;
      }

      return {
        route,
        profileDistanceMeters: sourceRoute.totalDistanceMeters,
      };
    })
    .filter((segment): segment is PreparedRouteSegment => segment !== null);

  if (preparedSegments.length === 0) {
    throw new Error('A GPX route requires at least two coordinates.');
  }

  const finiteElevationPoints = sortFiniteElevationPoints(elevationPoints);
  let cumulativeDistanceMeters = 0;
  const trackSegments = preparedSegments.map((segment, segmentIndex) => {
    const segmentStartDistanceMeters = cumulativeDistanceMeters;
    const segmentEndDistanceMeters =
      segmentStartDistanceMeters + segment.profileDistanceMeters;
    const segmentElevationPoints = collectSegmentElevationPoints(
      finiteElevationPoints,
      segmentStartDistanceMeters,
      segmentEndDistanceMeters,
      segmentIndex,
      preparedSegments.length,
    );
    cumulativeDistanceMeters = segmentEndDistanceMeters;

    return {
      points:
        createElevationAwareTrackPoints(segment.route, segmentElevationPoints) ??
        createGeometryTrackPoints(segment.route),
    };
  });

  return createGpxDocument(trackSegments, generatedAt, routeName);
}

/**
 * Starts a browser download for one already-generated GPX document.
 *
 * @param gpxDocument - Complete GPX XML payload.
 * @param routeName - Name used to derive the portable download filename.
 */
export function downloadGpxDocument(
  gpxDocument: string,
  routeName: string,
): void {
  const blob = new Blob([gpxDocument], {
    type: 'application/gpx+xml;charset=utf-8',
  });
  const objectUrl = URL.createObjectURL(blob);
  const link = window.document.createElement('a');

  link.href = objectUrl;
  link.download = createGpxFilename(routeName);
  link.style.display = 'none';
  window.document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}

/**
 * Starts a browser download for the current route as a GPX file.
 *
 * The object URL is revoked on the next task so the click can consume it first
 * without retaining the generated document in memory for the page lifetime.
 *
 * @param steps - Applied route steps in display order.
 * @param routeName - Localized track name written into the GPX document.
 * @param elevationPoints - Optional smoothed profile samples embedded in track points.
 * @param closure - Optional dedicated section returning the last waypoint to the first.
 * @throws {Error} If the route is too short to export.
 */
export function downloadRouteGpx(
  steps: RouteStep[],
  routeName = 'Via Helvetica route',
  elevationPoints: RouteElevationPoint[] = [],
  closure: RouteClosure | null = null,
): void {
  const generatedAt = new Date();
  const gpxDocument = createRouteGpx(
    steps,
    generatedAt,
    routeName,
    elevationPoints,
    closure,
  );
  downloadGpxDocument(gpxDocument, routeName);
}

/**
 * Downloads independent read-only itinerary segments as one named GPX track.
 *
 * @param segments - Independent itinerary lines in EPSG:2056.
 * @param routeName - Localized track name written into the GPX document.
 * @param elevationPoints - Optional cumulative profile samples embedded in track points.
 * @throws {Error} If no segment contains enough geometry to export.
 */
export function downloadRouteSegmentsGpx(
  segments: Coordinate[][],
  routeName = 'Via Helvetica route',
  elevationPoints: RouteElevationPoint[] = [],
): void {
  downloadGpxDocument(
    createRouteSegmentsGpx(segments, new Date(), routeName, elevationPoints),
    routeName,
  );
}
