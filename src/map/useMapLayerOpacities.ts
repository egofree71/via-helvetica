/**
 * Business context: owns the user-adjustable opacity of every optional map
 * information layer. The values are restored before the OpenLayers runtime is
 * created, applied consistently to raster and vector displays, and persisted so
 * hikers do not need to retune the map at every visit.
 */
import {
  useCallback,
  useEffect,
  useState,
  type RefObject,
} from 'react';
import {
  DEFAULT_HIKING_TRAILS_OPACITY,
  DEFAULT_PUBLIC_TRANSPORT_STOPS_OPACITY,
  DEFAULT_SHOOTING_DANGER_ZONES_OPACITY,
  DEFAULT_SWITZERLAND_MOBILITY_HIKING_OPACITY,
  DEFAULT_TRAIL_CLOSURES_OPACITY,
} from './config';
import type { MapRuntime } from './mapRuntime';

/** Opacity ratios used by the optional information layers. */
export interface MapLayerOpacities {
  /** Ordinary official hiking-trail portrayal, from 0 (transparent) to 1 (opaque). */
  hikingTrails: number;
  /** Green SwitzerlandMobility hiking portrayal, from 0 to 1. */
  switzerlandMobilityHiking: number;
  /** Official closure and detour portrayal, from 0 to 1. */
  trailClosures: number;
  /** Military shooting and danger-zone portrayal, from 0 to 1. */
  shootingDangerZones: number;
  /** Passenger public-transport stop symbols, from 0 to 1. */
  publicTransportStops: number;
}

/** One information layer whose opacity can be changed by the shared menu. */
export type MapLayerOpacityKey = keyof MapLayerOpacities;

/** Product defaults used until the visitor saves an explicit preference. */
export const DEFAULT_MAP_LAYER_OPACITIES: Readonly<MapLayerOpacities> = {
  hikingTrails: DEFAULT_HIKING_TRAILS_OPACITY,
  switzerlandMobilityHiking:
    DEFAULT_SWITZERLAND_MOBILITY_HIKING_OPACITY,
  trailClosures: DEFAULT_TRAIL_CLOSURES_OPACITY,
  shootingDangerZones: DEFAULT_SHOOTING_DANGER_ZONES_OPACITY,
  publicTransportStops: DEFAULT_PUBLIC_TRANSPORT_STOPS_OPACITY,
};

/** Browser preference key dedicated to each independently adjustable layer. */
const MAP_LAYER_OPACITY_STORAGE_KEYS: Record<
  MapLayerOpacityKey,
  string
> = {
  hikingTrails: 'via-helvetica.hiking-trails-opacity',
  switzerlandMobilityHiking:
    'via-helvetica.switzerland-mobility-hiking-opacity',
  trailClosures: 'via-helvetica.trail-closures-opacity',
  shootingDangerZones:
    'via-helvetica.shooting-danger-zones-opacity',
  publicTransportStops:
    'via-helvetica.public-transport-stops-opacity',
};

/** Inputs required by the shared information-layer opacity capability. */
export interface UseMapLayerOpacitiesOptions {
  /** Mounted OpenLayers runtime that receives opacity updates. */
  mapRuntimeRef: RefObject<MapRuntime | null>;
  /** Persisted values captured before the runtime is first created. */
  initialOpacities: MapLayerOpacities;
}

/** React-facing opacity values and the generic update action used by the menu. */
export interface MapLayerOpacitiesController {
  /** Current opacity ratio for every optional information layer. */
  layerOpacities: MapLayerOpacities;
  /** Changes one layer opacity while keeping the ratio inside the valid range. */
  setLayerOpacity: (layer: MapLayerOpacityKey, opacity: number) => void;
}

/**
 * Restricts an arbitrary ratio to the OpenLayers opacity range.
 *
 * @param opacity - Requested opacity ratio.
 * @returns A finite value between 0 (transparent) and 1 (opaque).
 */
export function normalizeMapLayerOpacity(opacity: number): number {
  if (!Number.isFinite(opacity)) {
    return 1;
  }

  return Math.min(1, Math.max(0, opacity));
}

