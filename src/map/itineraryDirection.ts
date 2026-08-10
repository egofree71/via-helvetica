/**
 * Business context: adds sparse direction arrowheads to displayed itineraries
 * without turning them into permanent map clutter. Placement is derived from
 * screen resolution, stays away from visible route controls, and remains purely
 * presentational so route geometry and interaction are unchanged.
 */
import type { Coordinate } from 'ol/coordinate.js';
import type { FeatureLike } from 'ol/Feature.js';
import Point from 'ol/geom/Point.js';
import { Icon, Style } from 'ol/style.js';

/** Approximate screen separation that keeps direction readable without visual noise. */
const DIRECTION_ARROW_SPACING_PX = 150;
/** Route must occupy this many screen pixels before an arrow adds useful information. */
const MINIMUM_VISIBLE_ROUTE_LENGTH_PX = 105;
/**
 * Direction remains available on regional views, but is hidden once the map is
 * so broad that local bends collapse and a tangent could become misleading.
 */
const MAX_DIRECTION_ARROW_RESOLUTION = 40;
/** Keeps arrows clear of route endpoints and disconnected GPX segment ends. */
const LINE_END_MARGIN_PX = 38;
/**
 * Keeps arrows clear of visible waypoint handles and A/B badges while leaving
 * enough usable route between kilometre-scale anchors for direction symbols.
 */
const AVOID_COORDINATE_MARGIN_PX = 24;
/** Defensive cap for unusually long routes or very wide displays. */
const MAX_DIRECTION_ARROWS_PER_LINE = 16;
/**
 * Minimum centre-to-centre separation between direction symbols. This keeps
 * opposite arrows on an out-and-back section from touching or forming one
 * ambiguous combined shape.
 */
const DIRECTION_ARROW_COLLISION_DISTANCE_PX = 30;
/**
 * Screen-space phase shift tried when a candidate collides with an earlier
 * symbol. Moving along the route preserves the true direction while
 * desynchronizing repeated passes over the same geometry.
 */
const DIRECTION_ARROW_PHASE_SHIFT_PX = 42;
/** Number of alternating forward/backward phase shifts attempted per symbol. */
const DIRECTION_ARROW_PHASE_SHIFT_ATTEMPTS = 2;
/**
 * Hollow arrowhead dimensions in CSS pixels. The symbol is deliberately
 * larger than the first compact version, but remains much smaller than the
 * earlier full arrows that overwhelmed the route at broad scales.
 */
const DIRECTION_ARROW_WIDTH_PX = 24;
const DIRECTION_ARROW_HEIGHT_PX = 16;
/**
 * Curvature is inspected across this many visible pixels on either side of a
 * candidate. The wider window catches bends that collapse into one apparent
 * corner at broad map scales.
 */
const DIRECTION_CURVATURE_HALF_WINDOW_PX = 18;
/**
 * The final orientation uses a shorter tangent so the symbol follows the line
 * directly underneath it instead of pointing across the inside of a bend.
 */
const DIRECTION_LOCAL_TANGENT_HALF_WINDOW_PX = 5;
/** Tight folds whose visible chord is still tiny are skipped instead of guessing. */
const MINIMUM_VISIBLE_TANGENT_CHORD_PX = 7;
/** A local tangent shorter than this is too unstable to orient reliably. */
const MINIMUM_LOCAL_TANGENT_CHORD_PX = 3;
/**
 * Maximum change in travel direction across the visible inspection window.
 * Fifty degrees is equivalent to a 130-degree minimum interior angle while
 * still accepting ordinary rounded trail bends.
 */
const MAXIMUM_VISIBLE_TURN_RADIANS = (50 * Math.PI) / 180;
/**
 * Rejects a candidate when its local tangent disagrees strongly with the
 * direction suggested by the surrounding visible route.
 */
const MAXIMUM_LOCAL_TANGENT_DELTA_RADIANS = (32 * Math.PI) / 180;
/** Resolution changes below this relative threshold reuse the prior render cache. */
const RESOLUTION_CACHE_EPSILON = 1e-9;

/** Reuses the two route-colour SVGs across display rebuilds. */
const arrowDataUrls = new Map<string, string>();

/** Inputs required to append sparse direction symbols to one displayed line. */
export interface DirectionalLineStyleOptions {
  /** Existing casing and centre-line styles returned before arrow styles. */
  lineStyles: Style[];
  /** Ordered coordinates in displayed travel direction. */
  coordinates: Coordinate[];
  /** Route colour used for the arrowhead outline. */
  color: string;
  /**
   * Visible points that arrows must not cover. A resolver lets route waypoint
   * decluttering and arrow avoidance react to the same map resolution.
   */
  avoidCoordinates?: Coordinate[] | ((resolution: number) => Coordinate[]);
}

