/**
 * Business context: owns the shared statistics and profile exploration for the
 * single current itinerary, whether it is an editable route or an imported GPX.
 * It prevents stale elevation responses from crossing geometry changes and
 * delegates shared map/profile pointer synchronization so temporary public-route
 * inspection can take ownership without changing itinerary state.
 */
import { useEffect, useMemo, useState, type RefObject } from 'react';
import type { Coordinate } from 'ol/coordinate.js';
import type { MapRuntime } from '../map/mapRuntime';
import {
  useRouteProfileSynchronization,
} from '../map/useRouteProfileSynchronization';
import {
  calculateRouteSegmentsDistance,
  estimateHikingDuration,
  fetchRouteElevationSummary,
  fetchRouteSegmentsElevationSummary,
  type RouteElevationStatus,
  type RouteElevationSummary,
} from './routeMetrics';

/** Inputs required to measure and explore the current itinerary. */
export interface UseItineraryMetricsOptions {
  /** Shared runtime containing the map and route-profile marker. */
  mapRuntimeRef: RefObject<MapRuntime | null>;
  /** Flattened editable geometry, empty when a GPX is current. */
  editableRouteCoordinates: Coordinate[];
  /** Independent read-only GPX segments, empty when a route is current. */
  importedRouteSegments: Coordinate[][];
  /** Complete profile derived from embedded GPX elevations when available. */
  importedRouteElevationSummary: RouteElevationSummary | null;
  /** Whether a route drag currently owns pointer movement. */
  isRoutePointerInteractionActive: boolean;
  /** Whether the itinerary currently owns the shared profile marker. */
  isProfileInteractionEnabled: boolean;
  /** Synchronous guard for direct OpenLayers pointer events. */
  isPointerInteractionActive: () => boolean;
  /** Whether a serialized route mutation is still pending. */
  isRouteOperationPending: boolean;
}

/** Statistics and profile-link state consumed by the application shell. */
export interface ItineraryMetricsController {
  /** Current route or independent imported GPX segments. */
  activeRouteSegments: Coordinate[][];
  /** Total horizontal itinerary distance in metres. */
  distanceMeters: number;
  /** Availability state of altitude-dependent figures. */
  elevationStatus: RouteElevationStatus;
  /** Current elevation summary when available. */
  elevation: RouteElevationSummary | null;
  /** Swiss hiking-time estimate in minutes when elevation is available. */
  durationMinutes: number | null;
  /** Cumulative distance selected by hovering the itinerary on the map. */
  mapHoverDistanceMeters: number | null;
  /** Mirrors chart pointer distance onto the shared map marker. */
  handleProfileHoverDistanceChange: (distanceMeters: number | null) => void;
}

/** Delay in milliseconds before requesting elevations after a route mutation. */
const ELEVATION_REQUEST_DEBOUNCE_MS = 250;

/** Elevation result tied by identity to one immutable segment collection. */
interface ElevationRequestResult {
  /** Exact segment array for which the request completed. */
  segments: Coordinate[][];
  /** Ready or failed result state. */
  status: Exclude<RouteElevationStatus, 'loading'>;
  /** Valid summary for a ready result, otherwise null. */
  summary: RouteElevationSummary | null;
}

/**
 * Calculates and explores the current itinerary without owning route mutations.
 *
 * @param options - Current geometry, imported elevations, and pointer guards.
 * @returns Statistics plus bidirectional map/profile hover state.
 */
export function useItineraryMetrics(
  options: UseItineraryMetricsOptions,
): ItineraryMetricsController {
  const [elevationResult, setElevationResult] =
    useState<ElevationRequestResult | null>(null);
  const activeRouteSegments = useMemo(
    () =>
      options.editableRouteCoordinates.length >= 2
        ? [options.editableRouteCoordinates]
        : options.importedRouteSegments,
    [options.editableRouteCoordinates, options.importedRouteSegments],
  );
  const distanceMeters = useMemo(
    () => calculateRouteSegmentsDistance(activeRouteSegments),
    [activeRouteSegments],
  );
  const embeddedImportedElevation =
    options.editableRouteCoordinates.length < 2
      ? options.importedRouteElevationSummary
      : null;
  const currentRequestResult =
    elevationResult?.segments === activeRouteSegments
      ? elevationResult
      : null;
  const elevation = embeddedImportedElevation ?? currentRequestResult?.summary ?? null;
  const elevationStatus: RouteElevationStatus = embeddedImportedElevation
    ? 'ready'
    : currentRequestResult?.status ?? 'loading';
  const durationMinutes = elevation
    ? estimateHikingDuration(elevation.points)
    : null;

  const {
    mapHoverDistanceMeters,
    handleProfileHoverDistanceChange,
  } = useRouteProfileSynchronization({
    mapRuntimeRef: options.mapRuntimeRef,
    routeSegments: activeRouteSegments,
    // Route dragging, pending mutations, and public-route inspection all own
    // the same pointer marker at different times, so only the current itinerary
    // may register its hover listener.
    isEnabled:
      options.isProfileInteractionEnabled &&
      !options.isRoutePointerInteractionActive &&
      !options.isRouteOperationPending,
    isPointerInteractionBlocked: options.isPointerInteractionActive,
  });

  /**
   * Retrieves a fresh elevation profile after geometry settles. The completed
   * result retains the exact segment-array identity, so a late response can
   * never appear beside newer distance or route geometry.
   */
  useEffect(() => {
    if (activeRouteSegments.length === 0 || distanceMeters <= 0) {
      setElevationResult(null);
      return;
    }

    if (embeddedImportedElevation !== null) {
      return;
    }

    const abortController = new AbortController();
    const requestSegments = activeRouteSegments;
    const requestTimer = window.setTimeout(() => {
      const elevationRequest =
        requestSegments.length === 1
          ? fetchRouteElevationSummary(
              requestSegments[0],
              distanceMeters,
              abortController.signal,
            )
          : fetchRouteSegmentsElevationSummary(
              requestSegments,
              abortController.signal,
            );

      void elevationRequest
        .then((summary) => {
          if (!abortController.signal.aborted) {
            setElevationResult({
              segments: requestSegments,
              status: 'ready',
              summary,
            });
          }
        })
        .catch((error: unknown) => {
          if (abortController.signal.aborted) {
            return;
          }

          console.error('Unable to load the route elevation profile.', error);
          setElevationResult({
            segments: requestSegments,
            status: 'error',
            summary: null,
          });
        });
    }, ELEVATION_REQUEST_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(requestTimer);
      abortController.abort();
    };
  }, [activeRouteSegments, distanceMeters, embeddedImportedElevation]);

  return {
    activeRouteSegments,
    distanceMeters,
    elevationStatus,
    elevation,
    durationMinutes,
    mapHoverDistanceMeters,
    handleProfileHoverDistanceChange,
  };
}
