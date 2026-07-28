/**
 * Business context: rebuilds only the editable route sections affected by a
 * waypoint move, insertion, deletion, or loop closure. It coordinates the
 * experimental swissTLM3D router with immutable route state while keeping
 * React state and OpenLayers rendering outside the routing workflow.
 */
import type { Coordinate } from 'ol/coordinate.js';
import type { DynamicRoutingNetworkLoader } from './dynamicRoutingNetwork';
import type { RoutedNetworkPath } from './networkRouter';
import { assertNetworkRouteSectionDistance } from './routeSectionLimit';
import {
  coordinateDistanceSquared,
  type RouteClosure,
  type RouteMode,
  type RouteState,
  type RouteStep,
} from '../map/routeState';

/**
 * Squared distance in square LV95 metres below which a network endpoint is
 * considered continuous with the exact waypoint. Increasing it may hide small
 * visible gaps; lowering it adds more short straight access connectors.
 */
const ROUTE_CONNECTOR_DISTANCE_SQUARED = 0.01;

/**
 * Creates a freely placed waypoint and, when possible, a direct section from
 * the previous route endpoint.
 * @param previousStep - Current final step, or `undefined` for the first point.
 * @param coordinate - Exact LV95 position selected by the user.
 * @returns A new immutable straight-mode route step.
 */
export function createStraightRouteStep(
  previousStep: RouteStep | undefined,
  coordinate: Coordinate,
): RouteStep {
  const waypoint: Coordinate = [...coordinate];

  return {
    waypoint,
    segment: previousStep ? [[...previousStep.waypoint], waypoint] : null,
    mode: 'straight',
  };
}

/**
 * Adds an exact endpoint connector when network snapping leaves a visible gap.
 * The routed segment is intentionally mutated while it is still a local work
 * buffer and before it becomes part of immutable route state.
 * @param segment - Newly calculated network geometry.
 * @param coordinate - Exact waypoint that the displayed geometry must reach.
 * @param position - Segment end that must connect to the waypoint.
 */
export function connectRoutedSegmentEndpoint(
  segment: Coordinate[],
  coordinate: Coordinate,
  position: 'start' | 'end',
): void {
  const endpoint =
    position === 'start' ? segment[0] : segment[segment.length - 1];

  if (
    coordinateDistanceSquared(coordinate, endpoint) <=
    ROUTE_CONNECTOR_DISTANCE_SQUARED
  ) {
    return;
  }

  if (position === 'start') {
    segment.unshift([...coordinate]);
  } else {
    segment.push([...coordinate]);
  }
}

/**
 * Requests one network path only after the intended section passes the
 * product-level distance rule. Keeping this guard beside every routing call
 * prevents future editing workflows from bypassing the same pre-Worker check.
 *
 * @param startCoordinate - Intended section start in LV95.
 * @param endCoordinate - Intended section end in LV95.
 * @param routingLoader - Bounded dynamic swissTLM3D network loader.
 * @param signal - Cancellation signal owned by the current edit.
 * @returns Routed geometry, or `null` when normal coverage is insufficient.
 * @throws {RouteSectionTooLongError} Before invoking the Worker when the direct
 * distance exceeds the product limit.
 */
export async function requestNetworkRouteSection(
  startCoordinate: Coordinate,
  endCoordinate: Coordinate,
  routingLoader: DynamicRoutingNetworkLoader,
  signal: AbortSignal,
): Promise<RoutedNetworkPath | null> {
  assertNetworkRouteSectionDistance(startCoordinate, endCoordinate);
  return routingLoader.route(startCoordinate, endCoordinate, signal);
}

/**
 * Validates every intended section of one compound edit before its first
 * Worker-backed operation. This prevents a valid first half from loading data
 * before a later half reveals that the complete edit is ambiguous.
 * @param sections - Intended LV95 endpoint pairs in edit order.
 * @throws {RouteSectionTooLongError} When any pair exceeds the product limit.
 */
function assertNetworkRouteSectionsDistance(
  sections: readonly (readonly [Coordinate, Coordinate])[],
): void {
  for (const [startCoordinate, endCoordinate] of sections) {
    assertNetworkRouteSectionDistance(startCoordinate, endCoordinate);
  }
}

/**
 * Creates a direct loop-closing section between the last and first waypoints.
 * @param steps - Ordered route steps.
 * @returns A straight closure, or `null` when fewer than two points exist.
 */
export function createStraightRouteClosure(
  steps: RouteStep[],
): RouteClosure | null {
  const firstStep = steps[0];
  const lastStep = steps[steps.length - 1];

  if (!firstStep || !lastStep || steps.length < 2) {
    return null;
  }

  return {
    segment: [[...lastStep.waypoint], [...firstStep.waypoint]],
    mode: 'straight',
  };
}

