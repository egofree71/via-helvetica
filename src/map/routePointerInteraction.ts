/**
 * Business context: provides the low-level OpenLayers pointer behaviour used to
 * reshape an editable route. It identifies stored waypoints and incoming route
 * sections under the pointer, reserves normal map panning while an edit owns the
 * pointer, auto-pans near viewport edges, and reports semantic drag events
 * without owning immutable history or network routing.
 */
import type { Coordinate } from 'ol/coordinate.js';
import Feature from 'ol/Feature.js';
import PointerInteraction from 'ol/interaction/Pointer.js';
import type Map from 'ol/Map.js';
import type MapBrowserEvent from 'ol/MapBrowserEvent.js';
import type { Pixel } from 'ol/pixel.js';
import type { Size } from 'ol/size.js';
import {
  getRouteWaypointIndex,
  type RouteDisplay,
} from './routeDisplay';
import type {
  RouteClosure,
  RouteState,
  RouteStep,
} from './routeState';

/** Existing waypoint or incoming route section selected for one drag edit. */
export type RouteDragTarget =
  | {
      /** Move an already committed waypoint. */
      type: 'waypoint';
      /** Index of the waypoint in immutable route history. */
      waypointIndex: number;
      /** Exact committed coordinate at pointer down. */
      coordinate: Coordinate;
    }
  | {
      /** Insert a waypoint into an existing incoming section. */
      type: 'segment';
      /**
       * Index of the destination step whose incoming section was selected.
       * `steps.length` represents the dedicated closing section.
       */
      stepIndex: number;
      /** Closest coordinate on the stored section at pointer down. */
      coordinate: Coordinate;
    };

/** Route element exposed to contextual hover guidance. */
export type RouteHoverTarget = RouteDragTarget['type'];

/** Closest selectable route section under one pointer pixel. */
export interface RouteSegmentHit {
  /**
   * Destination step whose incoming geometry contains the hit.
   * `steps.length` represents the dedicated closing section.
   */
  stepIndex: number;
  /** Nearest coordinate on the stored section. */
  coordinate: Coordinate;
}

/** Callbacks used by the pointer interaction without owning route state. */
export interface RouteDragCallbacks {
  /** Returns whether a new drag may begin at this moment. */
  canStart: () => boolean;
  /** Returns the current immutable route state for line hit detection. */
  getRouteState: () => RouteState;
  /** Called once when an existing waypoint or route section starts a drag edit. */
  onStart: (target: RouteDragTarget) => void;
  /** Reports a touch tap on an existing waypoint without starting a drag preview. */
  onTapWaypoint: (
    target: Extract<RouteDragTarget, { type: 'waypoint' }>,
    pixel: Pixel,
  ) => void;
  /** Called for visual previews while the pointer moves. */
  onDrag: (target: RouteDragTarget, coordinate: Coordinate) => void;
  /** Restores committed geometry when a multi-touch gesture cancels an edit. */
  onCancel: (target: RouteDragTarget) => void;
  /** Reports the route element under a hover-capable pointer. */
  onHover: (target: RouteHoverTarget | null, pixel: Pixel | null) => void;
  /** Called once on release so the application can recalculate affected sections. */
  onEnd: (
    target: RouteDragTarget,
    coordinate: Coordinate,
    didDrag: boolean,
    pixel: Pixel,
  ) => void;
}

/** Pointer tolerance in screen pixels, deliberately larger than the visible point for mouse and pen input. */
const ROUTE_WAYPOINT_HIT_TOLERANCE_PX = 12;
/**
 * Additional touch tolerance in screen pixels. Combined with the visible
 * six-pixel waypoint radius, this provides an effective 44-pixel target.
 */
const ROUTE_TOUCH_WAYPOINT_HIT_TOLERANCE_PX = 16;
/** Route-line tolerance in screen pixels for mouse and pen input, matching the white casing around the red line. */
const ROUTE_SEGMENT_HIT_TOLERANCE_PX = 7;
/**
 * Touch tolerance in screen pixels for selecting a route section. It remains
 * deliberately narrow so map panning still wins unless the gesture starts very
 * close to the visible itinerary.
 */
