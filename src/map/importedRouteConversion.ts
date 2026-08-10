/**
 * Business context: converts one continuous imported GPX geometry into the
 * immutable editable-route domain without asking the routing engine to rebuild
 * any part of the source trace. It creates sparse editing anchors on existing
 * GPX vertices so the route initially remains geometrically identical while
 * later edits can reuse the normal waypoint tools.
 */
import type { Coordinate } from 'ol/coordinate.js';
import {
  getRouteSectionDirectDistanceMeters,
} from '../routing/routeSectionLimit';
import { MAX_NETWORK_SECTION_DIRECT_DISTANCE_METERS } from '../routing/routingConstants';
import type { RouteState, RouteStep } from './routeState';

/** Parameters controlling the density of generated editing anchors. */
export interface ImportedRouteConversionOptions {
  /**
   * Preferred distance in LV95 metres between editing anchors. Short routes
   * may use a smaller adaptive spacing so they still expose useful handles.
   */
  readonly targetSectionLengthMeters: number;
  /**
   * Preferred maximum number of editable sections. Very long traces may exceed
   * this value when shorter sections are required for network-backed editing;
   * the corresponding waypoint count is one greater on an open route.
   */
  readonly preferredMaxSectionCount: number;
}

/** About one kilometre keeps local edits bounded without producing dense handles. */
export const DEFAULT_IMPORTED_ROUTE_SECTION_LENGTH_METERS = 1_000;

/** Short traces aim for at least three sections so they receive useful interior handles. */
const MIN_IMPORTED_ROUTE_SECTION_COUNT = 3;

/**
 * Preferred number of sections before long traces gradually increase spacing.
 * The display independently declutters dense waypoints at broad map scales, so
 * this is an editing-granularity preference rather than a visual hard cap.
 */
export const DEFAULT_IMPORTED_ROUTE_PREFERRED_MAX_SECTION_COUNT = 500;

/**
 * Maximum GPX vertex count admitted to editable state in this first version.
 * Read-only import remains available above this limit. Bounding the editable
 * geometry protects per-frame display rebuilds and pointer hit testing without
 * silently thinning the source trace.
 */
export const MAX_EDITABLE_IMPORTED_VERTEX_COUNT = 20_000;

/**
 * Imported-anchor spacing stays comfortably below the 15 km network-section
 * product limit. The margin lets a user move an anchor substantially before an
 * adjacent section reaches the routing limit. Sparse source vertices can still
 * make the resulting direct distance larger, which is validated after slicing.
 */
const MAX_IMPORTED_ROUTE_TARGET_SECTION_LENGTH_METERS =
  MAX_NETWORK_SECTION_DIRECT_DISTANCE_METERS / 2;

const DEFAULT_OPTIONS: ImportedRouteConversionOptions = {
  targetSectionLengthMeters: DEFAULT_IMPORTED_ROUTE_SECTION_LENGTH_METERS,
  preferredMaxSectionCount: DEFAULT_IMPORTED_ROUTE_PREFERRED_MAX_SECTION_COUNT,
};

/** Failure raised when a GPX is too dense for the bounded editable workflow. */
export class ImportedRouteTooManyVerticesError extends Error {
  /** Number of source vertices supplied by the imported GPX. */
  readonly vertexCount: number;
  /** Product limit applied before the GPX becomes editable. */
  readonly maximumVertexCount: number;

  /**
   * Creates one explicit editable-GPX density failure.
   * @param vertexCount - Number of vertices in the continuous source trace.
   * @param maximumVertexCount - Maximum admitted editable vertex count.
   */
  constructor(
    vertexCount: number,
    maximumVertexCount = MAX_EDITABLE_IMPORTED_VERTEX_COUNT,
  ) {
    super(
      `The imported route contains ${vertexCount} vertices; the editable maximum is ${maximumVertexCount}.`,
    );
    this.name = 'ImportedRouteTooManyVerticesError';
    this.vertexCount = vertexCount;
    this.maximumVertexCount = maximumVertexCount;
  }
}

/**
 * Failure raised when existing GPX vertices are too sparse to form network-
 * editable sections without inventing an intermediate coordinate.
 */
