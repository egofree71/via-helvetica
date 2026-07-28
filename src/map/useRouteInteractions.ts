/**
 * Business context: owns the focused OpenLayers pointer interactions used to
 * shape one editable itinerary. It converts route clicks and drags into semantic
 * edit requests while keeping previews, hit detection, click suppression, and
 * contextual guidance independent from swissTLM3D routing and React route
 * history management.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { Coordinate } from 'ol/coordinate.js';
import { containsCoordinate } from 'ol/extent.js';
import MapBrowserEvent from 'ol/MapBrowserEvent.js';
import type { Pixel } from 'ol/pixel.js';
import { MAP_EXTENT } from './config';
import type { MapRuntime } from './mapRuntime';
import {
  clearRouteDragCursor,
  createRouteDragInteraction,
  getRouteWaypointIndexAtPixel,
  type RouteDragTarget,
  type RouteHoverTarget,
  updateRouteDisplay,
  updateRouteInsertionDragPreview,
  updateRouteWaypointDragPreview,
} from './route';
import {
  coordinateDistanceSquared,
  type RouteState,
} from './routeState';

/** Contextual route-editing label shown only for hover-capable pointers. */
export interface RouteContextHint {
  /** Route element currently below a hover-capable pointer. */
  target: RouteHoverTarget;
  /** Clamped horizontal position inside the map container. */
  left: number;
  /** Pointer-relative vertical position inside the map container. */
  top: number;
  /** Places the label below the pointer when there is no room above it. */
  below: boolean;
}

/** Semantic callbacks supplied by the editable-route controller. */
export interface UseRouteInteractionsOptions {
  /** Shared OpenLayers runtime containing the map and editable display. */
  mapRuntimeRef: RefObject<MapRuntime | null>;
  /** Map container used to keep contextual labels inside the viewport. */
  mapTargetRef: RefObject<HTMLDivElement | null>;
  /** Whether route click and drag editing is currently enabled. */
  isActive: boolean;
  /** Synchronous active-mode guard before React detaches map listeners. */
  isEditingActive: () => boolean;
  /** Synchronous busy guard for pointer events emitted before React rerenders. */
  isOperationPending: () => boolean;
  /** Returns the latest immutable route state, never an OpenLayers preview. */
  getCurrentRouteState: () => RouteState;
  /** Adds one endpoint from the current route end. */
  onAppendEndpoint: (
    expectedState: RouteState,
    coordinate: Coordinate,
  ) => void;
  /** Recalculates a released existing waypoint. */
  onMoveWaypoint: (
    expectedState: RouteState,
    waypointIndex: number,
    coordinate: Coordinate,
  ) => void;
  /** Inserts a waypoint into the released route section. */
  onInsertWaypoint: (
    expectedState: RouteState,
    stepIndex: number,
    coordinate: Coordinate,
  ) => void;
  /** Deletes a clicked existing waypoint. */
  onDeleteWaypoint: (
    expectedState: RouteState,
    waypointIndex: number,
  ) => void;
}

/** Pointer interaction state exposed to the application shell. */
export interface RouteInteractionsController {
  /** Current waypoint/section contextual guidance, or null outside a target. */
  routeContextHint: RouteContextHint | null;
  /** React render state indicating that a route drag currently owns the pointer. */
  isInteractionActive: boolean;
  /** Synchronous accessor used by imperative OpenLayers pointer listeners. */
  isPointerInteractionActive: () => boolean;
}

/** Imperative route drag session kept outside React renders for responsiveness. */
type RouteDragState =
  | {
      /** Existing waypoint being moved. */
      type: 'waypoint';
      waypointIndex: number;
      /** Original waypoint coordinate used to ignore click-only interactions. */
      startCoordinate: Coordinate;
      /** Route state that owns the preview and must still be current on release. */
      expectedState: RouteState;
    }
  | {
      /** Incoming section split by the new waypoint. */
      type: 'segment';
      stepIndex: number;
      /** Closest original line coordinate used to require a genuine drag. */
      startCoordinate: Coordinate;
      /** Route state that owns the preview and must still be current on release. */
      expectedState: RouteState;
    };