const ROUTE_TOUCH_SEGMENT_HIT_TOLERANCE_PX = 10;
/** Visually indistinguishable section distances use route order as a stable tie-breaker. */
const ROUTE_SEGMENT_OVERLAP_TIE_TOLERANCE_PX = 0.1;
/** Minimum screen movement that distinguishes a drag edit from a click. */
const ROUTE_EDIT_DRAG_DISTANCE_PX = 3;
/**
 * Touch movement in screen pixels required before a waypoint edit starts.
 * A larger threshold absorbs normal finger tremor without making the drag feel delayed.
 */
const ROUTE_TOUCH_EDIT_DRAG_DISTANCE_PX = 8;
/**
 * Edge zone in screen pixels that activates route-drag auto-pan. Enlarging the
 * zone starts map movement earlier; reducing it leaves less time before the
 * pointer reaches the viewport boundary.
 */
const ROUTE_DRAG_AUTO_PAN_EDGE_ZONE_PX = 56;
/**
 * Maximum per-axis route-drag auto-pan speed in screen pixels per second. A higher value
 * reaches off-screen destinations faster but makes precise edge placement harder.
 */
const ROUTE_DRAG_AUTO_PAN_MAX_AXIS_SPEED_PX_PER_SECOND = 360;
/**
 * Maximum elapsed seconds consumed by one animation frame. Capping background-tab
 * delays prevents a large map jump when rendering resumes.
 */
const ROUTE_DRAG_AUTO_PAN_MAX_FRAME_SECONDS = 0.05;

/** Returns squared horizontal distance in map units to avoid a square root during deduplication. */
function coordinateDistanceSquared(
  first: Coordinate,
  second: Coordinate,
): number {
  const deltaX = first[0] - second[0];
  const deltaY = first[1] - second[1];
  return deltaX * deltaX + deltaY * deltaY;
}

/** Returns the closest XY coordinate on one finite segment and its squared distance. */
function getClosestPointOnSegment(
  coordinate: Coordinate,
  start: Coordinate,
  end: Coordinate,
): { coordinate: Coordinate; distanceSquared: number } {
  const segmentX = end[0] - start[0];
  const segmentY = end[1] - start[1];
  const segmentLengthSquared = segmentX * segmentX + segmentY * segmentY;

  if (segmentLengthSquared === 0) {
    return {
      coordinate: [start[0], start[1]],
      distanceSquared: coordinateDistanceSquared(coordinate, start),
    };
  }

  const projection =
    ((coordinate[0] - start[0]) * segmentX +
      (coordinate[1] - start[1]) * segmentY) /
    segmentLengthSquared;
  const boundedProjection = Math.max(0, Math.min(1, projection));
  const closestCoordinate: Coordinate = [
    start[0] + boundedProjection * segmentX,
    start[1] + boundedProjection * segmentY,
  ];

  return {
    coordinate: closestCoordinate,
    distanceSquared: coordinateDistanceSquared(
      coordinate,
      closestCoordinate,
    ),
  };
}

/**
 * Calculates one axis of edge-driven auto-pan velocity. The quadratic response
 * keeps movement gentle when entering the edge zone while still reaching the
 * configured maximum at the viewport boundary.
 *
 * @param position - Pointer position in screen pixels on the inspected axis.
 * @param viewportLength - Current viewport length in screen pixels.
 * @returns Signed velocity in screen pixels per second.
 */
function getRouteDragAutoPanAxisVelocity(
  position: number,
  viewportLength: number,
): number {
  if (viewportLength <= 0) {
    return 0;
  }

  const edgeZone = Math.min(
    ROUTE_DRAG_AUTO_PAN_EDGE_ZONE_PX,
    viewportLength / 2,
  );

  if (position < edgeZone) {
    const proximity = Math.min(1, (edgeZone - position) / edgeZone);
    return -ROUTE_DRAG_AUTO_PAN_MAX_AXIS_SPEED_PX_PER_SECOND * proximity ** 2;
  }

  const farEdgeStart = viewportLength - edgeZone;

  if (position > farEdgeStart) {
    const proximity = Math.min(
      1,
      (position - farEdgeStart) / edgeZone,
    );
    return ROUTE_DRAG_AUTO_PAN_MAX_AXIS_SPEED_PX_PER_SECOND * proximity ** 2;
  }

  return 0;
}

