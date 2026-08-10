/**
 * Business context: renders the route currently edited by the user as a small
 * OpenLayers vector layer. It converts immutable route state into the red line,
 * waypoint, endpoint, direction, and temporary drag-preview features shown on
 * the map, without owning route history or pointer interaction lifecycle.
 */
import type { Coordinate } from 'ol/coordinate.js';
import Feature from 'ol/Feature.js';
import LineString from 'ol/geom/LineString.js';
import Point from 'ol/geom/Point.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import {
  Circle as CircleStyle,
  Fill,
  Stroke,
  Style,
} from 'ol/style.js';
import { createDirectionalLineStyle } from './itineraryDirection';
import {
  collectRouteCoordinates,
  coordinateDistanceSquared,
  type RouteClosure,
  type RouteStep,
} from './routeState';
import {
  createItineraryEndpointFeatures,
  ITINERARY_ENDPOINT_ROLE_PROPERTY,
  type ItineraryEndpointRole,
} from './itineraryEndpoints';

/** OpenLayers resources used to render the current route. */
export interface RouteDisplay {
  /** Vector layer inserted above map tiles and below transient markers. */
  layer: VectorLayer<VectorSource>;
  /** Mutable feature source rebuilt whenever immutable route history changes. */
  source: VectorSource;
}

/** Swiss-red route colour chosen to stay distinct from blue hydrography. */
const ROUTE_COLOR = '#d52b1e';
/** Feature property shared with pointer hit detection for indexed waypoints. */
const ROUTE_WAYPOINT_INDEX_PROPERTY = 'routeWaypointIndex';
/**
 * Minimum screen-space separation between ordinary waypoint handles at detailed
 * planning scales. The route state keeps every anchor; only presentation is
 * thinned so a long imported GPX stays editable without covering the map.
 */
const ROUTE_VISIBLE_WAYPOINT_SEPARATION_PX = 32;
/**
 * Broader regional views reserve more room between handles so direction arrows
 * can remain legible instead of competing with a dense chain of waypoint circles.
 */
const ROUTE_BROAD_SCALE_WAYPOINT_SEPARATION_PX = 56;
/** Resolution in metres per pixel where the broader handle spacing is fully used. */
const ROUTE_BROAD_SCALE_WAYPOINT_RESOLUTION = 20;
/** Small manually created routes keep every handle visible regardless of scale. */
const ROUTE_WAYPOINT_DECLUTTER_MIN_COUNT = 20;
/** Resolution changes below this relative threshold reuse the prior waypoint selection. */
const WAYPOINT_VISIBILITY_RESOLUTION_EPSILON = 1e-9;

/**
 * Returns the screen-space separation used for waypoint decluttering.
 * Detailed views keep handles compact for precise editing, while broader views
 * progressively open gaps that can be reused by direction arrows.
 */
function getVisibleWaypointSeparationPx(resolution: number): number {
  const interpolation = Math.min(
    1,
    Math.max(0, resolution / ROUTE_BROAD_SCALE_WAYPOINT_RESOLUTION),
  );

  return (
    ROUTE_VISIBLE_WAYPOINT_SEPARATION_PX +
    (ROUTE_BROAD_SCALE_WAYPOINT_SEPARATION_PX -
      ROUTE_VISIBLE_WAYPOINT_SEPARATION_PX) *
      interpolation
  );
}

/**
 * Chooses waypoint handles that remain visually distinct at one map resolution.
 * Start, finish, and the actively dragged waypoint always win; all hidden
 * anchors remain in route state and reappear automatically as the user zooms in.
 *
 * @param steps - Complete editable waypoint sequence.
 * @param resolution - Current map resolution in LV95 metres per screen pixel.
 * @param activeWaypointIndex - Optional waypoint that must stay visible during drag.
 * @returns Sorted route indexes whose handles should be rendered and hit-tested.
 */
