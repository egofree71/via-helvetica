/**
 * Business context: bridges React's component lifecycle with the imperative
 * OpenLayers runtime. It creates the single Via Helvetica map after the target
 * element mounts, publishes its startup and fullscreen state, and guarantees
 * that listeners and the DOM target are released on unmount.
 */
import { useEffect, useRef, useState, type RefObject } from 'react';
import {
  createMapRuntime,
  type MapLoadStatus,
  type MapRuntime,
  type MapRuntimeVisibility,
} from './mapRuntime';
import type { MapLayerOpacities } from './useMapLayerOpacities';

/** React-facing options needed to own the single OpenLayers runtime. */
export interface UseMapRuntimeOptions {
  /** Mounted div that receives the OpenLayers map. */
  mapTargetRef: RefObject<HTMLDivElement | null>;
  /** Application root used to identify this app's fullscreen state. */
  fullscreenElementRef: RefObject<HTMLElement | null>;
  /** Persisted overlay choices captured when the runtime is first created. */
  initialVisibility: MapRuntimeVisibility;
  /** Persisted opacity ratios captured when the runtime is first created. */
  initialOpacity: MapLayerOpacities;
}

/** Runtime resources and browser state exposed to the application shell. */
export interface MapRuntimeController {
  /** Stable ref containing the runtime after the map target mounts. */
  runtimeRef: RefObject<MapRuntime | null>;
  /** Blocking startup state of the initial official base map. */
  status: MapLoadStatus;
  /** Whether the Via Helvetica root currently owns browser fullscreen. */
  isFullscreen: boolean;
}

/**
 * Owns the OpenLayers runtime for the lifetime of one mounted application.
 *
 * @param options - DOM refs plus persisted initial layer visibility and opacity.
 * @returns Runtime resources plus startup and fullscreen render state.
 */
export function useMapRuntime(
  options: UseMapRuntimeOptions,
): MapRuntimeController {
  const runtimeRef = useRef<MapRuntime | null>(null);
  const [status, setStatus] = useState<MapLoadStatus>('loading');
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Later React renders carry updated visibility state, but recreating the map
  // would discard its view and interactions. Only construction options are kept.
  const initialOptionsRef = useRef(options);

  useEffect(() => {
    const initialOptions = initialOptionsRef.current;
    const target = initialOptions.mapTargetRef.current;

    if (!target) {
      return;
    }

    const runtime = createMapRuntime({
      target,
      visibility: initialOptions.initialVisibility,
      opacity: initialOptions.initialOpacity,
      onLoadStatusChange: setStatus,
    });
    runtimeRef.current = runtime;

    const handleFullscreenChange = () => {
      setIsFullscreen(
        document.fullscreenElement ===
          initialOptions.fullscreenElementRef.current,
      );

      // Fullscreen changes the available viewport; OpenLayers must recalculate
      // its canvas after the browser has applied the new dimensions.
      window.requestAnimationFrame(() => runtime.map.updateSize());
    };

    const appRoot = initialOptions.fullscreenElementRef.current;
    const preventNativePageZoom: EventListener = (event) => {
      if (event.cancelable) {
        event.preventDefault();
      }
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);

    // `touch-action: none` handles standards-based browsers. Safari also
    // exposes native gesture events, so cancelling them keeps two-finger
    // scaling inside OpenLayers instead of zooming the document around the
    // floating controls. Pointer/touch events still reach the map interactions.
    appRoot?.addEventListener('gesturestart', preventNativePageZoom, {
      passive: false,
    });
    appRoot?.addEventListener('gesturechange', preventNativePageZoom, {
      passive: false,
    });

    return () => {
      document.removeEventListener(
        'fullscreenchange',
        handleFullscreenChange,
      );
      appRoot?.removeEventListener('gesturestart', preventNativePageZoom);
      appRoot?.removeEventListener('gesturechange', preventNativePageZoom);
      runtime.dispose();

      if (runtimeRef.current === runtime) {
        runtimeRef.current = null;
      }
    };
  }, []);

  return {
    runtimeRef,
    status,
    isFullscreen,
  };
}