/**
 * Resolves edge-driven horizontal and vertical velocities for one pointer.
 *
 * @param pixel - Pointer position relative to the map viewport.
 * @param size - Current map viewport size in screen pixels.
 * @returns Signed horizontal and vertical velocities in screen pixels per second.
 */
function getRouteDragAutoPanVelocity(
  pixel: Pixel,
  size: Size,
): Pixel {
  return [
    getRouteDragAutoPanAxisVelocity(pixel[0], size[0]),
    getRouteDragAutoPanAxisVelocity(pixel[1], size[1]),
  ];
}

/**
 * Converts a screen-space movement into the equivalent map-coordinate delta.
 * The rotation-aware conversion keeps auto-pan direction correct on a rotated
 * map without depending on a render frame that may lag behind `View.setCenter`.
 *
 * @param pixelDelta - Horizontal and vertical movement in screen pixels.
 * @param resolution - Current map units represented by one screen pixel.
 * @param rotation - Current map rotation in radians.
 * @returns Equivalent delta in map coordinates.
 */
function screenPixelDeltaToMapDelta(
  pixelDelta: Pixel,
  resolution: number,
  rotation: number,
): Coordinate {
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);

  return [
    resolution * (pixelDelta[0] * cosine + pixelDelta[1] * sine),
    resolution * (pixelDelta[0] * sine - pixelDelta[1] * cosine),
  ];
}

/** Updates contextual route cursor classes without overriding the busy cursor. */
function updateRouteEditCursor(
  map: Map,
  hoverTarget: RouteHoverTarget | null,
  isDragging: boolean,
): void {
  const target = map.getTargetElement();
  target.classList.toggle(
    'map--route-waypoint-hover',
    hoverTarget === 'waypoint' && !isDragging,
  );
  target.classList.toggle(
    'map--route-segment-hover',
    hoverTarget === 'segment' && !isDragging,
  );
  target.classList.toggle('map--route-edit-dragging', isDragging);
}

/**
 * Returns the route waypoint under one screen pixel, ignoring the route line.
 * @param map - OpenLayers map that owns the route layer.
 * @param display - Route display whose waypoint features may be selected.
 * @param pixel - Screen pixel from an OpenLayers browser event.
 * @param hitTolerance - Additional pointer tolerance in screen pixels.
 */
export function getRouteWaypointIndexAtPixel(
  map: Map,
  display: RouteDisplay,
  pixel: Pixel,
  hitTolerance = ROUTE_WAYPOINT_HIT_TOLERANCE_PX,
): number | null {
  const encodedWaypointIndex = map.forEachFeatureAtPixel(
    pixel,
    (feature) => {
      const waypointIndex = getRouteWaypointIndex(feature as Feature);
      // OpenLayers stops on a truthy callback result. Encoding the index keeps
      // waypoint zero selectable instead of treating it like "not found".
      return waypointIndex === null ? undefined : waypointIndex + 1;
    },
    {
      hitTolerance,
      layerFilter: (layer) => layer === display.layer,
    },
  );

  return encodedWaypointIndex === undefined
    ? null
    : encodedWaypointIndex - 1;
}

/**
 * Returns the closest stored incoming section under one screen pixel.
 *
 * The calculation uses immutable step geometry rather than the flattened
 * display feature so the caller knows exactly where a new waypoint belongs.
 * Existing waypoint hit detection should run first because points take
 * precedence over the line around section endpoints.
 *

 * @param steps - Current immutable route steps.
 * @param closure - Optional final section from the last waypoint to the first.
 * @param pixel - Screen pixel from an OpenLayers browser event.
 * @param hitTolerance - Maximum distance from the visible route in pixels.
 */
