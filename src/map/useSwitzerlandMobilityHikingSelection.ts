/**
 * Business context: owns selection of one public SwitzerlandMobility hiking
 * route after a map click. It resolves overlapping candidates, retrieves and
 * highlights the complete public geometry, replaces the previous itinerary only
 * after that geometry is validated, frames it above the compact bottom panel,
 * and calculates Via Helvetica's own distance, elevation, duration, and
 * synchronized profile without mixing these lifecycles into the root component.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import type { Size } from 'ol/size.js';
import {
  calculateRouteSegmentsDistance,
  estimateHikingDuration,
  fetchRouteSegmentsElevationSummary,
  type RouteElevationStatus,
  type RouteElevationSummary,
} from '../metrics/routeMetrics';
import { isAbortedRequest } from '../network/abort';
import {
  fetchSwitzerlandMobilityHikingRoute,
  identifySwitzerlandMobilityHikingRoutes,
  type SwitzerlandMobilityHikingIdentifyContext,
  type SwitzerlandMobilityHikingRoute,
  type SwitzerlandMobilityHikingRouteCandidate,
} from '../switzerlandMobility/hikingRoutes';
import { IMPORTED_ROUTE_MAX_ZOOM } from './config';
import type { MapRuntime } from './mapRuntime';
import { updateSwitzerlandMobilityHikingSelection } from './switzerlandMobilityHikingSelection';
import {
  useRouteProfileSynchronization,
} from './useRouteProfileSynchronization';
import { calculateResponsiveMapFitPadding } from './viewFit';

/** Panel state shown while complete public geometry is being retrieved. */
export interface SwitzerlandMobilityHikingLoadingStatus {
  /** Discriminant for geometry loading. */
  state: 'loading';
  /** Candidate whose full geometry is being loaded. */
  candidate: SwitzerlandMobilityHikingRouteCandidate;
}

/** Panel state shown once geometry is available and highlighted. */
export interface SwitzerlandMobilityHikingReadyStatus {
  /** Discriminant for a selected route. */
  state: 'ready';
  /** Complete selected route and localized public metadata. */
  route: SwitzerlandMobilityHikingRoute;
  /** Horizontal route length calculated by Via Helvetica in metres. */
  distanceMeters: number;
  /** Availability state of elevation-dependent figures. */
  elevationStatus: RouteElevationStatus;
  /** Elevation totals and samples when GeoAdmin profiling succeeds. */
  elevation: RouteElevationSummary | null;
  /** Via Helvetica walking-time estimate in minutes when elevation is ready. */
  durationMinutes: number | null;
}

/** Panel state shown when route metadata or geometry cannot be retrieved. */
export interface SwitzerlandMobilityHikingErrorStatus {
  /** Discriminant for a failed public-route request. */
  state: 'error';
  /** Candidate known before the failure, when identification succeeded. */
  candidate: SwitzerlandMobilityHikingRouteCandidate | null;
}

/** Complete set of states rendered by the compact public-route panel. */
export type SwitzerlandMobilityHikingPanelStatus =
  | SwitzerlandMobilityHikingLoadingStatus
  | SwitzerlandMobilityHikingReadyStatus
  | SwitzerlandMobilityHikingErrorStatus;

/** Inputs required by the public hiking-route selection workflow. */
export interface UseSwitzerlandMobilityHikingSelectionOptions {
  /** Stable ref containing the mounted OpenLayers runtime. */
  mapRuntimeRef: RefObject<MapRuntime | null>;
  /** Current language requested for public route titles. */
  language: SwitzerlandMobilityHikingIdentifyContext['language'];
  /** Clears temporary search context when a public route is selected. */
  onInformationSelected: () => void;
  /** Replaces the current itinerary once complete public geometry is usable. */
  onRouteAccepted: () => void;
}

