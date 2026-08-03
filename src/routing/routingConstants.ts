/**
 * Business context: centralizes routing values shared by the main-thread client,
 * the routing worker, and pure graph helpers. Keeping these values outside one
 * provider implementation prevents static, live, and binary routing modes from
 * drifting silently.
 */
import type { Coordinate } from 'ol/coordinate.js';

/**
 * Maximum user-to-network snapping distance in metres. Larger values may
 * attach a waypoint to an unrelated road.
 */
export const MAX_SNAP_DISTANCE = 260;

/**
 * Spatial-index bucket width in metres. Larger buckets reduce index overhead
 * but increase exact candidate checks during snapping.
 */
export const ROUTING_SPATIAL_GRID_SIZE_METRES = 250;

/**
 * Squared horizontal distance below which adjacent route coordinates are
 * treated as duplicates during reconstruction.
 */
export const DUPLICATE_COORDINATE_DISTANCE_SQUARED = 0.01;

/**
 * Distance tolerance in metres used only to break near-equal snapping choices.
 * One centimetre matches the binary XY quantum and avoids corridor-order noise.
 */
export const SNAP_DISTANCE_TIE_TOLERANCE_METRES = 0.01;

/**
 * Maximum direct distance in metres between consecutive waypoints when network
 * routing is enabled. Above 15 km a single section no longer describes the
 * hiker's intended corridor reliably; lowering the value requires more
 * waypoints, while raising it permits more ambiguous and expensive searches.
 */
export const MAX_NETWORK_SECTION_DIRECT_DISTANCE_METERS = 15_000;

/** Quantizes one coordinate for deterministic snap tie-breaking. */
function snapCoordinateIdentity(coordinate: Coordinate): readonly number[] {
  return [
    Math.round(coordinate[0] * 100),
    Math.round(coordinate[1] * 100),
    Number.isFinite(coordinate[2])
      ? Math.round((coordinate[2] as number) * 10)
      : Number.MIN_SAFE_INTEGER,
  ];
}

/** Lexicographically compares two quantized coordinates. */
function compareCoordinateIdentity(
  first: readonly number[],
  second: readonly number[],
): number {
  for (let index = 0; index < first.length; index += 1) {
    const difference = first[index] - second[index];
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

/** Returns a canonical endpoint order independent of segment direction. */
function canonicalSegmentIdentity(
  start: Coordinate,
  end: Coordinate,
): readonly [readonly number[], readonly number[]] {
  const first = snapCoordinateIdentity(start);
  const second = snapCoordinateIdentity(end);
  return compareCoordinateIdentity(first, second) <= 0
    ? [first, second]
    : [second, first];
}

/**
 * Decides whether a snap candidate replaces the current best result.
 * Candidates more than one centimetre apart use pure distance. Near-equal
 * candidates use quantized endpoint geometry so cell order cannot change the
 * selected segment between corridor widths or provider representations.
 */
export function shouldReplaceSnapCandidate(
  candidateDistanceSquared: number,
  candidateStart: Coordinate,
  candidateEnd: Coordinate,
  currentDistanceSquared: number,
  currentStart: Coordinate | null,
  currentEnd: Coordinate | null,
): boolean {
  if (!currentStart || !currentEnd || !Number.isFinite(currentDistanceSquared)) {
    return true;
  }

  const candidateDistance = Math.sqrt(candidateDistanceSquared);
  const currentDistance = Math.sqrt(currentDistanceSquared);
  const distanceDifference = candidateDistance - currentDistance;

  if (distanceDifference < -SNAP_DISTANCE_TIE_TOLERANCE_METRES) {
    return true;
  }
  if (distanceDifference > SNAP_DISTANCE_TIE_TOLERANCE_METRES) {
    return false;
  }

  const candidateIdentity = canonicalSegmentIdentity(
    candidateStart,
    candidateEnd,
  );
  const currentIdentity = canonicalSegmentIdentity(currentStart, currentEnd);
  const firstDifference = compareCoordinateIdentity(
    candidateIdentity[0],
    currentIdentity[0],
  );

  return firstDifference !== 0
    ? firstDifference < 0
    : compareCoordinateIdentity(candidateIdentity[1], currentIdentity[1]) < 0;
}
