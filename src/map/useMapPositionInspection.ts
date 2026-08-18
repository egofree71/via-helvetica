/**
 * Business context: gives mouse users one lightweight way to inspect an exact
 * map position without competing with the left-click information-layer
 * workflow. A desktop context-menu gesture places a temporary point immediately
 * and retrieves its official terrain height; newer gestures cancel older work.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { Coordinate } from 'ol/coordinate.js';
import { containsCoordinate } from 'ol/extent.js';
import { MAP_EXTENT } from './config';
import {
  clearMapPositionMarker,
  updateMapPositionMarker,
} from './mapPositionMarker';
import type { MapRuntime } from './mapRuntime';
import { fetchPointHeight } from './pointHeight';
import { toWgs84 } from './projection';

/** Fine-pointer desktop capability required before suppressing the native menu. */
const DESKTOP_CONTEXT_MENU_MEDIA_QUERY = '(hover: hover) and (pointer: fine)';

/** Availability of the asynchronous terrain-height value. */
export type MapPositionElevationStatus = 'loading' | 'ready' | 'error';

/** One exact point currently inspected from the desktop map. */
export interface MapPositionInspection {
  /** Native LV95 coordinate used by the map and point-height service. */
  coordinate: Coordinate;
  /** WGS 84 longitude/latitude derived locally from the same point. */
  wgs84Coordinate: Coordinate;
  /** State of the optional point-height request. */
  elevationStatus: MapPositionElevationStatus;
  /** Terrain elevation in metres once the provider returns a valid value. */
  elevationMeters: number | null;
}

/** Options required by the desktop-only position inspection lifecycle. */
export interface UseMapPositionInspectionOptions {
  /** Stable OpenLayers runtime owned by the application shell. */
  mapRuntimeRef: RefObject<MapRuntime | null>;
  /** Called before a new inspected point takes over the transient map context. */
  onOpen?: () => void;
}

/** React-facing state and dismissal action for the position panel. */
export interface MapPositionInspectionController {
  /** Current inspected point, or null while no context-menu result is open. */
  inspection: MapPositionInspection | null;
  /** Dismisses the panel, marker, and any pending point-height request. */
  closeInspection: () => void;
}

/** Returns whether the current browser input model represents desktop mouse use. */
function supportsDesktopContextMenu(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  if (typeof window.matchMedia === 'function') {
    return window.matchMedia(DESKTOP_CONTEXT_MENU_MEDIA_QUERY).matches;
  }

  // Old desktop browsers without matchMedia can still expose a genuine right-click.
  return window.innerWidth > 700;
}

/**
 * Owns desktop right-click inspection for the lifetime of the current map.
 *
 * @param options - Runtime reference plus optional cross-workflow cleanup.
 * @returns Current position state and an explicit dismissal action.
 */
export function useMapPositionInspection(
  options: UseMapPositionInspectionOptions,
): MapPositionInspectionController {
  const [inspection, setInspection] =
    useState<MapPositionInspection | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  const closeInspection = useCallback(() => {
    requestRef.current?.abort();
    requestRef.current = null;

    const marker = options.mapRuntimeRef.current?.mapPositionMarker;

    if (marker) {
      clearMapPositionMarker(marker);
    }

    setInspection(null);
  }, [options.mapRuntimeRef]);

  useEffect(() => {
    const runtime = options.mapRuntimeRef.current;

    if (!runtime) {
      return;
    }

    const { map, mapPositionMarker } = runtime;
    const viewport = map.getViewport();

    const handleContextMenu = (event: MouseEvent) => {
      if (!supportsDesktopContextMenu()) {
        return;
      }

      // The OpenLayers viewport also contains attribution and scale controls.
      // Preserve their native context menu so official source links remain fully
      // usable; only the actual map canvas area belongs to point inspection.
      if (
        event.target instanceof Element &&
        event.target.closest('.ol-control')
      ) {
        return;
      }

      const coordinate = map.getEventCoordinate(event);

      if (!containsCoordinate(MAP_EXTENT, coordinate)) {
        return;
      }

      // Only a supported desktop map inspection replaces the browser menu.
      event.preventDefault();
      options.onOpen?.();

      requestRef.current?.abort();
      const request = new AbortController();
      requestRef.current = request;

      const stableCoordinate: Coordinate = [coordinate[0], coordinate[1]];
      updateMapPositionMarker(mapPositionMarker, stableCoordinate);
      setInspection({
        coordinate: stableCoordinate,
        wgs84Coordinate: toWgs84(stableCoordinate),
        elevationStatus: 'loading',
        elevationMeters: null,
      });

      void fetchPointHeight(stableCoordinate, request.signal)
        .then((elevationMeters) => {
          if (request.signal.aborted || requestRef.current !== request) {
            return;
          }

          setInspection((current) =>
            current &&
            current.coordinate[0] === stableCoordinate[0] &&
            current.coordinate[1] === stableCoordinate[1]
              ? {
                  ...current,
                  elevationStatus: 'ready',
                  elevationMeters,
                }
              : current,
          );
        })
        .catch((error: unknown) => {
          if (request.signal.aborted || requestRef.current !== request) {
            return;
          }

          console.error('Unable to load the inspected map-point height.', error);
          setInspection((current) =>
            current &&
            current.coordinate[0] === stableCoordinate[0] &&
            current.coordinate[1] === stableCoordinate[1]
              ? {
                  ...current,
                  elevationStatus: 'error',
                  elevationMeters: null,
                }
              : current,
          );
        });
    };

    // A normal left-click starts another map workflow and therefore dismisses
    // position inspection immediately, without waiting for remote identify work.
    const handleSingleClick = () => closeInspection();
    const desktopMediaQuery =
      typeof window.matchMedia === 'function'
        ? window.matchMedia(DESKTOP_CONTEXT_MENU_MEDIA_QUERY)
        : null;
    const handleDesktopCapabilityChange = (event: MediaQueryListEvent) => {
      if (!event.matches) {
        closeInspection();
      }
    };

    viewport.addEventListener('contextmenu', handleContextMenu);
    map.on('singleclick', handleSingleClick);
    desktopMediaQuery?.addEventListener?.(
      'change',
      handleDesktopCapabilityChange,
    );

    return () => {
      viewport.removeEventListener('contextmenu', handleContextMenu);
      map.un('singleclick', handleSingleClick);
      desktopMediaQuery?.removeEventListener?.(
        'change',
        handleDesktopCapabilityChange,
      );
      requestRef.current?.abort();
      requestRef.current = null;
      clearMapPositionMarker(mapPositionMarker);
    };
  }, [closeInspection, options.mapRuntimeRef, options.onOpen]);

  return { inspection, closeInspection };
}