/** State and actions consumed by the information-layer coordinator and panel. */
export interface SwitzerlandMobilityHikingSelectionController {
  /** Current compact panel state, or `null` when no route is selected. */
  panelStatus: SwitzerlandMobilityHikingPanelStatus | null;
  /** Identifies lightweight public-route candidates without changing selection UI. */
  identifyCandidatesAt: (
    context: SwitzerlandMobilityHikingIdentifyContext,
    signal: AbortSignal,
  ) => Promise<SwitzerlandMobilityHikingRouteCandidate[]>;
  /** Shows the existing public-route identify error state without retrying identification. */
  showIdentifyError: () => void;
  /** Selects one candidate supplied by the common map-information chooser. */
  selectCandidate: (
    candidate: SwitzerlandMobilityHikingRouteCandidate,
  ) => void;
  /** Cumulative distance selected by hovering the public route on the map. */
  mapHoverDistanceMeters: number | null;
  /** Mirrors public-route profile distance onto the shared map marker. */
  handleProfileHoverDistanceChange: (distanceMeters: number | null) => void;
  /** Cancels pending work and clears the panel and vector highlight. */
  closeSelection: () => void;
  /** Closes the explicit panel without changing the user's current map view. */
  dismissSelection: () => void;
}

/** Fit animation duration in milliseconds, matching imported GPX framing. */
const SELECTION_FIT_DURATION_MS = 600;

/**
 * Desired view padding in CSS pixels. It matches GPX framing: 80 px protects
 * endpoints from the search field and right-side controls, while 180 px keeps
 * the route above the compact information panel.
 */
const SELECTION_FIT_PADDING_PX: [number, number, number, number] = [
  80,
  80,
  180,
  80,
];

/** Minimum map width and height in pixels left to display selected geometry. */
const SELECTION_MIN_FIT_AREA_PX = 160;

/** Stable empty geometry keeps the shared profile hook dormant between selections. */
const EMPTY_ROUTE_SEGMENTS: SwitzerlandMobilityHikingRoute['segments'] = [];

/**
 * Compares provider feature identifiers without depending on whether GeoAdmin
 * serialized the numeric identifier as a string or a number.
 *
 * @param left - First public-route candidate or selected route.
 * @param right - Second public-route candidate or selected route.
 * @returns `true` when both values refer to the same GeoAdmin feature.
 */
export function isSameSwitzerlandMobilityHikingFeature(
  left: Pick<SwitzerlandMobilityHikingRouteCandidate, 'featureId'> | null,
  right: Pick<SwitzerlandMobilityHikingRouteCandidate, 'featureId'> | null,
): boolean {
  return Boolean(
    left &&
      right &&
      String(left.featureId) === String(right.featureId),
  );
}

/**
 * Adapts public-route framing margins to small and landscape mobile viewports.
 *
 * @param size - Current OpenLayers viewport size in CSS pixels.
 * @returns Top, right, bottom, and left padding safe for the current viewport.
 */
export function calculateSwitzerlandMobilityHikingFitPadding(
  size: Size,
): [number, number, number, number] {
  return calculateResponsiveMapFitPadding(
    size,
    SELECTION_FIT_PADDING_PX,
    SELECTION_MIN_FIT_AREA_PX,
  );
}

/**
 * Owns public-route identification, highlighting, metrics, profile linking, and stale-result guards.
 *
 * @param options - Runtime, language, and cross-workflow selection callback.
 * @returns Panel state plus candidate identification, selection, and close actions.
 */