/**
 * Reads one stored opacity without letting malformed browser data make a layer
 * disappear unexpectedly.
 *
 * @param layer - Layer whose storage key should be inspected.
 * @param defaultOpacity - Product default used when no valid value exists.
 * @returns A valid opacity ratio between 0 and 1.
 */
function readStoredOpacity(
  layer: MapLayerOpacityKey,
  defaultOpacity: number,
): number {
  try {
    const storedValue = window.localStorage.getItem(
      MAP_LAYER_OPACITY_STORAGE_KEYS[layer],
    );

    if (storedValue === null || storedValue.trim() === '') {
      return defaultOpacity;
    }

    const parsedValue = Number(storedValue);

    return Number.isFinite(parsedValue) &&
      parsedValue >= 0 &&
      parsedValue <= 1
      ? parsedValue
      : defaultOpacity;
  } catch {
    return defaultOpacity;
  }
}

/**
 * Resolves the complete opacity snapshot used by map construction and React.
 *
 * @returns Persisted values with product defaults for new visitors.
 */
export function resolveInitialMapLayerOpacities(): MapLayerOpacities {
  return {
    hikingTrails: readStoredOpacity(
      'hikingTrails',
      DEFAULT_MAP_LAYER_OPACITIES.hikingTrails,
    ),
    switzerlandMobilityHiking: readStoredOpacity(
      'switzerlandMobilityHiking',
      DEFAULT_MAP_LAYER_OPACITIES.switzerlandMobilityHiking,
    ),
    trailClosures: readStoredOpacity(
      'trailClosures',
      DEFAULT_MAP_LAYER_OPACITIES.trailClosures,
    ),
    shootingDangerZones: readStoredOpacity(
      'shootingDangerZones',
      DEFAULT_MAP_LAYER_OPACITIES.shootingDangerZones,
    ),
    publicTransportStops: readStoredOpacity(
      'publicTransportStops',
      DEFAULT_MAP_LAYER_OPACITIES.publicTransportStops,
    ),
  };
}

/**
 * Persists one layer ratio without making browser storage a prerequisite for
 * using the opacity control.
 */
function persistOpacity(
  layer: MapLayerOpacityKey,
  opacity: number,
): void {
  try {
    window.localStorage.setItem(
      MAP_LAYER_OPACITY_STORAGE_KEYS[layer],
      String(opacity),
    );
  } catch {
    // Private browsing and restrictive policies must not disable map controls.
  }
}

/**
 * Coordinates persisted opacity state with the imperative OpenLayers layers.
 *
 * @param options - Runtime ref and values restored before map creation.
 * @returns Current ratios and one stable action for slider changes.
 */
export function useMapLayerOpacities(
  options: UseMapLayerOpacitiesOptions,
): MapLayerOpacitiesController {
  const [layerOpacities, setLayerOpacities] = useState(
    options.initialOpacities,
  );

  const setLayerOpacity = useCallback(
    (layer: MapLayerOpacityKey, opacity: number) => {
      const normalizedOpacity = normalizeMapLayerOpacity(opacity);

      setLayerOpacities((currentOpacities) => {
        if (currentOpacities[layer] === normalizedOpacity) {
          return currentOpacities;
        }

        return {
          ...currentOpacities,
          [layer]: normalizedOpacity,
        };
      });
    },
    [],
  );

  useEffect(() => {
    const runtime = options.mapRuntimeRef.current;

    runtime?.setHikingTrailsOpacity(layerOpacities.hikingTrails);
    runtime?.setSwitzerlandMobilityHikingOpacity(
      layerOpacities.switzerlandMobilityHiking,
    );
    runtime?.setTrailClosuresOpacity(layerOpacities.trailClosures);
    runtime?.setShootingDangerZonesOpacity(
      layerOpacities.shootingDangerZones,
    );
    runtime?.setPublicTransportStopsOpacity(
      layerOpacities.publicTransportStops,
    );

    for (const layer of Object.keys(
      layerOpacities,
    ) as MapLayerOpacityKey[]) {
      persistOpacity(layer, layerOpacities[layer]);
    }
  }, [layerOpacities, options.mapRuntimeRef]);

  return {
    layerOpacities,
    setLayerOpacity,
  };
}