export function selectVisibleRouteWaypointIndexes(
  steps: RouteStep[],
  resolution: number,
  activeWaypointIndex: number | null = null,
): number[] {
  if (
    steps.length <= ROUTE_WAYPOINT_DECLUTTER_MIN_COUNT ||
    !Number.isFinite(resolution) ||
    resolution <= 0
  ) {
    return steps.map((_step, index) => index);
  }

  const lastIndex = steps.length - 1;
  const minimumDistanceSquared =
    (getVisibleWaypointSeparationPx(resolution) * resolution) ** 2;
  const priorityIndexes = new Set<number>([0, lastIndex]);

  if (
    activeWaypointIndex !== null &&
    activeWaypointIndex > 0 &&
    activeWaypointIndex < lastIndex
  ) {
    priorityIndexes.add(activeWaypointIndex);
  }

  const visibleIndexes = [...priorityIndexes];
  const isFarEnoughFromVisibleWaypoints = (candidateIndex: number): boolean =>
    visibleIndexes.every((visibleIndex) => {
      // Coincident route endpoints are intentionally both retained so A/B
      // semantics do not depend on decluttering.
      if (
        (candidateIndex === 0 && visibleIndex === lastIndex) ||
        (candidateIndex === lastIndex && visibleIndex === 0)
      ) {
        return true;
      }

      return (
        coordinateDistanceSquared(
          steps[candidateIndex].waypoint,
          steps[visibleIndex].waypoint,
        ) >= minimumDistanceSquared
      );
    });

  for (let index = 1; index < lastIndex; index += 1) {
    if (priorityIndexes.has(index) || !isFarEnoughFromVisibleWaypoints(index)) {
      continue;
    }

    visibleIndexes.push(index);
  }

  return visibleIndexes.sort((first, second) => first - second);
}

/**
 * Creates a cached resolution-aware selector shared by waypoint styles and
 * direction-arrow avoidance. Sharing one decision prevents arrows from reserving
 * space around anchors that are intentionally hidden at the current scale.
 */
function createVisibleWaypointIndexResolver(
  steps: RouteStep[],
  activeWaypointIndex: number | null,
): (resolution: number) => ReadonlySet<number> {
  let cachedResolution = Number.NaN;
  let cachedIndexes: ReadonlySet<number> = new Set<number>();

  return (resolution: number): ReadonlySet<number> => {
    if (
      Number.isFinite(cachedResolution) &&
      Math.abs(cachedResolution - resolution) <=
        Math.max(1, Math.abs(resolution)) *
          WAYPOINT_VISIBILITY_RESOLUTION_EPSILON
    ) {
      return cachedIndexes;
    }

    cachedResolution = resolution;
    cachedIndexes = new Set(
      selectVisibleRouteWaypointIndexes(
        steps,
        resolution,
        activeWaypointIndex,
      ),
    );
    return cachedIndexes;
  };
}

/**
 * Route line styles in screen pixels. The 11 px white casing separates the
 * 7 px red centre line from red hiking-trail symbology and dense map details.
 */
const ROUTE_LINE_STYLE = [
  new Style({
    stroke: new Stroke({
      color: 'rgba(255, 255, 255, 0.95)',
      width: 11,
    }),
    zIndex: 0,
  }),
  new Style({
    stroke: new Stroke({
      color: ROUTE_COLOR,
      width: 7,
    }),
    zIndex: 1,
  }),
];

/** Waypoint style in screen pixels; a white centre keeps points readable over the red line. */
const ROUTE_WAYPOINT_STYLE = new Style({
  image: new CircleStyle({
    radius: 6,
    fill: new Fill({
      color: '#ffffff',
    }),
    stroke: new Stroke({
      color: ROUTE_COLOR,
      width: 3,
    }),
  }),
  zIndex: 8,
});

/** The dragged waypoint grows slightly so the active edit remains visible under the pointer. */
const ACTIVE_ROUTE_WAYPOINT_STYLE = new Style({
  image: new CircleStyle({
    radius: 8,
    fill: new Fill({
      color: '#ffffff',
    }),
    stroke: new Stroke({
      color: ROUTE_COLOR,
      width: 4,
    }),
  }),
  zIndex: 9,
});