/** Route pointer release that must not append a new endpoint through `singleclick`. */
interface RouteInteractionRelease {
  /** Screen pixel already handled by the direct editing interaction. */
  pixel: Pixel;
  /** High-resolution browser timestamp after which suppression expires. */
  expiresAt: number;
}

/** Minimum one-metre waypoint movement needed before recalculation begins. */
const ROUTE_WAYPOINT_MOVE_DISTANCE_SQUARED = 1;
/** Delay during which a click already handled by route editing is ignored. */
const ROUTE_INTERACTION_CLICK_SUPPRESSION_MS = 500;
/** Pixel tolerance for matching the delayed OpenLayers `singleclick`. */
const ROUTE_INTERACTION_CLICK_TOLERANCE_PX = 8;
/** Estimated half-width used to keep contextual guidance inside the viewport. */
const ROUTE_CONTEXT_HINT_HALF_WIDTH_PX = 190;

/** Tests route-state identity without depending on undo/redo stacks. */
function routeStatesMatch(
  currentState: RouteState,
  expectedState: RouteState,
): boolean {
  return (
    currentState.steps === expectedState.steps &&
    currentState.closure === expectedState.closure
  );
}

/**
 * Registers route shaping and endpoint-click interactions while editing is
 * active. Network work remains delegated to semantic callbacks.
 *
 * @param options - Map resources, current-state accessors, and edit callbacks.
 * @returns Contextual guidance and a synchronous drag-state accessor.
 */
