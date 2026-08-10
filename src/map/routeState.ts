/**
 * Business context: defines the immutable editable-route domain independently
 * from React and OpenLayers rendering. The stored geometry is the source of
 * truth for undo, redo, reversal, GPX export, metrics, and route display, so
 * every transformation returns new coordinate arrays instead of sharing
 * mutable OpenLayers data. Imported GPX sections may enter this domain without
 * rerouting; their provenance remains attached to the section until an edit
 * explicitly replaces that geometry.
 */
import type { Coordinate } from 'ol/coordinate.js';

/** Geometry source used when Via Helvetica calculates one route section. */
export type RouteMode =
  /** Direct line between waypoints. */
  | 'straight'
  /** Geometry calculated on the swissTLM3D routing network. */
  | 'network';

/** Immutable geometry between two editable waypoints. */
export type RouteSection =
  | {
      /** Via Helvetica generated this section through straight or network routing. */
      readonly origin: 'generated';
      /** Calculation mode that produced the stored geometry. */
      readonly mode: RouteMode;
      /** Exact displayed section geometry in LV95 coordinates. */
      readonly coordinates: Coordinate[];
    }
  | {
      /** The section is an untouched slice of an imported GPX geometry. */
      readonly origin: 'imported';
      /** Exact imported section geometry in LV95 coordinates. */
      readonly coordinates: Coordinate[];
    };

/** Immutable history entry representing one user waypoint and its incoming section. */
export interface RouteStep {
  /**
   * Effective waypoint coordinate; network mode replaces the original click
   * with the snapped coordinate.
   */
  waypoint: Coordinate;
  /** Geometry from the previous waypoint to this one, or `null` for the first point. */
  section: RouteSection | null;
}

/** Optional final section that connects the last waypoint back to the first. */
export type RouteClosure = RouteSection;

/** Complete immutable route geometry shared by editing, display, metrics, and export. */
export interface RouteState {
  /** Ordered user waypoints and their normal incoming sections. */
  steps: RouteStep[];
  /** Dedicated loop-closing section, without a duplicate waypoint marker. */
  closure: RouteClosure | null;
}

/** Immutable undo/redo state for route editing. */
export interface RouteHistory extends RouteState {
  /** Complete prior route states stored in chronological order. */
  undoStates: RouteState[];
  /** Complete undone route states stored in reverse restoration order. */
  redoStates: RouteState[];
}

/**
 * Squared distance in LV95 square metres below which consecutive generated
 * vertices are treated as duplicates. Imported geometry deliberately bypasses
 * this tolerance so dense GPX samples remain lossless.
 */
const GENERATED_DUPLICATE_COORDINATE_DISTANCE_SQUARED = 0.01;

/**
 * Returns the immutable route portion of a history entry without its stacks.
 * @param history - Current route geometry and undo/redo stacks.
 * @returns Route state that preserves the same immutable geometry references.
 */
export function getRouteState(history: RouteHistory): RouteState {
  return {
    steps: history.steps,
    closure: history.closure,
  };
}

/**
 * Checks whether asynchronous work still owns the displayed immutable state.
 * Reference equality is intentional because every committed edit replaces the
 * affected route arrays instead of mutating them in place.
 * @param history - Current route history.
 * @param expectedState - Route state captured when the operation started.
 * @returns `true` only while neither steps nor loop closure has changed.
 */
export function routeStateMatches(
  history: RouteHistory,
  expectedState: RouteState,
): boolean {
  return (
    history.steps === expectedState.steps &&
    history.closure === expectedState.closure
  );
}

/**
 * Returns squared horizontal distance in LV95 square metres.
 * @param first - First coordinate.
 * @param second - Second coordinate.
 * @returns Squared XY distance without calculating a square root.
 */
export function coordinateDistanceSquared(
  first: Coordinate,
  second: Coordinate,
): number {
  const deltaX = first[0] - second[0];
  const deltaY = first[1] - second[1];
  return deltaX * deltaX + deltaY * deltaY;
}

/** Appends one section coordinate with provenance-appropriate deduplication. */
function appendSectionCoordinate(
  coordinates: Coordinate[],
  coordinate: Coordinate,
  origin: RouteSection['origin'],
): void {
  const previousCoordinate = coordinates[coordinates.length - 1];

  if (!previousCoordinate) {
    coordinates.push([...coordinate]);
    return;
  }

  if (origin === 'imported') {
    // Imported GPX editing promises to preserve every source vertex. Only the
    // exact boundary duplicated by adjacent section slices may disappear.
    if (
      previousCoordinate[0] !== coordinate[0] ||
      previousCoordinate[1] !== coordinate[1]
    ) {
      coordinates.push([...coordinate]);
    }
    return;
  }

  // Preserve the pre-existing display behaviour for calculated geometry, which
  // removes sub-decimetre artefacts around snapped section junctions.
  if (
    coordinateDistanceSquared(previousCoordinate, coordinate) >
    GENERATED_DUPLICATE_COORDINATE_DISTANCE_SQUARED
  ) {
    coordinates.push([...coordinate]);
  }
}

