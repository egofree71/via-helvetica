/**
 * Business context: synchronizes one displayed route with the shared elevation
 * profile marker. Editable routes, imported GPX tracks, and selected public
 * routes reuse this hook so map-to-profile and profile-to-map exploration stay
 * consistent while only one workflow owns the transient marker at a time.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type RefObject,
} from 'react';
import MapBrowserEvent from 'ol/MapBrowserEvent.js';
import type { Coordinate } from 'ol/coordinate.js';
import type { MapRuntime } from './mapRuntime';
import {
  createRouteProfilePositionIndex,
  getClosestRouteProfilePosition,
  getRouteProfileCoordinate,
  updateRouteProfileMarker,
} from './routeProfileMarker';

/** Inputs required to link one route geometry with the shared profile marker. */
export interface UseRouteProfileSynchronizationOptions {
  /** Stable ref containing the mounted OpenLayers runtime. */
  mapRuntimeRef: RefObject<MapRuntime | null>;
  /** Independent route segments in displayed order. */
  routeSegments: Coordinate[][];
  /** Whether this workflow currently owns map/profile exploration. */
  isEnabled: boolean;
  /** Optional synchronous guard for pointer interactions owned elsewhere. */
  isPointerInteractionBlocked?: () => boolean;
}

/** Profile-link state and actions consumed by route summary components. */
export interface RouteProfileSynchronizationController {
  /** Cumulative distance selected by hovering the route on the map. */
  mapHoverDistanceMeters: number | null;
  /** Mirrors chart pointer distance onto the shared map marker. */
  handleProfileHoverDistanceChange: (distanceMeters: number | null) => void;
  /** Hides the shared marker and clears the current map-hover distance. */
  clearProfileHover: () => void;
}

/** Screen-space route tolerance for the bidirectional map/profile hover link. */
const ROUTE_PROFILE_HOVER_TOLERANCE_PX = 10;

/**
 * Links one route geometry to the shared map marker and profile cursor.
 *
 * @param options - Runtime, route geometry, ownership flag, and pointer guard.
 * @returns Bidirectional hover state plus an explicit cleanup action.
 */
export function useRouteProfileSynchronization(
  options: UseRouteProfileSynchronizationOptions,
): RouteProfileSynchronizationController {
  const [mapHoverDistanceMeters, setMapHoverDistanceMeters] =
    useState<number | null>(null);
  const routeProfilePositionIndex = useMemo(
    () => createRouteProfilePositionIndex(options.routeSegments),
    [options.routeSegments],
  );

  const clearProfileHover = useCallback(() => {
    const marker = options.mapRuntimeRef.current?.routeProfileMarker;

    if (marker) {
      updateRouteProfileMarker(marker, null);
    }
    setMapHoverDistanceMeters(null);
  }, [options.mapRuntimeRef]);

  const handleProfileHoverDistanceChange = useCallback(
    (distanceMeters: number | null) => {
      const marker = options.mapRuntimeRef.current?.routeProfileMarker;

      if (!marker) {
        return;
      }

      if (!options.isEnabled || distanceMeters === null) {
        updateRouteProfileMarker(marker, null);
        return;
      }

      updateRouteProfileMarker(
        marker,
        getRouteProfileCoordinate(
          routeProfilePositionIndex,
          distanceMeters,
        ),
      );
    },
    [
      options.isEnabled,
      options.mapRuntimeRef,
      routeProfilePositionIndex,
    ],
  );

  /**
   * Mirrors pointer movement over the active route onto the shared marker and
   * the optional profile. Resolution-derived tolerance stays visually stable at
   * every zoom level, while the ownership flag prevents competing workflows.
   */
  useEffect(() => {
    clearProfileHover();

    const map = options.mapRuntimeRef.current?.map;
    const marker = options.mapRuntimeRef.current?.routeProfileMarker;

    if (
      !options.isEnabled ||
      !map ||
      !marker ||
      routeProfilePositionIndex.segments.length === 0
    ) {
      return;
    }

    const handleRoutePointerMove = (event: MapBrowserEvent) => {
      const pointerType =
        (event.originalEvent as PointerEvent).pointerType;

      if (
        (pointerType && pointerType !== 'mouse' && pointerType !== 'pen') ||
        options.isPointerInteractionBlocked?.()
      ) {
        clearProfileHover();
        return;
      }

      const resolution = map.getView().getResolution();

      if (!resolution) {
        clearProfileHover();
        return;
      }

      const position = getClosestRouteProfilePosition(
        routeProfilePositionIndex,
        event.coordinate,
        resolution * ROUTE_PROFILE_HOVER_TOLERANCE_PX,
      );

      updateRouteProfileMarker(marker, position?.coordinate ?? null);
      setMapHoverDistanceMeters(position?.distanceMeters ?? null);
    };

    const mapTarget = map.getTargetElement();
    map.on('pointermove', handleRoutePointerMove);
    mapTarget.addEventListener('pointerleave', clearProfileHover);

    return () => {
      map.un('pointermove', handleRoutePointerMove);
      mapTarget.removeEventListener('pointerleave', clearProfileHover);
      clearProfileHover();
    };
  }, [
    clearProfileHover,
    options.isEnabled,
    options.isPointerInteractionBlocked,
    options.mapRuntimeRef,
    routeProfilePositionIndex,
  ]);

  return {
    mapHoverDistanceMeters,
    handleProfileHoverDistanceChange,
    clearProfileHover,
  };
}