export function useSwitzerlandMobilityHikingSelection(
  options: UseSwitzerlandMobilityHikingSelectionOptions,
): SwitzerlandMobilityHikingSelectionController {
  const selectionSessionRef = useRef(0);
  const routeRequestRef = useRef<AbortController | null>(null);
  // The last ready route is retained while its panel remains active so a
  // transient identify failure can restore validated information without a
  // redundant geometry and elevation request.
  const readySelectionRef =
    useRef<SwitzerlandMobilityHikingReadyStatus | null>(null);
  const [panelStatus, setPanelStatus] =
    useState<SwitzerlandMobilityHikingPanelStatus | null>(null);
  const selectedRouteSegments =
    panelStatus?.state === 'ready'
      ? panelStatus.route.segments
      : EMPTY_ROUTE_SEGMENTS;
  const {
    mapHoverDistanceMeters,
    handleProfileHoverDistanceChange,
    clearProfileHover,
  } = useRouteProfileSynchronization({
    mapRuntimeRef: options.mapRuntimeRef,
    routeSegments: selectedRouteSegments,
    isEnabled: panelStatus?.state === 'ready',
  });

  /** Clears selection state and invalidates both geometry and elevation results. */
  const clearSelection = useCallback(() => {
    selectionSessionRef.current += 1;
    routeRequestRef.current?.abort();
    routeRequestRef.current = null;
    readySelectionRef.current = null;
    clearProfileHover();
    setPanelStatus(null);

    const display =
      options.mapRuntimeRef.current?.switzerlandMobilityHikingSelectionDisplay;

    if (display) {
      updateSwitzerlandMobilityHikingSelection(display, null);
    }
  }, [clearProfileHover, options.mapRuntimeRef]);

  /** Clears a selection because another workflow took priority. */
  const closeSelection = useCallback(() => {
    clearSelection();
  }, [clearSelection]);

  /**
   * Closes the explicit public-route panel without moving the map again. The
   * automatic fit is a useful navigation action in its own right, so dismissing
   * the information must not unexpectedly undo the user's current context.
   */
  const dismissSelection = closeSelection;

  /**
   * Loads, highlights, frames, and measures one candidate. Geometry appears
   * before elevation lookup completes so the selection remains immediately useful.
   *
   * @param candidate - Identified public route chosen directly or in the common map-information chooser.
   */
  const selectCandidate = useCallback(
    (candidate: SwitzerlandMobilityHikingRouteCandidate) => {
      const runtime = options.mapRuntimeRef.current;

      if (!runtime) {
        return;
      }

      const readySelection = readySelectionRef.current;

      if (
        readySelection &&
        isSameSwitzerlandMobilityHikingFeature(
          readySelection.route,
          candidate,
        )
      ) {
        // Identification still runs to discover overlapping routes at the new
        // click position, but an unchanged final choice can reuse the complete
        // geometry, metrics, and profile already held in memory.
        selectionSessionRef.current += 1;
        routeRequestRef.current?.abort();
        routeRequestRef.current = null;
        setPanelStatus(readySelection);
        return;
      }

      clearProfileHover();

      const selectionSession = ++selectionSessionRef.current;
      routeRequestRef.current?.abort();
      const request = new AbortController();
      routeRequestRef.current = request;
      setPanelStatus({ state: 'loading', candidate });

      void (async () => {
        try {
          const route = await fetchSwitzerlandMobilityHikingRoute(
            candidate,
            options.language,
            request.signal,
          );

          if (
            request.signal.aborted ||
            selectionSession !== selectionSessionRef.current
          ) {
            return;
          }

          const extent = updateSwitzerlandMobilityHikingSelection(
            runtime.switzerlandMobilityHikingSelectionDisplay,
            route,
          );
          const distanceMeters = calculateRouteSegmentsDistance(route.segments);

          if (!extent || distanceMeters <= 0) {
            throw new Error(
              'SwitzerlandMobility route has no measurable selected geometry.',
            );
          }

          // A public route becomes the single current itinerary only after its
          // complete geometry has been validated. A failed provider request must
          // therefore leave the user's previous GPX or editable route untouched.
          options.onRouteAccepted();

          const loadingElevationStatus: SwitzerlandMobilityHikingReadyStatus = {
            state: 'ready',
            route,
            distanceMeters,
            elevationStatus: 'loading',
            elevation: null,
            durationMinutes: null,
          };
          // Cache only a stable profile outcome. Re-selecting while elevation
          // is still loading may legitimately restart the complete request.
          readySelectionRef.current = null;
          setPanelStatus(loadingElevationStatus);

          runtime.map.updateSize();
          const size = runtime.map.getSize();

          if (size && size[0] > 0 && size[1] > 0) {
            runtime.map.getView().fit(extent, {
              size,
              duration: SELECTION_FIT_DURATION_MS,
              maxZoom: IMPORTED_ROUTE_MAX_ZOOM,
              padding: calculateSwitzerlandMobilityHikingFitPadding(size),
            });
          }

          try {
            const elevation = await fetchRouteSegmentsElevationSummary(
              route.segments,
              request.signal,
            );

            if (
              request.signal.aborted ||
              selectionSession !== selectionSessionRef.current
            ) {
              return;
            }

            const readyStatus: SwitzerlandMobilityHikingReadyStatus = {
              state: 'ready',
              route,
              distanceMeters,
              elevationStatus: 'ready',
              elevation,
              durationMinutes: estimateHikingDuration(elevation.points),
            };
            readySelectionRef.current = readyStatus;
            setPanelStatus(readyStatus);
          } catch (error: unknown) {
            if (
              isAbortedRequest(error, request.signal) ||
              selectionSession !== selectionSessionRef.current
            ) {
              return;
            }

            // Geometry and distance remain useful even when the optional profile
            // service is temporarily unavailable.
            console.error(
              'Unable to load SwitzerlandMobility route elevations.',
              error,
            );
            const elevationErrorStatus: SwitzerlandMobilityHikingReadyStatus = {
              state: 'ready',
              route,
              distanceMeters,
              elevationStatus: 'error',
              elevation: null,
              durationMinutes: null,
            };
            readySelectionRef.current = elevationErrorStatus;
            setPanelStatus(elevationErrorStatus);
          }
        } catch (error: unknown) {
          if (
            isAbortedRequest(error, request.signal) ||
            selectionSession !== selectionSessionRef.current
          ) {
            return;
          }

          console.error(
            'Unable to load the selected SwitzerlandMobility hiking route.',
            error,
          );
          const previousSelection = readySelectionRef.current;

          if (previousSelection) {
            // A failed alternate choice must not destroy the route that was
            // already validated and displayed before the new request.
            updateSwitzerlandMobilityHikingSelection(
              runtime.switzerlandMobilityHikingSelectionDisplay,
              previousSelection.route,
            );
            setPanelStatus(previousSelection);
          } else {
            updateSwitzerlandMobilityHikingSelection(
              runtime.switzerlandMobilityHikingSelectionDisplay,
              null,
            );
            setPanelStatus({ state: 'error', candidate });
          }
        } finally {
          if (routeRequestRef.current === request) {
            routeRequestRef.current = null;
          }
        }
      })();
    },
    [
      clearProfileHover,
      options.language,
      options.mapRuntimeRef,
      options.onRouteAccepted,
    ],
  );

  /**
   * Identifies public-route candidates without taking ownership of the panel.
   * The shared map-information coordinator uses this to combine route matches
   * with safety and public-transport candidates from the same click.
   *
   * @param context - Click coordinate and current map rendering context.
   * @param signal - Abort signal owned by the map-information click pipeline.
   * @returns Distinct lightweight public-route candidates at the click position.
   */
  const identifyCandidatesAt = useCallback(
    (
      context: SwitzerlandMobilityHikingIdentifyContext,
      signal: AbortSignal,
    ) => identifySwitzerlandMobilityHikingRoutes(context, signal),
    [],
  );

  /**
   * Presents a public-route identify failure without starting another provider
   * request. A previously validated route remains usable on transient failures.
   */
  const showIdentifyError = useCallback(() => {
    options.onInformationSelected();
    const readySelection = readySelectionRef.current;

    if (readySelection) {
      setPanelStatus(readySelection);
      return;
    }

    clearProfileHover();
    setPanelStatus({ state: 'error', candidate: null });
  }, [clearProfileHover, options.onInformationSelected]);


  useEffect(
    () => () => {
      selectionSessionRef.current += 1;
      routeRequestRef.current?.abort();
    },
    [],
  );

  return {
    panelStatus,
    identifyCandidatesAt,
    showIdentifyError,
    selectCandidate,
    mapHoverDistanceMeters,
    handleProfileHoverDistanceChange,
    closeSelection,
    dismissSelection,
  };
}