export function getRouteSegmentHitAtPixel(
  map: Map,
  steps: RouteStep[],
  closure: RouteClosure | null,
  pixel: Pixel,
  hitTolerance = ROUTE_SEGMENT_HIT_TOLERANCE_PX,
): RouteSegmentHit | null {
  const pointerCoordinate = map.getCoordinateFromPixel(pixel);
  const resolution = map.getView().getResolution();

  if (!pointerCoordinate || resolution === undefined || resolution <= 0) {
    return null;
  }

  const toleranceSquared = (resolution * hitTolerance) ** 2;
  const overlapTieToleranceSquared =
    (resolution * ROUTE_SEGMENT_OVERLAP_TIE_TOLERANCE_PX) ** 2;
  let closestHit: RouteSegmentHit | null = null;
  let closestDistanceSquared = Number.POSITIVE_INFINITY;

  const inspectSegment = (segment: Coordinate[], stepIndex: number) => {
    for (
      let coordinateIndex = 1;
      coordinateIndex < segment.length;
      coordinateIndex += 1
    ) {
      const candidate = getClosestPointOnSegment(
        pointerCoordinate,
        segment[coordinateIndex - 1],
        segment[coordinateIndex],
      );

      const distanceDifference =
        candidate.distanceSquared - closestDistanceSquared;
      const isCloser = distanceDifference < -overlapTieToleranceSquared;
      const isVisuallyOverlapping =
        Math.abs(distanceDifference) <= overlapTieToleranceSquared;
      const isMoreRecentOverlappingSection =
        isVisuallyOverlapping &&
        closestHit !== null &&
        stepIndex > closestHit.stepIndex;

      if (isCloser || isMoreRecentOverlappingSection) {
        closestDistanceSquared = candidate.distanceSquared;
        closestHit = {
          stepIndex,
          coordinate: candidate.coordinate,
        };
      }
    }
  };

  for (let stepIndex = 1; stepIndex < steps.length; stepIndex += 1) {
    const segment = steps[stepIndex].segment;

    if (segment && segment.length >= 2) {
      inspectSegment(segment, stepIndex);
    }
  }

  if (closure?.segment && closure.segment.length >= 2) {
    inspectSegment(closure.segment, steps.length);
  }

  return closestDistanceSquared <= toleranceSquared ? closestHit : null;
}

/**
 * Creates one interaction for moving waypoints or pulling a new point from a
 * stored route section.
 *
 * The interaction owns no route data. During dragging it reports coordinates
 * to the application, which draws a temporary straight preview and performs
 * network recalculation only after release. A genuine drag held near a viewport
 * edge moves the view through a frame-rate-independent auto-pan loop while the
 * preview remains attached to the pointer. Mouse and pen presses may select
 * waypoints or sections. A finger may also select a section when the gesture
 * starts very close to the displayed itinerary; gestures starting elsewhere
 * remain available to OpenLayers map navigation. A touch tap on a waypoint is
 * reported separately so deletion does not require a temporary drag preview.
 * Returning `true` on pointer down prevents DragPan from moving the map beneath
 * an active edit.
 */