/**
 * Resolves one section whose start and end waypoints must remain exact.
 * Network mode may still fall back to a straight section when no connected
 * swissTLM3D path exists; request and parsing errors continue to propagate.
 * @param startCoordinate - Exact section start in LV95.
 * @param endCoordinate - Exact section end in LV95.
 * @param intendedMode - Current user snap choice.
 * @param routingLoader - Bounded dynamic swissTLM3D network loader.
 * @param signal - Cancellation signal owned by the current edit.
 * @returns Rebuilt section geometry and the mode actually used.
 * @throws {Error} Propagates routing request, parsing, or size-limit failures.
 */
export async function rebuildFixedRouteSection(
  startCoordinate: Coordinate,
  endCoordinate: Coordinate,
  intendedMode: RouteMode,
  routingLoader: DynamicRoutingNetworkLoader,
  signal: AbortSignal,
): Promise<RouteClosure> {
  if (intendedMode === 'network') {
    const routedPath = await requestNetworkRouteSection(
      startCoordinate,
      endCoordinate,
      routingLoader,
      signal,
    );

    if (routedPath && routedPath.coordinates.length >= 2) {
      const segment = routedPath.coordinates.map((coordinate): Coordinate => [
        ...coordinate,
      ]);
      connectRoutedSegmentEndpoint(segment, startCoordinate, 'start');
      connectRoutedSegmentEndpoint(segment, endCoordinate, 'end');

      return {
        segment,
        mode: 'network',
      };
    }
  }

  return {
    segment: [[...startCoordinate], [...endCoordinate]],
    mode: 'straight',
  };
}

/**
 * Recalculates only the sections adjacent to a moved waypoint.
 *
 * The current snap choice governs every rebuilt section instead of preserving
 * the modes stored before the edit. A closed route also recalculates its final
 * section when the first or last waypoint moves. Unrelated sections retain
 * their exact stored geometry.
 *
 * @param state - Route state captured when the drag started.
 * @param waypointIndex - Index of the waypoint being moved.
 * @param targetCoordinate - Released pointer coordinate in LV95.
 * @param editMode - Current snap choice applied to affected sections.
 * @param routingLoader - Bounded dynamic swissTLM3D network loader.
 * @param signal - Cancellation signal owned by the edit.
 * @returns Updated immutable route state.
 * @throws {Error} Propagates routing request, parsing, or size-limit failures.
 */
export async function rebuildRouteAfterWaypointMove(
  state: RouteState,
  waypointIndex: number,
  targetCoordinate: Coordinate,
  editMode: RouteMode,
  routingLoader: DynamicRoutingNetworkLoader,
  signal: AbortSignal,
): Promise<RouteState> {
  const { steps, closure } = state;
  const nextSteps = steps.slice();
  const originalStep = steps[waypointIndex];

  if (!originalStep) {
    return state;
  }

  if (editMode === 'network') {
    const intendedSections: Array<readonly [Coordinate, Coordinate]> = [];
    const previousStep = steps[waypointIndex - 1];
    const nextStep = steps[waypointIndex + 1];

    if (previousStep) {
      intendedSections.push([previousStep.waypoint, targetCoordinate]);
    }

    if (nextStep) {
      intendedSections.push([targetCoordinate, nextStep.waypoint]);
    }

    if (closure && waypointIndex === 0) {
      const lastStep = steps[steps.length - 1];

      if (lastStep) {
        intendedSections.push([lastStep.waypoint, targetCoordinate]);
      }
    } else if (closure && waypointIndex === steps.length - 1) {
      const firstStep = steps[0];

      if (firstStep) {
        intendedSections.push([targetCoordinate, firstStep.waypoint]);
      }
    }

    assertNetworkRouteSectionsDistance(intendedSections);
  }

  let movedWaypoint: Coordinate;

  if (waypointIndex === 0) {
    if (editMode === 'network') {
      const snappedCoordinate = await routingLoader.snap(
        targetCoordinate,
        signal,
      );

      if (snappedCoordinate) {
        movedWaypoint = [...snappedCoordinate];
        nextSteps[0] = {
          ...originalStep,
          waypoint: movedWaypoint,
          segment: null,
          mode: 'network',
        };
      } else {
        movedWaypoint = [...targetCoordinate];
        nextSteps[0] = {
          ...originalStep,
          waypoint: movedWaypoint,
          segment: null,
          mode: 'straight',
        };
      }
    } else {
      movedWaypoint = [...targetCoordinate];
      nextSteps[0] = {
        ...originalStep,
        waypoint: movedWaypoint,
        segment: null,
        mode: 'straight',
      };
    }
  } else {
    const previousStep = steps[waypointIndex - 1];

    if (editMode === 'network') {
      const routedPath = await requestNetworkRouteSection(
        previousStep.waypoint,
        targetCoordinate,
        routingLoader,
        signal,
      );

      if (routedPath && routedPath.coordinates.length >= 2) {
        const segment = routedPath.coordinates.map((coordinate): Coordinate => [
          ...coordinate,
        ]);
        connectRoutedSegmentEndpoint(segment, previousStep.waypoint, 'start');
        movedWaypoint = [...segment[segment.length - 1]];
        nextSteps[waypointIndex] = {
          ...originalStep,
          waypoint: movedWaypoint,
          segment,
          mode: 'network',
        };
      } else {
        movedWaypoint = [...targetCoordinate];
        nextSteps[waypointIndex] = createStraightRouteStep(
          previousStep,
          movedWaypoint,
        );
      }
    } else {
      movedWaypoint = [...targetCoordinate];
      nextSteps[waypointIndex] = createStraightRouteStep(
        previousStep,
        movedWaypoint,
      );
    }
  }

  const nextStep = steps[waypointIndex + 1];

  if (nextStep) {
    const rebuiltSection = await rebuildFixedRouteSection(
      movedWaypoint,
      nextStep.waypoint,
      editMode,
      routingLoader,
      signal,
    );
    nextSteps[waypointIndex + 1] = {
      ...nextStep,
      segment: rebuiltSection.segment,
      mode: rebuiltSection.mode,
    };
  }

  let nextClosure = closure;

  if (
    closure &&
    steps.length >= 2 &&
    (waypointIndex === 0 || waypointIndex === steps.length - 1)
  ) {
    nextClosure = await rebuildFixedRouteSection(
      nextSteps[nextSteps.length - 1].waypoint,
      nextSteps[0].waypoint,
      editMode,
      routingLoader,
      signal,
    );
  }

  return {
    steps: nextSteps,
    closure: nextClosure,
  };
}