export class ImportedRouteSparseGeometryError extends Error {
  /** Direct distance between the two selected source anchors. */
  readonly distanceMeters: number;
  /** Product network-section limit that the imported geometry exceeds. */
  readonly maximumDistanceMeters: number;

  /**
   * Creates one explicit sparse-geometry failure.
   * @param distanceMeters - Direct distance between imported section anchors.
   * @param maximumDistanceMeters - Maximum network-routed section distance.
   */
  constructor(
    distanceMeters: number,
    maximumDistanceMeters = MAX_NETWORK_SECTION_DIRECT_DISTANCE_METERS,
  ) {
    super(
      `The imported route contains a ${distanceMeters.toFixed(1)} m editable section; the network maximum is ${maximumDistanceMeters} m.`,
    );
    this.name = 'ImportedRouteSparseGeometryError';
    this.distanceMeters = distanceMeters;
    this.maximumDistanceMeters = maximumDistanceMeters;
  }
}

/** Returns planar LV95 distance between two coordinates in metres. */
function coordinateDistance(first: Coordinate, second: Coordinate): number {
  return Math.hypot(first[0] - second[0], first[1] - second[1]);
}

/**
 * Selects source-vertex indexes that become editable waypoints.
 *
 * The target spacing shrinks for short traces to expose interior handles and
 * grows only after the preferred anchor count would otherwise be exceeded. The
 * 7.5 km safety ceiling may deliberately exceed that preferred count on very
 * long traces because editability takes priority over visual density. Anchors
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
  const preferredSectionCount = Math.max(1, options.preferredMaxSectionCount);
  // A fixed 1 km spacing leaves short imported routes with only their endpoints.
  // Shrinking the target below 3 km gives them useful interior editing handles.
  const shortRouteSpacing = totalDistance / MIN_IMPORTED_ROUTE_SECTION_COUNT;
  const preferredSpacing = Math.max(
    Math.min(options.targetSectionLengthMeters, shortRouteSpacing),
    totalDistance / preferredSectionCount,
  );
  const effectiveSpacing = Math.min(
    MAX_IMPORTED_ROUTE_TARGET_SECTION_LENGTH_METERS,
    preferredSpacing,
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
 * Rejects converted sections that cannot be edited with network snapping while
 * preserving the promise that every anchor is an existing GPX vertex.
 * @param steps - Converted route steps whose sections still contain exact GPX slices.
 * @throws {ImportedRouteSparseGeometryError} When one direct anchor distance exceeds 15 km.
 */
function assertImportedSectionsAreNetworkEditable(steps: RouteStep[]): void {
  for (let index = 1; index < steps.length; index += 1) {
    const distanceMeters = getRouteSectionDirectDistanceMeters(
      steps[index - 1].waypoint,
      steps[index].waypoint,
    );

    if (distanceMeters > MAX_NETWORK_SECTION_DIRECT_DISTANCE_METERS) {
      throw new ImportedRouteSparseGeometryError(distanceMeters);
    }
  }
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
 * @throws {ImportedRouteTooManyVerticesError} If the trace is too dense for editable mode.
 * @throws {ImportedRouteSparseGeometryError} If source vertices cannot keep sections within the network-routing limit.
 */
export function createEditableRouteFromImportedGeometry(
  coordinates: Coordinate[],
  overrides: Partial<ImportedRouteConversionOptions> = {},
): RouteState {
  if (coordinates.length < 2) {
    throw new Error('An editable imported route requires at least two coordinates.');
  }

  if (coordinates.length > MAX_EDITABLE_IMPORTED_VERTEX_COUNT) {
    throw new ImportedRouteTooManyVerticesError(coordinates.length);
  }

  const options: ImportedRouteConversionOptions = {
    ...DEFAULT_OPTIONS,
    ...overrides,
  };

  if (
    !Number.isFinite(options.targetSectionLengthMeters) ||
    options.targetSectionLengthMeters <= 0 ||
    !Number.isInteger(options.preferredMaxSectionCount) ||
    options.preferredMaxSectionCount < 1
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

  assertImportedSectionsAreNetworkEditable(steps);

  return {
    steps,
    closure: null,
  };
}
