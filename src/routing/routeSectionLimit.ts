/**
 * Business context: enforces the product-level distance limit for one
 * network-routed section before the browser asks the swissTLM3D Worker to load
 * a corridor. Long point-to-point jumps do not express a hiker's intended
 * valley, pass, or side of a mountain clearly enough, so the user must add an
 * intermediate waypoint instead of making the router guess a whole region.
 */
import type { Coordinate } from 'ol/coordinate.js';
import { coordinateDistanceSquared } from '../map/routeState';
import { MAX_NETWORK_SECTION_DIRECT_DISTANCE_METERS } from './routingConstants';

/**
 * Failure raised before Worker activity when one intended network section is
 * too long to represent a sufficiently precise route-planning instruction.
 */
export class RouteSectionTooLongError extends Error {
  /** Direct horizontal distance between the two intended LV95 endpoints. */
  readonly distanceMeters: number;
  /** Product limit applied to one network-routed section. */
  readonly maximumDistanceMeters: number;

  /**
   * Creates an actionable route-section failure.
   * @param distanceMeters - Direct endpoint distance in LV95 metres.
   * @param maximumDistanceMeters - Maximum accepted direct distance in metres.
   */
  constructor(
    distanceMeters: number,
    maximumDistanceMeters = MAX_NETWORK_SECTION_DIRECT_DISTANCE_METERS,
  ) {
    super(
      `The network-routed section is ${distanceMeters.toFixed(1)} m long; ` +
        `the maximum is ${maximumDistanceMeters} m.`,
    );
    this.name = 'RouteSectionTooLongError';
    this.distanceMeters = distanceMeters;
    this.maximumDistanceMeters = maximumDistanceMeters;
  }
}

/**
 * Calculates direct horizontal distance between two LV95 route endpoints.
 * @param startCoordinate - Intended section start in EPSG:2056.
 * @param endCoordinate - Intended section end in EPSG:2056.
 * @returns Euclidean direct distance in metres.
 */
export function getRouteSectionDirectDistanceMeters(
  startCoordinate: Coordinate,
  endCoordinate: Coordinate,
): number {
  return Math.sqrt(
    coordinateDistanceSquared(startCoordinate, endCoordinate),
  );
}

/**
 * Rejects an ambiguous long network section before any Worker request.
 * Straight-mode sections deliberately bypass this product rule because they do
 * not load swissTLM3D data and explicitly represent the user's own geometry.
 *
 * @param startCoordinate - Intended network section start in EPSG:2056.
 * @param endCoordinate - Intended network section end in EPSG:2056.
 * @throws {RouteSectionTooLongError} When the direct distance exceeds the
 * configured product limit.
 */
export function assertNetworkRouteSectionDistance(
  startCoordinate: Coordinate,
  endCoordinate: Coordinate,
): void {
  const distanceMeters = getRouteSectionDirectDistanceMeters(
    startCoordinate,
    endCoordinate,
  );

  if (distanceMeters > MAX_NETWORK_SECTION_DIRECT_DISTANCE_METERS) {
    throw new RouteSectionTooLongError(distanceMeters);
  }
}