/**
 * Splits one normal or loop-closing section by inserting a dragged waypoint.
 * Both halves use the current snap choice and may fall back independently to
 * straight geometry.
 * @param state - Route state captured when the drag started.
 * @param stepIndex - Destination step, or `steps.length` for the closure.
 * @param targetCoordinate - Released pointer coordinate in LV95.
 * @param editMode - Current snap choice applied to both new sections.
 * @param routingLoader - Bounded dynamic swissTLM3D network loader.
 * @param signal - Cancellation signal owned by the edit.
 * @returns Updated immutable route state.
 * @throws {Error} Propagates routing request, parsing, or size-limit failures.
 */
export async function rebuildRouteAfterWaypointInsertion(
  state: RouteState,
  stepIndex: number,
  targetCoordinate: Coordinate,
  editMode: RouteMode,
  routingLoader: DynamicRoutingNetworkLoader,
  signal: AbortSignal,
): Promise<RouteState> {
  const { steps, closure } = state;

  if (stepIndex === steps.length && closure && steps.length >= 2) {
    const previousStep = steps[steps.length - 1];

    if (editMode === 'network') {
      assertNetworkRouteSectionsDistance([
        [previousStep.waypoint, targetCoordinate],
        [targetCoordinate, steps[0].waypoint],
      ]);
    }

    let insertedStep: RouteStep;

    if (editMode === 'network') {
      const routedPath = await requestNetworkRouteSection(
        previousStep.waypoint,
        targetCoordinate,
        routingLoader,
        signal,
      );

      if (routedPath && routedPath.coordinates.length >= 2) {
        const segment = routedPath.coordinates.map((coordinate): Coordinate => [
          ...coordinate,
        ]);
        connectRoutedSegmentEndpoint(segment, previousStep.waypoint, 'start');
        insertedStep = {
          waypoint: [...segment[segment.length - 1]],
          segment,
          mode: 'network',
        };
      } else {
        insertedStep = createStraightRouteStep(previousStep, targetCoordinate);
      }
    } else {
      insertedStep = createStraightRouteStep(previousStep, targetCoordinate);
    }

    const nextClosure = await rebuildFixedRouteSection(
      insertedStep.waypoint,
      steps[0].waypoint,
      editMode,
      routingLoader,
      signal,
    );

    return {
      steps: [...steps, insertedStep],
      closure: nextClosure,
    };
  }

  const destinationStep = steps[stepIndex];
  const previousStep = steps[stepIndex - 1];

  if (!destinationStep || !previousStep || stepIndex < 1) {
    return state;
  }

  if (editMode === 'network') {
    assertNetworkRouteSectionsDistance([
      [previousStep.waypoint, targetCoordinate],
      [targetCoordinate, destinationStep.waypoint],
    ]);
  }

  let insertedStep: RouteStep;

  if (editMode === 'network') {
    const routedPath = await requestNetworkRouteSection(
      previousStep.waypoint,
      targetCoordinate,
      routingLoader,
      signal,
    );

    if (routedPath && routedPath.coordinates.length >= 2) {
      const segment = routedPath.coordinates.map((coordinate): Coordinate => [
        ...coordinate,
      ]);
      connectRoutedSegmentEndpoint(segment, previousStep.waypoint, 'start');
      insertedStep = {
        waypoint: [...segment[segment.length - 1]],
        segment,
        mode: 'network',
      };
    } else {
      insertedStep = createStraightRouteStep(previousStep, targetCoordinate);
    }
  } else {
    insertedStep = createStraightRouteStep(previousStep, targetCoordinate);
  }

  const rebuiltDestinationSection = await rebuildFixedRouteSection(
    insertedStep.waypoint,
    destinationStep.waypoint,
    editMode,
    routingLoader,
    signal,
  );
  const updatedDestinationStep: RouteStep = {
    ...destinationStep,
    segment: rebuiltDestinationSection.segment,
    mode: rebuiltDestinationSection.mode,
  };

  return {
    steps: [
      ...steps.slice(0, stepIndex),
      insertedStep,
      updatedDestinationStep,
      ...steps.slice(stepIndex + 1),
    ],
    closure,
  };
}