/** Accepted symbol position and final rotation in map-rendering radians. */
interface DirectionSample {
  /** Coordinate on the displayed itinerary where the symbol is anchored. */
  coordinate: Coordinate;
  /** Clockwise icon rotation following the accepted local route tangent. */
  rotation: number;
}

/** Coordinate sampled at a cumulative line distance with its local tangent. */
interface CoordinateSample {
  /** Interpolated coordinate on the itinerary. */
  coordinate: Coordinate;
  /** Direction of travel on the source segment containing the sample. */
  localRotation: number;
}

/** Precomputed planar distances used by every screen-resolution sample. */
interface DirectionLineIndex {
  /** Immutable coordinates captured by the display rebuild. */
  coordinates: Coordinate[];
  /** Distance from the line start to every coordinate. */
  cumulativeDistances: number[];
  /** Coordinate indexes ending non-degenerate segments. */
  segmentEndIndexes: number[];
  /** Complete planar length in native LV95 metres. */
  totalLength: number;
}

/** Returns planar LV95 distance between two route coordinates. */
function coordinateDistance(first: Coordinate, second: Coordinate): number {
  return Math.hypot(second[0] - first[0], second[1] - first[1]);
}

/** Returns the smallest absolute difference between two angles. */
function angleDifference(first: number, second: number): number {
  let difference = Math.abs(first - second) % (Math.PI * 2);

  if (difference > Math.PI) {
    difference = Math.PI * 2 - difference;
  }

  return difference;
}

/** Returns the travel angle from one map coordinate to another. */
function coordinateAngle(first: Coordinate, second: Coordinate): number {
  return Math.atan2(second[1] - first[1], second[0] - first[0]);
}

/**
 * Creates a right-facing hollow triangular arrowhead centred on the route.
 * A white interior interrupts the coloured line just enough to remain legible,
 * while the route-coloured outline keeps the symbol visually attached to it.
 */