/** Appends a standalone waypoint while removing only an exact duplicate. */
function appendWaypointCoordinate(
  coordinates: Coordinate[],
  coordinate: Coordinate,
): void {
  const previousCoordinate = coordinates[coordinates.length - 1];

  if (
    !previousCoordinate ||
    previousCoordinate[0] !== coordinate[0] ||
    previousCoordinate[1] !== coordinate[1]
  ) {
    coordinates.push([...coordinate]);
  }
}

/**
 * Flattens incoming step geometries into one continuous display line.
 * @param steps - Ordered immutable route steps.
 * @param closure - Optional final section back to the first waypoint.
 * @returns Route coordinates in display order with exact section junctions deduplicated.
 */
export function collectRouteCoordinates(
  steps: RouteStep[],
  closure: RouteClosure | null = null,
): Coordinate[] {
  const coordinates: Coordinate[] = [];

  for (const step of steps) {
    if (step.section && step.section.coordinates.length >= 2) {
      for (const coordinate of step.section.coordinates) {
        appendSectionCoordinate(coordinates, coordinate, step.section.origin);
      }
    } else {
      appendWaypointCoordinate(coordinates, step.waypoint);
    }
  }

  if (closure?.coordinates && closure.coordinates.length >= 2) {
    for (const coordinate of closure.coordinates) {
      appendSectionCoordinate(coordinates, coordinate, closure.origin);
    }
  }

  return coordinates;
}

/** Reverses one section while preserving whether its geometry was imported. */
function reverseSection(section: RouteSection): RouteSection {
  const coordinates = section.coordinates
    .slice()
    .reverse()
    .map((coordinate): Coordinate => [...coordinate]);

  return section.origin === 'imported'
    ? { origin: 'imported', coordinates }
    : {
        origin: 'generated',
        mode: section.mode,
        coordinates,
      };
}

/**
 * Reverses waypoint order and every stored incoming section without routing again.
 *
 * Each original section belongs to its destination step. After reversal, that
 * same section belongs to the former start waypoint, so both the geometry and
 * owning step must be rebuilt in the opposite direction.
 *
 * @param steps - Applied route steps in their current display order.
 * @returns A new immutable step array representing the same geometry backwards.
 */
export function reverseRouteSteps(steps: RouteStep[]): RouteStep[] {
  if (steps.length === 0) {
    return [];
  }

  const lastStep = steps[steps.length - 1];
  const reversedSteps: RouteStep[] = [
    {
      waypoint: [...lastStep.waypoint],
      section: null,
    },
  ];

  for (let index = steps.length - 1; index > 0; index -= 1) {
    const sourceStep = steps[index];
    const destinationStep = steps[index - 1];
    const reversedSection = sourceStep.section
      ? reverseSection(sourceStep.section)
      : {
          origin: 'generated' as const,
          mode: 'straight' as const,
          coordinates: [
            [...sourceStep.waypoint],
            [...destinationStep.waypoint],
          ],
        };

    reversedSteps.push({
      waypoint: [...destinationStep.waypoint],
      section: reversedSection,
    });
  }

  return reversedSteps;
}

/**
 * Reverses a closed route while preserving its physical start waypoint.
 *
 * A loop has no inherent geometric endpoint, but the user's first waypoint is
 * still meaningful as the start shown by the combined A/B marker. Reversal
 * therefore rotates section ownership around that fixed waypoint instead of
 * making the former last waypoint the new start.
 */
function reverseClosedRouteState(state: RouteState): RouteState {
  const { steps, closure } = state;

  if (!closure || steps.length < 2) {
    return state;
  }

  const reversedSteps: RouteStep[] = [
    {
      waypoint: [...steps[0].waypoint],
      section: null,
    },
    {
      waypoint: [...steps[steps.length - 1].waypoint],
      section: reverseSection(closure),
    },
  ];

  for (let index = steps.length - 1; index > 1; index -= 1) {
    const sourceStep = steps[index];
    const destinationStep = steps[index - 1];
    const reversedSection = sourceStep.section
      ? reverseSection(sourceStep.section)
      : {
          origin: 'generated' as const,
          mode: 'straight' as const,
          coordinates: [
            [...sourceStep.waypoint],
            [...destinationStep.waypoint],
          ],
        };

    reversedSteps.push({
      waypoint: [...destinationStep.waypoint],
      section: reversedSection,
    });
  }

  const firstNormalSection = steps[1];
  const reversedClosure: RouteClosure = firstNormalSection.section
    ? reverseSection(firstNormalSection.section)
    : {
        origin: 'generated',
        mode: 'straight',
        coordinates: [
          [...firstNormalSection.waypoint],
          [...steps[0].waypoint],
        ],
      };

  return {
    steps: reversedSteps,
    closure: reversedClosure,
  };
}

/**
 * Reverses an open or closed route without recalculating any geometry.
 * @param state - Current immutable route geometry.
 * @returns A new state with the same path traversed in the opposite direction.
 */
export function reverseRouteState(state: RouteState): RouteState {
  if (state.closure) {
    return reverseClosedRouteState(state);
  }

  return {
    steps: reverseRouteSteps(state.steps),
    closure: null,
  };
}