export function useRouteInteractions(
  options: UseRouteInteractionsOptions,
): RouteInteractionsController {
  const routeDragStateRef = useRef<RouteDragState | null>(null);
  const routeInteractionReleaseRef =
    useRef<RouteInteractionRelease | null>(null);
  const [routeContextHint, setRouteContextHint] =
    useState<RouteContextHint | null>(null);
  const [isInteractionActive, setIsInteractionActive] = useState(false);

  const restoreCommittedRouteDisplay = useCallback(() => {
    const display = options.mapRuntimeRef.current?.routeDisplay;

    if (!display) {
      return;
    }

    const currentState = options.getCurrentRouteState();
    updateRouteDisplay(display, currentState.steps, currentState.closure);
  }, [options.getCurrentRouteState, options.mapRuntimeRef]);

  const isPointerInteractionActive = useCallback(
    () => routeDragStateRef.current !== null,
    [],
  );

  /** Enables direct waypoint and route-section shaping only during editing. */
  useEffect(() => {
    const map = options.mapRuntimeRef.current?.map;
    const display = options.mapRuntimeRef.current?.routeDisplay;

    if (!map || !display || !options.isActive) {
      return;
    }

    const interaction = createRouteDragInteraction(display, {
      canStart: () =>
        options.isEditingActive() &&
        !options.isOperationPending() &&
        options.getCurrentRouteState().steps.length > 0,
      getRouteState: options.getCurrentRouteState,
      onTapWaypoint: (target, pixel) => {
        const expectedState = options.getCurrentRouteState();
        const step = expectedState.steps[target.waypointIndex];

        // A route mutation during the press must not redirect the tap to a
        // different waypoint that happens to reuse the same array index.
        if (
          !step ||
          coordinateDistanceSquared(step.waypoint, target.coordinate) > 0
        ) {
          return;
        }

        routeInteractionReleaseRef.current = {
          pixel: [...pixel],
          expiresAt:
            performance.now() + ROUTE_INTERACTION_CLICK_SUPPRESSION_MS,
        };
        options.onDeleteWaypoint(expectedState, target.waypointIndex);
      },
      onStart: (target: RouteDragTarget) => {
        const expectedState = options.getCurrentRouteState();
        const { steps, closure } = expectedState;

        if (target.type === 'waypoint') {
          const step = steps[target.waypointIndex];

          if (!step) {
            return;
          }

          routeDragStateRef.current = {
            type: 'waypoint',
            waypointIndex: target.waypointIndex,
            startCoordinate: [...step.waypoint],
            expectedState,
          };
          setIsInteractionActive(true);
          updateRouteWaypointDragPreview(
            display,
            steps,
            closure,
            target.waypointIndex,
            step.waypoint,
          );
          return;
        }

        const isNormalSegment =
          target.stepIndex >= 1 &&
          target.stepIndex < steps.length &&
          Boolean(steps[target.stepIndex]) &&
          Boolean(steps[target.stepIndex - 1]);
        const isClosingSegment =
          target.stepIndex === steps.length &&
          steps.length >= 2 &&
          closure !== null;

        if (!isNormalSegment && !isClosingSegment) {
          return;
        }

        routeDragStateRef.current = {
          type: 'segment',
          stepIndex: target.stepIndex,
          startCoordinate: [...target.coordinate],
          expectedState,
        };
        setIsInteractionActive(true);
        updateRouteInsertionDragPreview(
          display,
          steps,
          closure,
          target.stepIndex,
          target.coordinate,
        );
      },
      onHover: (target, pixel) => {
        if (!target || !pixel) {
          setRouteContextHint(null);
          return;
        }

        const mapWidth = options.mapTargetRef.current?.clientWidth ?? 0;
        const horizontalMargin = Math.min(
          ROUTE_CONTEXT_HINT_HALF_WIDTH_PX,
          Math.max(0, mapWidth / 2 - 12),
        );
        const left =
          mapWidth > 0
            ? Math.min(
                Math.max(pixel[0], horizontalMargin + 12),
                Math.max(
                  horizontalMargin + 12,
                  mapWidth - horizontalMargin - 12,
                ),
              )
            : pixel[0];

        setRouteContextHint({
          target,
          left,
          top: pixel[1],
          below: pixel[1] < 64,
        });
      },
      onDrag: (target: RouteDragTarget, coordinate) => {
        const dragState = routeDragStateRef.current;

        if (
          !dragState ||
          dragState.type !== target.type ||
          !routeStatesMatch(
            options.getCurrentRouteState(),
            dragState.expectedState,
          )
        ) {
          return;
        }

        if (
          dragState.type === 'waypoint' &&
          target.type === 'waypoint' &&
          dragState.waypointIndex === target.waypointIndex
        ) {
          updateRouteWaypointDragPreview(
            display,
            dragState.expectedState.steps,
            dragState.expectedState.closure,
            dragState.waypointIndex,
            coordinate,
          );
          return;
        }

        if (
          dragState.type === 'segment' &&
          target.type === 'segment' &&
          dragState.stepIndex === target.stepIndex
        ) {
          updateRouteInsertionDragPreview(
            display,
            dragState.expectedState.steps,
            dragState.expectedState.closure,
            dragState.stepIndex,
            coordinate,
          );
        }
      },
      onCancel: () => {
        routeDragStateRef.current = null;
        setIsInteractionActive(false);
        setRouteContextHint(null);
        restoreCommittedRouteDisplay();
      },
      onEnd: (target: RouteDragTarget, coordinate, didDrag, pixel) => {
        const dragState = routeDragStateRef.current;
        routeDragStateRef.current = null;
        setIsInteractionActive(false);
        setRouteContextHint(null);

        // Mouse and pen waypoint clicks are deletions, while every genuine
        // drag owns its delayed `singleclick`. Touch waypoint taps are handled
        // separately before a preview starts. A click-only section press remains
        // available to append a new endpoint from the current route end.
        if (target.type === 'waypoint' || didDrag) {
          routeInteractionReleaseRef.current = {
            pixel: [...pixel],
            expiresAt:
              performance.now() + ROUTE_INTERACTION_CLICK_SUPPRESSION_MS,
          };
        }

        const targetMatchesState =
          dragState?.type === target.type &&
          ((dragState.type === 'waypoint' &&
            target.type === 'waypoint' &&
            dragState.waypointIndex === target.waypointIndex) ||
            (dragState.type === 'segment' &&
              target.type === 'segment' &&
              dragState.stepIndex === target.stepIndex));

        if (
          !dragState ||
          !targetMatchesState ||
          !routeStatesMatch(
            options.getCurrentRouteState(),
            dragState.expectedState,
          )
        ) {
          restoreCommittedRouteDisplay();
          return;
        }

        if (dragState.type === 'waypoint' && !didDrag) {
          options.onDeleteWaypoint(
            dragState.expectedState,
            dragState.waypointIndex,
          );
          return;
        }

        if (
          !containsCoordinate(MAP_EXTENT, coordinate) ||
          coordinateDistanceSquared(
            dragState.startCoordinate,
            coordinate,
          ) <= ROUTE_WAYPOINT_MOVE_DISTANCE_SQUARED ||
          (dragState.type === 'segment' && !didDrag)
        ) {
          restoreCommittedRouteDisplay();
          return;
        }

        if (dragState.type === 'waypoint') {
          options.onMoveWaypoint(
            dragState.expectedState,
            dragState.waypointIndex,
            coordinate,
          );
        } else {
          options.onInsertWaypoint(
            dragState.expectedState,
            dragState.stepIndex,
            coordinate,
          );
        }
      },
    });

    const mapTarget = map.getTargetElement();
    const hideRouteContextHint = () => setRouteContextHint(null);

    map.addInteraction(interaction);
    mapTarget.addEventListener('pointerleave', hideRouteContextHint);

    return () => {
      mapTarget.removeEventListener('pointerleave', hideRouteContextHint);
      // Deactivation stops any edge auto-pan frame before the interaction loses
      // its map, while the committed display is restored below.
      interaction.setActive(false);
      map.removeInteraction(interaction);
      clearRouteDragCursor(map);
      routeDragStateRef.current = null;
      routeInteractionReleaseRef.current = null;
      setIsInteractionActive(false);
      setRouteContextHint(null);
      restoreCommittedRouteDisplay();
    };
  }, [
    options.getCurrentRouteState,
    options.isActive,
    options.isEditingActive,
    options.isOperationPending,
    options.mapRuntimeRef,
    options.mapTargetRef,
    options.onDeleteWaypoint,
    options.onInsertWaypoint,
    options.onMoveWaypoint,
    restoreCommittedRouteDisplay,
  ]);

  /** Registers endpoint creation clicks only while route editing is active. */
  useEffect(() => {
    const map = options.mapRuntimeRef.current?.map;

    if (!map || !options.isActive) {
      return;
    }

    const handleRouteClick = (event: MapBrowserEvent) => {
      // OpenLayers emits `singleclick` after a pointer interaction has already
      // handled a deletion or drag. Suppress only the matching delayed event.
      const interactionRelease = routeInteractionReleaseRef.current;

      if (interactionRelease) {
        const deltaX = event.pixel[0] - interactionRelease.pixel[0];
        const deltaY = event.pixel[1] - interactionRelease.pixel[1];
        const isMatchingRelease =
          performance.now() <= interactionRelease.expiresAt &&
          deltaX * deltaX + deltaY * deltaY <=
            ROUTE_INTERACTION_CLICK_TOLERANCE_PX ** 2;

        routeInteractionReleaseRef.current = null;

        if (isMatchingRelease) {
          return;
        }
      }

      if (!options.isEditingActive() || options.isOperationPending()) {
        return;
      }

      const display = options.mapRuntimeRef.current?.routeDisplay;
      const expectedState = options.getCurrentRouteState();

      if (expectedState.closure) {
        return;
      }

      // A waypoint click or tap belongs to deletion. A simple section click
      // remains a valid endpoint addition, while a genuine drag is handled above.
      if (
        display &&
        getRouteWaypointIndexAtPixel(map, display, event.pixel) !== null
      ) {
        return;
      }

      options.onAppendEndpoint(expectedState, [...event.coordinate]);
    };

    map.on('singleclick', handleRouteClick);

    return () => {
      map.un('singleclick', handleRouteClick);
    };
  }, [
    options.getCurrentRouteState,
    options.isActive,
    options.isEditingActive,
    options.isOperationPending,
    options.mapRuntimeRef,
    options.onAppendEndpoint,
  ]);

  return {
    routeContextHint,
    isInteractionActive,
    isPointerInteractionActive,
  };
}