/**
 * Returns a waypoint index only when the feature belongs to this route display.
 * Pointer interaction uses this accessor instead of depending on the private
 * feature-property name chosen by the renderer.
 * @param feature - Candidate feature returned by OpenLayers hit detection.
 * @returns The stored route index, or `null` for line and unrelated features.
 */
export function getRouteWaypointIndex(feature: Feature): number | null {
  const waypointIndex = feature.get(ROUTE_WAYPOINT_INDEX_PROPERTY);
  return Number.isInteger(waypointIndex) ? (waypointIndex as number) : null;
}

/**
 * Creates the vector layer used for the route currently being edited.
 * @returns Layer/source pair owned by the root map component.
 */
export function createRouteDisplay(): RouteDisplay {
  const source = new VectorSource();
  const layer = new VectorLayer({
    source,
    zIndex: 18,
  });

  return {
    layer,
    source,
  };
}

/**
 * Rebuilds the small route layer from immutable route steps.
 *
 * Keeping history outside OpenLayers makes undo and redo independent from
 * mutable features. Each committed state stores exact generated geometry, so
 * redo does not repeat network requests and cannot produce a different route.
 *
 * @param display - OpenLayers route resources to update in place.
 * @param steps - Current ordered route steps.
 * @param closure - Optional final section from the last waypoint to the first.
 * @param activeWaypointIndex - Optional waypoint highlighted during a drag preview.
 */
export function updateRouteDisplay(
  display: RouteDisplay,
  steps: RouteStep[],
  closure: RouteClosure | null = null,
  activeWaypointIndex: number | null = null,
): void {
  const features: Feature[] = [];
  const routeCoordinates = collectRouteCoordinates(steps, closure);
  const resolveVisibleWaypointIndexes = createVisibleWaypointIndexResolver(
    steps,
    activeWaypointIndex,
  );

  if (routeCoordinates.length >= 2) {
    const line = new Feature({
      geometry: new LineString(routeCoordinates),
    });
    line.setStyle(
      createDirectionalLineStyle({
        lineStyles: ROUTE_LINE_STYLE,
        coordinates: routeCoordinates,
        color: ROUTE_COLOR,
        avoidCoordinates: (resolution) => {
          const visibleIndexes = resolveVisibleWaypointIndexes(resolution);
          return steps
            .filter((_step, waypointIndex) =>
              visibleIndexes.has(waypointIndex),
            )
            .map((step) => step.waypoint);
        },
      }),
    );
    features.push(line);
  }

  steps.forEach((step, waypointIndex) => {
    const waypoint = new Feature({
      geometry: new Point(step.waypoint),
    });
    waypoint.set(ROUTE_WAYPOINT_INDEX_PROPERTY, waypointIndex);
    waypoint.setStyle((_feature, resolution) =>
      resolveVisibleWaypointIndexes(resolution).has(waypointIndex)
        ? waypointIndex === activeWaypointIndex
          ? ACTIVE_ROUTE_WAYPOINT_STYLE
          : ROUTE_WAYPOINT_STYLE
        : [],
    );
    features.push(waypoint);
  });

  const finishCoordinate =
    steps.length >= 2
      ? closure
        ? steps[0].waypoint
        : steps[steps.length - 1].waypoint
      : null;
  const endpointFeatures = createItineraryEndpointFeatures(
    steps[0]?.waypoint ?? null,
    finishCoordinate,
    closure !== null && steps.length >= 2,
  );

  endpointFeatures.forEach((endpointFeature) => {
    const role = endpointFeature.get(
      ITINERARY_ENDPOINT_ROLE_PROPERTY,
    ) as ItineraryEndpointRole;
    endpointFeature.set(
      ROUTE_WAYPOINT_INDEX_PROPERTY,
      role === 'finish' ? steps.length - 1 : 0,
    );
    features.push(endpointFeature);
  });

  display.source.clear();
  display.source.addFeatures(features);
}

/**
 * Draws a fast local preview while a waypoint is dragged.
 *
 * Only the two adjacent sections are replaced with straight lines. The exact
 * route history remains untouched and network routing is deferred until the
 * pointer is released.
 */