function createArrowDataUrl(color: string): string {
  const cachedDataUrl = arrowDataUrls.get(color);

  if (cachedDataUrl) {
    return cachedDataUrl;
  }

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${DIRECTION_ARROW_WIDTH_PX}" height="${DIRECTION_ARROW_HEIGHT_PX}" viewBox="0 0 24 16">
      <path d="M3 1.8 L21 8 L3 14.2 Z"
        fill="rgba(255,255,255,0.98)" stroke="${color}" stroke-width="2.3"
        stroke-linejoin="round"/>
    </svg>
  `;
  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

  arrowDataUrls.set(color, dataUrl);
  return dataUrl;
}

/** Builds the cumulative-distance index once for one immutable displayed line. */
function createDirectionLineIndex(
  coordinates: Coordinate[],
): DirectionLineIndex {
  const cumulativeDistances = [0];
  const segmentEndIndexes: number[] = [];

  for (let index = 1; index < coordinates.length; index += 1) {
    const segmentLength = coordinateDistance(
      coordinates[index - 1],
      coordinates[index],
    );
    const totalLength = cumulativeDistances[index - 1] + segmentLength;

    cumulativeDistances.push(totalLength);
    if (segmentLength > 0) {
      segmentEndIndexes.push(index);
    }
  }

  return {
    coordinates,
    cumulativeDistances,
    segmentEndIndexes,
    totalLength: cumulativeDistances.at(-1) ?? 0,
  };
}

/** Finds the first non-degenerate segment whose end reaches the target distance. */
function findSegmentEndIndex(
  lineIndex: DirectionLineIndex,
  distance: number,
): number | null {
  let lower = 0;
  let upper = lineIndex.segmentEndIndexes.length - 1;
  let match: number | null = null;

  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    const segmentEndIndex = lineIndex.segmentEndIndexes[middle];

    if (lineIndex.cumulativeDistances[segmentEndIndex] >= distance) {
      match = segmentEndIndex;
      upper = middle - 1;
    } else {
      lower = middle + 1;
    }
  }

  return match;
}

/** Samples one coordinate from cumulative distance along an indexed line. */
function sampleCoordinateAtDistance(
  lineIndex: DirectionLineIndex,
  distance: number,
): CoordinateSample | null {
  if (lineIndex.segmentEndIndexes.length === 0) {
    return null;
  }

  const boundedDistance = Math.max(
    0,
    Math.min(lineIndex.totalLength, distance),
  );
  const segmentEndIndex = findSegmentEndIndex(lineIndex, boundedDistance);

  if (segmentEndIndex === null) {
    return null;
  }

  const start = lineIndex.coordinates[segmentEndIndex - 1];
  const end = lineIndex.coordinates[segmentEndIndex];
  const startDistance = lineIndex.cumulativeDistances[segmentEndIndex - 1];
  const segmentLength =
    lineIndex.cumulativeDistances[segmentEndIndex] - startDistance;
  const ratio = Math.max(
    0,
    Math.min(1, (boundedDistance - startDistance) / segmentLength),
  );

  return {
    coordinate: [
      start[0] + (end[0] - start[0]) * ratio,
      start[1] + (end[1] - start[1]) * ratio,
    ],
    localRotation: -Math.atan2(end[1] - start[1], end[0] - start[0]),
  };
}

/**
 * Samples a marker coordinate after checking the visible route curvature.
 *
 * A wide screen-space window decides whether the candidate sits in a bend that
 * would make any direction symbol misleading. The accepted symbol is then
 * oriented from a shorter local tangent, keeping it visually parallel to the
 * route directly underneath instead of pointing across the inside of a curve.
 */
function sampleDirectionAtDistance(
  lineIndex: DirectionLineIndex,
  distance: number,
  resolution: number,
): DirectionSample | null {
  const centre = sampleCoordinateAtDistance(lineIndex, distance);

  if (!centre) {
    return null;
  }

  const curvatureHalfWindow = DIRECTION_CURVATURE_HALF_WINDOW_PX * resolution;
  const before = sampleCoordinateAtDistance(
    lineIndex,
    Math.max(0, distance - curvatureHalfWindow),
  );
  const after = sampleCoordinateAtDistance(
    lineIndex,
    Math.min(lineIndex.totalLength, distance + curvatureHalfWindow),
  );

  if (!before || !after) {
    return {
      coordinate: centre.coordinate,
      rotation: centre.localRotation,
    };
  }

  const visibleChordLength = coordinateDistance(
    before.coordinate,
    after.coordinate,
  );

  if (visibleChordLength / resolution < MINIMUM_VISIBLE_TANGENT_CHORD_PX) {
    return null;
  }

  const incomingAngle = coordinateAngle(before.coordinate, centre.coordinate);
  const outgoingAngle = coordinateAngle(centre.coordinate, after.coordinate);

  if (
    angleDifference(incomingAngle, outgoingAngle) >
    MAXIMUM_VISIBLE_TURN_RADIANS
  ) {
    return null;
  }

  const localHalfWindow = DIRECTION_LOCAL_TANGENT_HALF_WINDOW_PX * resolution;
  const localBefore = sampleCoordinateAtDistance(
    lineIndex,
    Math.max(0, distance - localHalfWindow),
  );
  const localAfter = sampleCoordinateAtDistance(
    lineIndex,
    Math.min(lineIndex.totalLength, distance + localHalfWindow),
  );

  if (!localBefore || !localAfter) {
    return null;
  }

  const localChordLength = coordinateDistance(
    localBefore.coordinate,
    localAfter.coordinate,
  );

  if (localChordLength / resolution < MINIMUM_LOCAL_TANGENT_CHORD_PX) {
    return null;
  }

  const visibleAngle = coordinateAngle(before.coordinate, after.coordinate);
  const localAngle = coordinateAngle(
    localBefore.coordinate,
    localAfter.coordinate,
  );

  if (
    angleDifference(visibleAngle, localAngle) >
    MAXIMUM_LOCAL_TANGENT_DELTA_RADIANS
  ) {
    return null;
  }

  return {
    coordinate: centre.coordinate,
    rotation: -localAngle,
  };
}

/** Returns whether one candidate would visually collide with a protected point. */
function isNearAvoidCoordinate(
  coordinate: Coordinate,
  avoidCoordinates: Coordinate[],
  minimumDistance: number,
): boolean {
  const minimumDistanceSquared = minimumDistance * minimumDistance;

  return avoidCoordinates.some((avoidCoordinate) => {
    const deltaX = coordinate[0] - avoidCoordinate[0];
    const deltaY = coordinate[1] - avoidCoordinate[1];
    return deltaX * deltaX + deltaY * deltaY < minimumDistanceSquared;
  });
}

/** Returns whether a candidate direction symbol overlaps one already retained. */
function collidesWithDirectionSample(
  candidate: DirectionSample,
  samples: DirectionSample[],
  minimumDistance: number,
): boolean {
  const minimumDistanceSquared = minimumDistance * minimumDistance;

  return samples.some((sample) => {
    const deltaX = candidate.coordinate[0] - sample.coordinate[0];
    const deltaY = candidate.coordinate[1] - sample.coordinate[1];
    return deltaX * deltaX + deltaY * deltaY < minimumDistanceSquared;
  });
}

/**
 * Returns the base distance followed by alternating phase-shifted distances.
 * Repeated passes usually collide at the same screen ratio; trying later and
 * earlier positions keeps both directions readable without moving the route.
 */
function createCandidateDistances(
  baseDistance: number,
  minimumDistance: number,
  maximumDistance: number,
  resolution: number,
): number[] {
  const distances = [baseDistance];
  const phaseShift = DIRECTION_ARROW_PHASE_SHIFT_PX * resolution;

  for (
    let attempt = 1;
    attempt <= DIRECTION_ARROW_PHASE_SHIFT_ATTEMPTS;
    attempt += 1
  ) {
    const forward = baseDistance + phaseShift * attempt;
    const backward = baseDistance - phaseShift * attempt;

    if (forward <= maximumDistance) {
      distances.push(forward);
    }
    if (backward >= minimumDistance) {
      distances.push(backward);
    }
  }

  return distances;
}

/** Builds sparse arrow samples for one resolution without altering the line. */
function createDirectionSamples(
  lineIndex: DirectionLineIndex,
  avoidCoordinates: Coordinate[],
  resolution: number,
): DirectionSample[] {
  if (
    lineIndex.coordinates.length < 2 ||
    !Number.isFinite(resolution) ||
    resolution <= 0 ||
    resolution > MAX_DIRECTION_ARROW_RESOLUTION
  ) {
    return [];
  }

  const visibleLengthPx = lineIndex.totalLength / resolution;

  if (visibleLengthPx < MINIMUM_VISIBLE_ROUTE_LENGTH_PX) {
    return [];
  }

  const endMargin = LINE_END_MARGIN_PX * resolution;
  const usableLength = lineIndex.totalLength - endMargin * 2;

  if (usableLength <= 0) {
    return [];
  }

  const naturalArrowCount = Math.max(
    1,
    Math.floor(usableLength / (DIRECTION_ARROW_SPACING_PX * resolution)),
  );
  const arrowCount = Math.min(
    MAX_DIRECTION_ARROWS_PER_LINE,
    naturalArrowCount,
  );
  const evenSpacing = usableLength / (arrowCount + 1);
  const avoidMargin = AVOID_COORDINATE_MARGIN_PX * resolution;
  const collisionDistance = DIRECTION_ARROW_COLLISION_DISTANCE_PX * resolution;
  const samples: DirectionSample[] = [];
  const minimumSampleDistance = endMargin;
  const maximumSampleDistance = lineIndex.totalLength - endMargin;

  for (let index = 1; index <= arrowCount; index += 1) {
    const baseDistance = endMargin + evenSpacing * index;
    const candidateDistances = createCandidateDistances(
      baseDistance,
      minimumSampleDistance,
      maximumSampleDistance,
      resolution,
    );

    for (const candidateDistance of candidateDistances) {
      const sample = sampleDirectionAtDistance(
        lineIndex,
        candidateDistance,
        resolution,
      );

      if (
        !sample ||
        isNearAvoidCoordinate(sample.coordinate, avoidCoordinates, avoidMargin) ||
        collidesWithDirectionSample(sample, samples, collisionDistance)
      ) {
        continue;
      }

      samples.push(sample);
      break;
    }
  }

  return samples;
}

/**
 * Creates a resolution-aware line style with sparse direction arrows.
 *
 * The closure captures immutable geometry from one display rebuild. A small
 * per-resolution cache avoids recreating icons on every render frame while a
 * zoom change still recalculates screen-based spacing immediately.
 */
export function createDirectionalLineStyle({
  lineStyles,
  coordinates,
  color,
  avoidCoordinates = [],
}: DirectionalLineStyleOptions): (
  feature: FeatureLike,
  resolution: number,
) => Style[] {
  const arrowDataUrl = createArrowDataUrl(color);
  const lineIndex = createDirectionLineIndex(coordinates);
  let cachedResolution = Number.NaN;
  let cachedStyles = lineStyles;

  return (_feature: FeatureLike, resolution: number): Style[] => {
    if (
      Number.isFinite(cachedResolution) &&
      Math.abs(cachedResolution - resolution) <=
        Math.max(1, Math.abs(resolution)) * RESOLUTION_CACHE_EPSILON
    ) {
      return cachedStyles;
    }

    const arrowStyles = createDirectionSamples(
      lineIndex,
      typeof avoidCoordinates === 'function'
        ? avoidCoordinates(resolution)
        : avoidCoordinates,
      resolution,
    ).map(
      ({ coordinate, rotation }) =>
        new Style({
          geometry: new Point(coordinate),
          image: new Icon({
            src: arrowDataUrl,
            width: DIRECTION_ARROW_WIDTH_PX,
            height: DIRECTION_ARROW_HEIGHT_PX,
            rotation,
            rotateWithView: true,
          }),
          zIndex: 4,
        }),
    );

    cachedResolution = resolution;
    cachedStyles = [...lineStyles, ...arrowStyles];
    return cachedStyles;
  };
}