export function createRouteDragInteraction(
  display: RouteDisplay,
  callbacks: RouteDragCallbacks,
): PointerInteraction {
  let dragTarget: RouteDragTarget | null = null;
  let startPixel: Pixel | null = null;
  let maximumPixelDistanceSquared = 0;
  let isDragging = false;
  let isTouchInteraction = false;
  let hasStartedEdit = false;
  let latestDragPixel: Pixel | null = null;
  let latestDragCoordinate: Coordinate | null = null;
  let autoPanMap: Map | null = null;
  let autoPanFrameId: number | null = null;
  let autoPanPreviousTimestamp: number | null = null;

  const stopAutoPan = () => {
    if (autoPanFrameId !== null) {
      window.cancelAnimationFrame(autoPanFrameId);
    }

    autoPanMap = null;
    autoPanFrameId = null;
    autoPanPreviousTimestamp = null;
  };

  const resetDragState = () => {
    stopAutoPan();
    dragTarget = null;
    startPixel = null;
    maximumPixelDistanceSquared = 0;
    isDragging = false;
    isTouchInteraction = false;
    hasStartedEdit = false;
    latestDragPixel = null;
    latestDragCoordinate = null;
  };

  /**
   * Resolves a release coordinate from the latest drag sample. Auto-pan updates
   * that sample even while the physical pointer is stationary, so relying only
   * on the final browser event could commit the pre-pan map position.
   *
   * @param map - Map whose current resolution and rotation convert pixel movement.
   * @param pixel - Final pointer pixel reported by OpenLayers.
   * @param fallbackCoordinate - Browser-event coordinate used before any drag sample.
   * @returns Map coordinate that includes every applied auto-pan displacement.
   */
  const resolveReleaseCoordinate = (
    map: Map,
    pixel: Pixel,
    fallbackCoordinate: Coordinate,
  ): Coordinate => {
    if (!latestDragPixel || !latestDragCoordinate) {
      return [...fallbackCoordinate];
    }

    const view = map.getView();
    const resolution = view.getResolution();

    if (resolution === undefined || resolution <= 0) {
      return [...latestDragCoordinate];
    }

    const pixelDelta: Pixel = [
      pixel[0] - latestDragPixel[0],
      pixel[1] - latestDragPixel[1],
    ];
    const mapDelta = screenPixelDeltaToMapDelta(
      pixelDelta,
      resolution,
      view.getRotation(),
    );

    return [
      latestDragCoordinate[0] + mapDelta[0],
      latestDragCoordinate[1] + mapDelta[1],
    ];
  };

  let interaction: PointerInteraction;

  /**
   * Advances edge auto-pan by one animation frame and updates the straight
   * preview with the centre delta actually accepted by the constrained view.
   *
   * @param timestamp - High-resolution animation timestamp in milliseconds.
   */
  const runAutoPanFrame = (timestamp: number) => {
    autoPanFrameId = null;

    if (
      !interaction.getActive() ||
      !autoPanMap ||
      !dragTarget ||
      !isDragging ||
      !hasStartedEdit ||
      !latestDragPixel ||
      !latestDragCoordinate
    ) {
      stopAutoPan();
      return;
    }

    const size = autoPanMap.getSize();

    if (!size) {
      stopAutoPan();
      return;
    }

    const velocity = getRouteDragAutoPanVelocity(latestDragPixel, size);

    if (velocity[0] === 0 && velocity[1] === 0) {
      stopAutoPan();
      return;
    }

    if (autoPanPreviousTimestamp !== null) {
      const elapsedSeconds = Math.min(
        ROUTE_DRAG_AUTO_PAN_MAX_FRAME_SECONDS,
        Math.max(0, timestamp - autoPanPreviousTimestamp) / 1_000,
      );
      const view = autoPanMap.getView();
      const resolution = view.getResolution();
      const center = view.getCenter();

      if (resolution === undefined || resolution <= 0 || !center) {
        stopAutoPan();
        return;
      }

      if (elapsedSeconds > 0) {
        const requestedDelta = screenPixelDeltaToMapDelta(
          [velocity[0] * elapsedSeconds, velocity[1] * elapsedSeconds],
          resolution,
          view.getRotation(),
        );
        const previousCenter: Coordinate = [...center];

        view.setCenter([
          previousCenter[0] + requestedDelta[0],
          previousCenter[1] + requestedDelta[1],
        ]);

        const appliedCenter = view.getCenter();

        if (!appliedCenter) {
          stopAutoPan();
          return;
        }

        const appliedDelta: Coordinate = [
          appliedCenter[0] - previousCenter[0],
          appliedCenter[1] - previousCenter[1],
        ];

        // The preview follows the coordinate under the stationary pointer.
        // Reusing the center delta avoids waiting for OpenLayers to render a
        // new pixel-to-coordinate transform before the next animation frame.
        if (appliedDelta[0] !== 0 || appliedDelta[1] !== 0) {
          latestDragCoordinate = [
            latestDragCoordinate[0] + appliedDelta[0],
            latestDragCoordinate[1] + appliedDelta[1],
          ];
          callbacks.onDrag(dragTarget, [...latestDragCoordinate]);
        } else {
          // The configured map extent rejected further movement. Keeping an
          // animation loop alive at the boundary would waste one frame forever.
          stopAutoPan();
          return;
        }
      }
    }

    autoPanPreviousTimestamp = timestamp;
    autoPanFrameId = window.requestAnimationFrame(runAutoPanFrame);
  };

  /**
   * Starts, continues, or stops edge auto-pan for the latest drag sample.
   *
   * @param map - OpenLayers map currently owning the pointer interaction.
   */
  const updateAutoPan = (map: Map) => {
    if (
      !isDragging ||
      !hasStartedEdit ||
      !latestDragPixel ||
      !latestDragCoordinate
    ) {
      stopAutoPan();
      return;
    }

    const size = map.getSize();

    if (!size) {
      stopAutoPan();
      return;
    }

    const velocity = getRouteDragAutoPanVelocity(latestDragPixel, size);

    if (velocity[0] === 0 && velocity[1] === 0) {
      stopAutoPan();
      return;
    }

    autoPanMap = map;

    if (autoPanFrameId === null) {
      autoPanPreviousTimestamp = null;
      autoPanFrameId = window.requestAnimationFrame(runAutoPanFrame);
    }
  };

  interaction = new PointerInteraction({
    handleDownEvent: (event: MapBrowserEvent) => {
      const pointerType = (event.originalEvent as PointerEvent).pointerType;

      if (!callbacks.canStart()) {
        return false;
      }

      isTouchInteraction = pointerType === 'touch';
      const waypointIndex = getRouteWaypointIndexAtPixel(
        event.map,
        display,
        event.pixel,
        isTouchInteraction
          ? ROUTE_TOUCH_WAYPOINT_HIT_TOLERANCE_PX
          : ROUTE_WAYPOINT_HIT_TOLERANCE_PX,
      );

      if (waypointIndex !== null) {
        const step = callbacks.getRouteState().steps[waypointIndex];

        if (!step) {
          resetDragState();
          return false;
        }

        dragTarget = {
          type: 'waypoint',
          waypointIndex,
          coordinate: [...step.waypoint],
        };
      } else {
        const routeState = callbacks.getRouteState();
        const segmentHit = getRouteSegmentHitAtPixel(
          event.map,
          routeState.steps,
          routeState.closure,
          event.pixel,
          isTouchInteraction
            ? ROUTE_TOUCH_SEGMENT_HIT_TOLERANCE_PX
            : ROUTE_SEGMENT_HIT_TOLERANCE_PX,
        );

        if (!segmentHit) {
          resetDragState();
          return false;
        }

        dragTarget = {
          type: 'segment',
          stepIndex: segmentHit.stepIndex,
          coordinate: [...segmentHit.coordinate],
        };
      }

      startPixel = [...event.pixel];
      maximumPixelDistanceSquared = 0;
      isDragging = false;
      hasStartedEdit = !isTouchInteraction;
      callbacks.onHover(null, null);
      updateRouteEditCursor(event.map, dragTarget.type, false);

      // Touch waits for a deliberate movement before showing a preview. This
      // prevents a simple tap or normal finger tremor from looking like an edit.
      if (hasStartedEdit) {
        callbacks.onStart(dragTarget);
      }

      return true;
    },
    handleDragEvent: (event: MapBrowserEvent) => {
      if (!dragTarget) {
        return;
      }

      if (isTouchInteraction && interaction.getPointerCount() > 1) {
        const cancelledTarget = dragTarget;

        // A second finger changes the gesture into map navigation. Restore any
        // preview already shown and let OpenLayers PinchZoom continue normally.
        if (hasStartedEdit) {
          callbacks.onCancel(cancelledTarget);
        }

        resetDragState();
        callbacks.onHover(null, null);
        updateRouteEditCursor(event.map, null, false);
        return;
      }

      if (startPixel) {
        const deltaX = event.pixel[0] - startPixel[0];
        const deltaY = event.pixel[1] - startPixel[1];
        maximumPixelDistanceSquared = Math.max(
          maximumPixelDistanceSquared,
          deltaX * deltaX + deltaY * deltaY,
        );

        if (
          !isDragging &&
          maximumPixelDistanceSquared >=
            (isTouchInteraction
              ? ROUTE_TOUCH_EDIT_DRAG_DISTANCE_PX
              : ROUTE_EDIT_DRAG_DISTANCE_PX) ** 2
        ) {
          isDragging = true;
          updateRouteEditCursor(event.map, null, true);

          if (!hasStartedEdit) {
            hasStartedEdit = true;
            callbacks.onStart(dragTarget);
          }
        }
      }

      if (hasStartedEdit) {
        latestDragPixel = [...event.pixel];
        latestDragCoordinate = [...event.coordinate];
        callbacks.onDrag(dragTarget, [...latestDragCoordinate]);
        updateAutoPan(event.map);
      }
    },
    handleMoveEvent: (event: MapBrowserEvent) => {
      const pointerType = (event.originalEvent as PointerEvent).pointerType;

      if (
        !callbacks.canStart() ||
        (pointerType && pointerType !== 'mouse' && pointerType !== 'pen')
      ) {
        callbacks.onHover(null, null);
        updateRouteEditCursor(event.map, null, false);
        return;
      }

      const waypointIndex = getRouteWaypointIndexAtPixel(
        event.map,
        display,
        event.pixel,
      );
      const segmentHit =
        waypointIndex === null
          ? (() => {
              const routeState = callbacks.getRouteState();
              return getRouteSegmentHitAtPixel(
                event.map,
                routeState.steps,
                routeState.closure,
                event.pixel,
              );
            })()
          : null;

      const hoverTarget: RouteHoverTarget | null =
        waypointIndex !== null
          ? 'waypoint'
          : segmentHit !== null
            ? 'segment'
            : null;

      callbacks.onHover(
        hoverTarget,
        hoverTarget ? [...event.pixel] : null,
      );
      updateRouteEditCursor(event.map, hoverTarget, false);
    },
    handleUpEvent: (event: MapBrowserEvent) => {
      if (!dragTarget) {
        return false;
      }

      if (isTouchInteraction && interaction.getPointerCount() > 0) {
        const cancelledTarget = dragTarget;

        // A remaining pointer means this release belongs to a multi-touch
        // gesture, even when no pinch movement occurred before the first lift.
        if (hasStartedEdit) {
          callbacks.onCancel(cancelledTarget);
        }

        resetDragState();
        callbacks.onHover(null, null);
        updateRouteEditCursor(event.map, null, false);
        return false;
      }

      const releasedTarget = dragTarget;
      const didDrag =
        maximumPixelDistanceSquared >=
        (isTouchInteraction
          ? ROUTE_TOUCH_EDIT_DRAG_DISTANCE_PX
          : ROUTE_EDIT_DRAG_DISTANCE_PX) ** 2;
      const shouldReportTouchWaypointTap =
        isTouchInteraction &&
        releasedTarget.type === 'waypoint' &&
        !didDrag &&
        !hasStartedEdit;
      const shouldReportRelease = hasStartedEdit;
      const releaseCoordinate = resolveReleaseCoordinate(
        event.map,
        event.pixel,
        event.coordinate,
      );

      resetDragState();
      callbacks.onHover(null, null);
      updateRouteEditCursor(event.map, null, false);

      if (shouldReportTouchWaypointTap) {
        callbacks.onTapWaypoint(releasedTarget, [...event.pixel]);
      } else if (shouldReportRelease) {
        callbacks.onEnd(
          releasedTarget,
          releaseCoordinate,
          didDrag,
          [...event.pixel],
        );
      }

      return false;
    },
    stopDown: (handled) => handled,
  });

  interaction.on('change:active', () => {
    if (!interaction.getActive()) {
      resetDragState();
    }
  });

  return interaction;
}

/** Removes cursor state if route editing is left during an active drag. */
export function clearRouteDragCursor(map: Map): void {
  updateRouteEditCursor(map, null, false);
}
