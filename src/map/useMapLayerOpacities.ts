/**
 * Business context: owns the user-adjustable opacity of every optional map
 * information layer. Product defaults remain distinct from explicit browser
 * preferences, while focused updates keep OpenLayers responsive during slider
 * interaction.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import {
  DEFAULT_HIKING_TRAILS_OPACITY,
  DEFAULT_PUBLIC_TRANSPORT_STOPS_OPACITY,
  DEFAULT_SHOOTING_DANGER_ZONES_OPACITY,
  DEFAULT_SWITZERLAND_MOBILITY_HIKING_OPACITY,
  DEFAULT_TRAIL_CLOSURES_OPACITY,
  MINIMUM_MAP_LAYER_OPACITY,
} from './config';
import type { MapRuntime } from './mapRuntime';

/** Opacity ratios used by the optional information layers. */
export interface MapLayerOpacities {
  /** Ordinary official hiking-trail portrayal, from the product minimum to 1. */
  hikingTrails: number;
  /** Green SwitzerlandMobility hiking portrayal, from the product minimum to 1. */
  switzerlandMobilityHiking: number;
  /** Official closure and detour portrayal, from the product minimum to 1. */
  trailClosures: number;
  /** Military shooting and danger-zone portrayal, from the product minimum to 1. */
  shootingDangerZones: number;
  /** Passenger public-transport stop symbols, from the product minimum to 1. */
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

/** Layers with an opacity control, in stable traversal order. */
const MAP_LAYER_OPACITY_KEYS = [
  'hikingTrails',
  'switzerlandMobilityHiking',
  'trailClosures',
  'shootingDangerZones',
  'publicTransportStops',
] as const satisfies readonly MapLayerOpacityKey[];

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

/** Focused imperative setter for each optional OpenLayers portrayal. */
const MAP_LAYER_OPACITY_APPLIERS: Record<
  MapLayerOpacityKey,
  (runtime: MapRuntime, opacity: number) => void
> = {
  hikingTrails: (runtime, opacity) =>
    runtime.setHikingTrailsOpacity(opacity),
  switzerlandMobilityHiking: (runtime, opacity) =>
    runtime.setSwitzerlandMobilityHikingOpacity(opacity),
  trailClosures: (runtime, opacity) =>
    runtime.setTrailClosuresOpacity(opacity),
  shootingDangerZones: (runtime, opacity) =>
    runtime.setShootingDangerZonesOpacity(opacity),
  publicTransportStops: (runtime, opacity) =>
    runtime.setPublicTransportStopsOpacity(opacity),
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
  /** Changes one layer opacity and persists that explicit visitor choice. */
  setLayerOpacity: (layer: MapLayerOpacityKey, opacity: number) => void;
}

/**
 * Restricts an arbitrary ratio to the user-adjustable opacity range.
 *
 * @param opacity - Requested opacity ratio.
 * @returns A finite value between the configured minimum and 1 (opaque).
 */
export function normalizeMapLayerOpacity(opacity: number): number {
  if (!Number.isFinite(opacity)) {
    return 1;
  }

  return Math.min(1, Math.max(MINIMUM_MAP_LAYER_OPACITY, opacity));
}

/**
 * Reads one stored opacity without letting malformed or obsolete browser data
 * make a visible layer effectively disappear.
 *
 * @param layer - Layer whose storage key should be inspected.
 * @param defaultOpacity - Product default used when no valid value exists.
 * @returns A valid opacity ratio inside the current user-adjustable range.
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
      ? normalizeMapLayerOpacity(parsedValue)
      : defaultOpacity;
  } catch {
    return defaultOpacity;
  }
}

/**
 * Resolves the complete opacity snapshot used by map construction and React.
 *
 * @returns Explicit visitor preferences with product defaults for absent keys.
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
 * Persists one explicit visitor choice without making browser storage a
 * prerequisite for using the opacity control.
 *
 * @param layer - Layer whose independent preference should be written.
 * @param opacity - Normalized ratio selected by the visitor.
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
 * Coordinates explicit opacity preferences with the imperative OpenLayers
 * layers without rewriting unrelated browser keys or redrawing other layers.
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
  const currentOpacitiesRef = useRef(options.initialOpacities);
  // The runtime is constructed with this same snapshot, so treating it as
  // already applied avoids five redundant OpenLayers mutations at startup.
  const appliedOpacitiesRef = useRef(options.initialOpacities);

  const setLayerOpacity = useCallback(
    (layer: MapLayerOpacityKey, opacity: number) => {
      const normalizedOpacity = normalizeMapLayerOpacity(opacity);
      const currentOpacities = currentOpacitiesRef.current;

      if (currentOpacities[layer] === normalizedOpacity) {
        return;
      }

      const nextOpacities = {
        ...currentOpacities,
        [layer]: normalizedOpacity,
      };

      // Persistence follows the explicit slider gesture. Leaving a key absent
      // lets future product-default changes reach visitors who never adjusted it.
      persistOpacity(layer, normalizedOpacity);
      currentOpacitiesRef.current = nextOpacities;
      setLayerOpacities(nextOpacities);
    },
    [],
  );

  useEffect(() => {
    const runtime = options.mapRuntimeRef.current;

    if (!runtime) {
      return;
    }

    const appliedOpacities = appliedOpacitiesRef.current;

    for (const layer of MAP_LAYER_OPACITY_KEYS) {
      if (appliedOpacities[layer] === layerOpacities[layer]) {
        continue;
      }

      MAP_LAYER_OPACITY_APPLIERS[layer](
        runtime,
        layerOpacities[layer],
      );
    }

    appliedOpacitiesRef.current = layerOpacities;
  }, [layerOpacities, options.mapRuntimeRef]);

  return {
    layerOpacities,
    setLayerOpacity,
  };
}