export function updateRouteWaypointDragPreview(
  display: RouteDisplay,
  steps: RouteStep[],
  closure: RouteClosure | null,
  waypointIndex: number,
  coordinate: Coordinate,
): void {
  if (waypointIndex < 0 || waypointIndex >= steps.length) {
    updateRouteDisplay(display, steps, closure);
    return;
  }

  const previewCoordinate: Coordinate = [...coordinate];
  const previewSteps = steps.slice();
  const movedStep = steps[waypointIndex];
  const previousStep = steps[waypointIndex - 1];

  previewSteps[waypointIndex] = {
    ...movedStep,
    waypoint: previewCoordinate,
    section: previousStep
      ? {
          origin: 'generated',
          mode: 'straight',
          coordinates: [[...previousStep.waypoint], previewCoordinate],
        }
      : null,
  };

  const nextStep = steps[waypointIndex + 1];

  if (nextStep) {
    previewSteps[waypointIndex + 1] = {
      ...nextStep,
      section: {
        origin: 'generated',
        mode: 'straight',
        coordinates: [previewCoordinate, [...nextStep.waypoint]],
      },
    };
  }

  let previewClosure = closure;

  if (
    closure &&
    steps.length >= 2 &&
    (waypointIndex === 0 || waypointIndex === steps.length - 1)
  ) {
    const firstWaypoint =
      waypointIndex === 0 ? previewCoordinate : previewSteps[0].waypoint;
    const lastWaypoint =
      waypointIndex === steps.length - 1
        ? previewCoordinate
        : previewSteps[previewSteps.length - 1].waypoint;

    previewClosure = {
      origin: 'generated',
      mode: 'straight',
      coordinates: [[...lastWaypoint], [...firstWaypoint]],
    };
  }

  updateRouteDisplay(
    display,
    previewSteps,
    previewClosure,
    waypointIndex,
  );
}

/**
 * Draws a temporary inserted waypoint while a route section is pulled.
 *
 * The selected incoming section is replaced by two straight preview sections.
 * Immutable history and the exact stored geometry remain untouched until the
 * application completes routing after release.
 */
export function updateRouteInsertionDragPreview(
  display: RouteDisplay,
  steps: RouteStep[],
  closure: RouteClosure | null,
  stepIndex: number,
  coordinate: Coordinate,
): void {
  const insertedCoordinate: Coordinate = [...coordinate];

  if (stepIndex === steps.length && closure && steps.length >= 2) {
    const previousStep = steps[steps.length - 1];
    const firstStep = steps[0];
    const insertedStep: RouteStep = {
      waypoint: insertedCoordinate,
      section: {
        origin: 'generated',
        mode: 'straight',
        coordinates: [[...previousStep.waypoint], insertedCoordinate],
      },
    };
    const previewSteps = [...steps, insertedStep];
    const previewClosure: RouteClosure = {
      origin: 'generated',
      mode: 'straight',
      coordinates: [insertedCoordinate, [...firstStep.waypoint]],
    };

    updateRouteDisplay(
      display,
      previewSteps,
      previewClosure,
      steps.length,
    );
    return;
  }

  const destinationStep = steps[stepIndex];
  const previousStep = steps[stepIndex - 1];

  if (!destinationStep || !previousStep || stepIndex < 1) {
    updateRouteDisplay(display, steps, closure);
    return;
  }

  const insertedStep: RouteStep = {
    waypoint: insertedCoordinate,
    section: {
      origin: 'generated',
      mode: 'straight',
      coordinates: [[...previousStep.waypoint], insertedCoordinate],
    },
  };
  const updatedDestinationStep: RouteStep = {
    ...destinationStep,
    section: {
      origin: 'generated',
      mode: 'straight',
      coordinates: [insertedCoordinate, [...destinationStep.waypoint]],
    },
  };
  const previewSteps = [
    ...steps.slice(0, stepIndex),
    insertedStep,
    updatedDestinationStep,
    ...steps.slice(stepIndex + 1),
  ];

  updateRouteDisplay(
    display,
    previewSteps,
    closure,
    stepIndex,
  );
}
