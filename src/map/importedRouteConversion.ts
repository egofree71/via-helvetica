/**
 * Business context: converts one continuous imported GPX geometry into the
 * immutable editable-route domain without asking the routing engine to rebuild
 * any part of the source trace. It creates sparse editing anchors on existing
 * GPX vertices so the route initially remains geometrically identical while
 * later edits can reuse the normal waypoint tools.
 */
import type { Coordinate } from 'ol/coordinate.js';
import type { RouteState, RouteStep } from './routeState';

/** Parameters controlling the density of generated editing anchors. */
export interface ImportedRouteConversionOptions {
  /**
   * Preferred maximum distance in LV95 metres between editing anchors. Short
   * routes may use a smaller adaptive spacing so they still expose useful handles.
   */
  readonly targetSectionLengthMeters: number;
  /**
   * Maximum number of anchors including start and finish. This prevents very
   * long GPX files from flooding the map with editing handles.
   */
  readonly maxAnchorCount: number;
}

/** About one kilometre keeps local edits bounded without producing dense handles. */
export const DEFAULT_IMPORTED_ROUTE_SECTION_LENGTH_METERS = 1_000;

/** Short traces aim for at least three sections so they receive useful interior handles. */
const MIN_IMPORTED_ROUTE_SECTION_COUNT = 3;

/** Maximum number of visible editable anchors created from one imported trace. */
export const DEFAULT_IMPORTED_ROUTE_MAX_ANCHOR_COUNT = 60;

const DEFAULT_OPTIONS: ImportedRouteConversionOptions = {
  targetSectionLengthMeters: DEFAULT_IMPORTED_ROUTE_SECTION_LENGTH_METERS,
  maxAnchorCount: DEFAULT_IMPORTED_ROUTE_MAX_ANCHOR_COUNT,
};

/** Returns planar LV95 distance between two coordinates in metres. */
function coordinateDistance(first: Coordinate, second: Coordinate): number {
  return Math.hypot(first[0] - second[0], first[1] - second[1]);
}

/**
 * Selects source-vertex indexes that become editable waypoints.
 *
 * The target spacing shrinks for short traces to expose interior handles and
 * may grow for very long traces so the anchor-count cap is respected. Anchors
 * are never interpolated: every selected index already exists in the imported
 * geometry, which keeps conversion lossless.
 */
function selectAnchorIndexes(
  coordinates: Coordinate[],
  options: ImportedRouteConversionOptions,
): number[] {
  const cumulativeDistances = new Array<number>(coordinates.length).fill(0);

  for (let index = 1; index < coordinates.length; index += 1) {
    cumulativeDistances[index] =
      cumulativeDistances[index - 1] +
      coordinateDistance(coordinates[index - 1], coordinates[index]);
  }

  const totalDistance = cumulativeDistances[cumulativeDistances.length - 1];
  const availableSectionCount = Math.max(1, options.maxAnchorCount - 1);
  // A fixed 1 km spacing leaves short imported routes with only their endpoints.
  // Shrinking the target below 3 km gives them useful interior editing handles,
  // while the anchor-count cap still takes precedence for very long traces.
  const shortRouteSpacing = totalDistance / MIN_IMPORTED_ROUTE_SECTION_COUNT;
  const effectiveSpacing = Math.max(
    Math.min(options.targetSectionLengthMeters, shortRouteSpacing),
    totalDistance / availableSectionCount,
  );
  const anchorIndexes = [0];
  let nextTargetDistance = effectiveSpacing;

  for (let index = 1; index < coordinates.length - 1; index += 1) {
    if (cumulativeDistances[index] < nextTargetDistance) {
      continue;
    }

    anchorIndexes.push(index);
    nextTargetDistance = cumulativeDistances[index] + effectiveSpacing;
  }

  const lastIndex = coordinates.length - 1;

  if (anchorIndexes[anchorIndexes.length - 1] !== lastIndex) {
    anchorIndexes.push(lastIndex);
  }

  return anchorIndexes;
}

/**
 * Converts one continuous projected GPX trace to editable route state.
 *
 * Every section is a copied slice of the source geometry and every generated
 * waypoint is one source vertex. No snapping, simplification, or routing occurs
 * during conversion.
 *
 * @param coordinates - Continuous GPX geometry in EPSG:2056 with at least two points.
 * @param overrides - Optional anchor-density overrides for tests or future tuning.
 * @returns Editable route state whose sections are all marked as imported.
 * @throws {Error} If fewer than two coordinates are supplied or options are invalid.
 */
export function createEditableRouteFromImportedGeometry(
  coordinates: Coordinate[],
  overrides: Partial<ImportedRouteConversionOptions> = {},
): RouteState {
  if (coordinates.length < 2) {
    throw new Error('An editable imported route requires at least two coordinates.');
  }

  const options: ImportedRouteConversionOptions = {
    ...DEFAULT_OPTIONS,
    ...overrides,
  };

  if (
    !Number.isFinite(options.targetSectionLengthMeters) ||
    options.targetSectionLengthMeters <= 0 ||
    !Number.isInteger(options.maxAnchorCount) ||
    options.maxAnchorCount < 2
  ) {
    throw new Error('Invalid editable imported-route conversion options.');
  }

  const anchorIndexes = selectAnchorIndexes(coordinates, options);
  const steps: RouteStep[] = [
    {
      waypoint: [...coordinates[anchorIndexes[0]]],
      section: null,
    },
  ];

  for (let anchorIndex = 1; anchorIndex < anchorIndexes.length; anchorIndex += 1) {
    const startIndex = anchorIndexes[anchorIndex - 1];
    const endIndex = anchorIndexes[anchorIndex];
    const sectionCoordinates = coordinates
      .slice(startIndex, endIndex + 1)
      .map((coordinate): Coordinate => [...coordinate]);

    steps.push({
      waypoint: [...coordinates[endIndex]],
      section: {
        origin: 'imported',
        coordinates: sectionCoordinates,
      },
    });
  }

  return {
    steps,
    closure: null,
  };
}