/**
 * Removes one waypoint and reconnects its neighbours when necessary.
 * The replacement section uses the current snap choice. Closed-route endpoint
 * deletion rebuilds the loop around the remaining points the same way.
 * @param state - Route state captured when deletion started.
 * @param waypointIndex - Index of the waypoint to remove.
 * @param editMode - Current snap choice applied to replacement sections.
 * @param routingLoader - Bounded dynamic swissTLM3D network loader.
 * @param signal - Cancellation signal owned by the edit.
 * @returns Updated immutable route state.
 * @throws {Error} Propagates routing request, parsing, or size-limit failures.
 */
export async function rebuildRouteAfterWaypointDeletion(
  state: RouteState,
  waypointIndex: number,
  editMode: RouteMode,
  routingLoader: DynamicRoutingNetworkLoader,
  signal: AbortSignal,
): Promise<RouteState> {
  const { steps, closure } = state;

  if (waypointIndex < 0 || waypointIndex >= steps.length) {
    return state;
  }

  if (steps.length === 1) {
    return {
      steps: [],
      closure: null,
    };
  }

  if (closure && steps.length === 2) {
    const remainingStep = steps[waypointIndex === 0 ? 1 : 0];

    return {
      steps: [
        {
          ...remainingStep,
          waypoint: [...remainingStep.waypoint],
          segment: null,
        },
      ],
      closure: null,
    };
  }

  if (waypointIndex === 0) {
    const nextFirstStep = steps[1];
    const nextSteps = [
      {
        ...nextFirstStep,
        waypoint: [...nextFirstStep.waypoint],
        segment: null,
      },
      ...steps.slice(2),
    ];

    if (!closure) {
      return {
        steps: nextSteps,
        closure: null,
      };
    }

    const nextClosure = await rebuildFixedRouteSection(
      nextSteps[nextSteps.length - 1].waypoint,
      nextSteps[0].waypoint,
      editMode,
      routingLoader,
      signal,
    );

    return {
      steps: nextSteps,
      closure: nextClosure,
    };
  }

  if (waypointIndex === steps.length - 1) {
    const nextSteps = steps.slice(0, -1);

    if (!closure) {
      return {
        steps: nextSteps,
        closure: null,
      };
    }

    const nextClosure = await rebuildFixedRouteSection(
      nextSteps[nextSteps.length - 1].waypoint,
      nextSteps[0].waypoint,
      editMode,
      routingLoader,
      signal,
    );

    return {
      steps: nextSteps,
      closure: nextClosure,
    };
  }

  const previousStep = steps[waypointIndex - 1];
  const destinationStep = steps[waypointIndex + 1];
  const rebuiltDestinationSection = await rebuildFixedRouteSection(
    previousStep.waypoint,
    destinationStep.waypoint,
    editMode,
    routingLoader,
    signal,
  );
  const updatedDestinationStep: RouteStep = {
    ...destinationStep,
    segment: rebuiltDestinationSection.segment,
    mode: rebuiltDestinationSection.mode,
  };

  return {
    steps: [
      ...steps.slice(0, waypointIndex),
      updatedDestinationStep,
      ...steps.slice(waypointIndex + 2),
    ],
    closure,
  };
}
