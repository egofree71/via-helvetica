/**
 * Business context: coordinates optional planning information shown above the
 * Via Helvetica map. It persists layer choices, loads passenger stops for the
 * current viewport, and owns the prioritized stop/closure/route/danger-zone
 * inspection workflow, including validated public-route acceptance and profile
 * exploration, without mixing these asynchronous concerns into the root component.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import type { Coordinate } from 'ol/coordinate.js';
import MapBrowserEvent from 'ol/MapBrowserEvent.js';
import {
  fetchTrailClosurePopup,
  identifyTrailClosure,
} from '../closures/trailClosures';
import type { TrailClosurePopupStatus } from '../components/TrailClosurePopup';
import type { ShootingDangerZonePopupStatus } from '../components/ShootingDangerZonePopup';
import type { PublicTransportStopPopupStatus } from '../components/PublicTransportStopPopup';
import {
  fetchShootingDangerZonePopup,
  identifyShootingDangerZone,
  updateShootingDangerZoneSelection,
} from '../dangers/shootingDangerZones';
import type { Language } from '../i18n/translations';
import { isAbortedRequest } from '../network/abort';
import type {
  SwitzerlandMobilityHikingRouteCandidate,
} from '../switzerlandMobility/hikingRoutes';
import {
  applyPublicTransportStopDeclutterVisibility,
  createPublicTransportStopsViewportCoverage,
  getPublicTransportStopChoicesForVisibleStop,
  getPublicTransportStopFromFeature,
  loadPublicTransportStops,
  publicTransportStopsCoverageContainsViewport,
  PUBLIC_TRANSPORT_STOPS_MIN_ZOOM,
  type PublicTransportStop,
  type PublicTransportStopsViewportCoverage,
  updatePublicTransportStopsDisplay,
  updatePublicTransportStopDeclutterPriority,
  updatePublicTransportStopSelection,
} from '../transport/publicTransportStops';
import {
  HIKING_TRAILS_MIN_ZOOM,
  SWITZERLAND_MOBILITY_HIKING_MIN_ZOOM,
} from './config';
import type { MapRuntime } from './mapRuntime';
import {
  ensureMapInformationCoordinateVisible,
} from './mapInformationViewport';
import {
  useSwitzerlandMobilityHikingSelection,
  type SwitzerlandMobilityHikingPanelStatus,
} from './useSwitzerlandMobilityHikingSelection';

/** Browser preference key for the safety-information overlay. */
const TRAIL_CLOSURES_VISIBILITY_STORAGE_KEY =
  'via-helvetica.trail-closures-visible';
/** Browser preference key for the military danger-zone overlay. */
const SHOOTING_DANGER_ZONES_VISIBILITY_STORAGE_KEY =
  'via-helvetica.shooting-danger-zones-visible';
/** Browser preference key for the optional public-transport stop overlay. */
const PUBLIC_TRANSPORT_STOPS_VISIBILITY_STORAGE_KEY =
  'via-helvetica.public-transport-stops-visible';
/** Hit tolerance in screen pixels for selecting compact stop symbols. */
const PUBLIC_TRANSPORT_STOP_HIT_TOLERANCE_PX = 8;
/**
 * Brief delay for successive completed map movements. Buffer coverage handles
 * ordinary pans immediately; the debounce only coalesces rapid uncached moves.
 */
const PUBLIC_TRANSPORT_STOPS_MOVEEND_DEBOUNCE_MS = 180;

/** Persisted visibility of the three independently controlled information layers. */
export interface MapInformationLayerVisibility {
  /** Whether official hiking closures and detours start visible. */
  trailClosures: boolean;
  /** Whether military shooting notices and danger zones start visible. */
  shootingDangerZones: boolean;
  /** Whether filtered passenger public-transport stops start visible. */
  publicTransportStops: boolean;
}

/** Options needed to coordinate all optional map-information workflows. */
export interface UseMapInformationLayersOptions {
  /** Stable ref containing the mounted OpenLayers runtime. */
  mapRuntimeRef: RefObject<MapRuntime | null>;
  /** Visibility snapshot also used when constructing the map runtime. */
  initialVisibility: MapInformationLayerVisibility;
  /** Current interface language used by GeoAdmin and stop normalization. */
  language: Language;
  /** Whether the public SwitzerlandMobility hiking portrayal is enabled. */
  isSwitzerlandMobilityHikingVisible: boolean;
  /** Disables information inspection while route clicks own the map. */
  isRouteCreationActive: boolean;
  /**
   * Lets the responsive shell react immediately to a map click before remote
   * identify calls resolve. Returning `true` preserves the current selection
   * if inspection later confirms that the click hit empty map space.
   */
  onMapClickStart?: () => boolean;
  /** Clears temporary map context when an information feature is selected. */
  onInformationSelected: () => void;
  /** Replaces the current itinerary once a public route has usable geometry. */
  onSwitzerlandMobilityHikingRouteAccepted: () => void;
}

/** State and actions consumed by the root map controls and popup components. */
export interface MapInformationLayersController {
  /** Whether official hiking closures and detours are visible. */
  areTrailClosuresVisible: boolean;
  /** Changes closure visibility and persists the explicit choice. */
  setAreTrailClosuresVisible: Dispatch<SetStateAction<boolean>>;
  /** Whether military shooting notices and danger zones are visible. */
  areShootingDangerZonesVisible: boolean;
  /** Changes military danger-zone visibility and persists the choice. */
  setAreShootingDangerZonesVisible: Dispatch<SetStateAction<boolean>>;
  /** Whether filtered passenger public-transport stops are visible. */
  arePublicTransportStopsVisible: boolean;
  /** Changes public-transport visibility and persists the choice. */
  setArePublicTransportStopsVisible: Dispatch<SetStateAction<boolean>>;
  /** Current localized hiking-closure popup state, when one is open. */
  trailClosurePopup: TrailClosurePopupStatus | null;
  /** Current localized military danger-zone popup state, when one is open. */
  shootingDangerZonePopup: ShootingDangerZonePopupStatus | null;
  /** Current public-transport overlap chooser or selected-stop timetable. */
  publicTransportStopPopup: PublicTransportStopPopupStatus | null;
  /** Resolves a declutter overlap chooser to one concrete passenger stop. */
  selectPublicTransportStop: (stop: PublicTransportStop) => void;
  /** Compact public-route panel or overlap chooser shown at the map bottom. */
  switzerlandMobilityHikingPanel: SwitzerlandMobilityHikingPanelStatus | null;
  /** Selects one public route after the user resolves an overlap. */
  selectSwitzerlandMobilityHikingCandidate: (
    candidate: SwitzerlandMobilityHikingRouteCandidate,
  ) => void;
  /** Cumulative distance selected by hovering the public route on the map. */
  switzerlandMobilityHikingMapHoverDistanceMeters: number | null;
  /** Mirrors public-route profile distance onto the shared map marker. */
  handleSwitzerlandMobilityHikingProfileHoverDistanceChange: (
    distanceMeters: number | null,
  ) => void;
  /** Closes every information popup, selection, and pending request. */
  closeMapInformationPopup: () => void;
  /** Closes the public-route panel without changing the current map view. */
  dismissSwitzerlandMobilityHikingPanel: () => void;
}

/**
 * Reads one persisted layer choice while preserving a safe product default when
 * browser storage is unavailable or no explicit choice exists.
 *
 * @param key - Local-storage key dedicated to one layer.
 * @param defaultValue - Product default used before the user changes the layer.
 * @returns The stored boolean or the supplied default.
 */
function readStoredVisibility(key: string, defaultValue: boolean): boolean {
  try {
    const storedValue = window.localStorage.getItem(key);

    return storedValue === null ? defaultValue : storedValue === 'true';
  } catch {
    return defaultValue;
  }
}

/**
 * Persists one explicit visibility choice without making storage availability a
 * prerequisite for using the map.
 *
 * @param key - Local-storage key dedicated to one layer.
 * @param visible - Current layer visibility.
 */
function persistVisibility(key: string, visible: boolean): void {
  try {
    window.localStorage.setItem(key, String(visible));
  } catch {
    // Private browsing and restrictive policies must not disable layer controls.
  }
}

/**
 * Resolves the visibility snapshot shared by map construction and the React
 * information-layer controller.
 *
 * @returns Persisted choices with safety overlays enabled and stops disabled by default.
 */
export function resolveInitialMapInformationLayerVisibility(): MapInformationLayerVisibility {
  return {
    trailClosures: readStoredVisibility(
      TRAIL_CLOSURES_VISIBILITY_STORAGE_KEY,
      true,
    ),
    shootingDangerZones: readStoredVisibility(
      SHOOTING_DANGER_ZONES_VISIBILITY_STORAGE_KEY,
      true,
    ),
    publicTransportStops: readStoredVisibility(
      PUBLIC_TRANSPORT_STOPS_VISIBILITY_STORAGE_KEY,
      false,
    ),
  };
}

/**
 * Owns information-layer visibility, loading, inspection priority, and popup
 * lifecycle for the mounted map.
 *
 * @param options - Runtime ref, language, route mode, and selection callback.
 * @returns Visibility values, popup state, selection actions, and close behaviors.
 */
export function useMapInformationLayers(
  options: UseMapInformationLayersOptions,
): MapInformationLayersController {
  const {
    mapRuntimeRef,
    initialVisibility,
    language,
    isSwitzerlandMobilityHikingVisible,
    isRouteCreationActive,
    onMapClickStart,
    onInformationSelected,
    onSwitzerlandMobilityHikingRouteAccepted,
  } = options;
  const informationRequestRef = useRef<AbortController | null>(null);
  const [areTrailClosuresVisible, setAreTrailClosuresVisible] = useState(
    initialVisibility.trailClosures,
  );
  const [areShootingDangerZonesVisible, setAreShootingDangerZonesVisible] =
    useState(initialVisibility.shootingDangerZones);
  const [arePublicTransportStopsVisible, setArePublicTransportStopsVisible] =
    useState(initialVisibility.publicTransportStops);
  const [trailClosurePopup, setTrailClosurePopup] =
    useState<TrailClosurePopupStatus | null>(null);
  const [shootingDangerZonePopup, setShootingDangerZonePopup] =
    useState<ShootingDangerZonePopupStatus | null>(null);
  const [publicTransportStopPopup, setPublicTransportStopPopup] =
    useState<PublicTransportStopPopupStatus | null>(null);
  const [informationAnchorCoordinate, setInformationAnchorCoordinate] =
    useState<Coordinate | null>(null);

  /** Clears rendered non-route information without aborting the click that found a replacement. */
  const clearDisplayedInformationContext = useCallback(() => {
    setTrailClosurePopup(null);
    setShootingDangerZonePopup(null);
    setPublicTransportStopPopup(null);
    setInformationAnchorCoordinate(null);

    const runtime = mapRuntimeRef.current;

    if (!runtime) {
      return;
    }

    updatePublicTransportStopSelection(
      runtime.publicTransportStopsDisplay,
      null,
    );
    applyPublicTransportStopDeclutterVisibility(
      runtime.publicTransportStopsDisplay,
      runtime.map,
    );
    updateShootingDangerZoneSelection(
      runtime.shootingDangerZoneSelectionDisplay,
      null,
    );
  }, [mapRuntimeRef]);

  /**
   * A public-route match replaces any structured popup only after identification
   * succeeds, so an empty mobile map tap can temporarily hide the old panel
   * without destroying its state.
   */
  const handleSwitzerlandMobilityInformationSelected = useCallback(() => {
    clearDisplayedInformationContext();
    onInformationSelected();
  }, [clearDisplayedInformationContext, onInformationSelected]);

  const {
    panelStatus: switzerlandMobilityHikingPanel,
    inspectAt: inspectSwitzerlandMobilityHikingAt,
    selectCandidate: selectSwitzerlandMobilityHikingCandidate,
    mapHoverDistanceMeters:
      switzerlandMobilityHikingMapHoverDistanceMeters,
    handleProfileHoverDistanceChange:
      handleSwitzerlandMobilityHikingProfileHoverDistanceChange,
    closeSelection: closeSwitzerlandMobilityHikingSelection,
    dismissSelection: dismissSwitzerlandMobilityHikingSelection,
  } = useSwitzerlandMobilityHikingSelection({
    mapRuntimeRef,
    language,
    onInformationSelected: handleSwitzerlandMobilityInformationSelected,
    onRouteAccepted: onSwitzerlandMobilityHikingRouteAccepted,
  });
  // Panel transitions must not recreate the map click listener: its cleanup
  // would otherwise abort the identify request started by that same click.
  const switzerlandMobilityHikingPanelRef = useRef(
    switzerlandMobilityHikingPanel,
  );
  switzerlandMobilityHikingPanelRef.current =
    switzerlandMobilityHikingPanel;

  /** Cancels obsolete work and clears non-route structured and vector selections. */
  const clearInformationContext = useCallback(() => {
    informationRequestRef.current?.abort();
    informationRequestRef.current = null;
    clearDisplayedInformationContext();
  }, [clearDisplayedInformationContext]);

  /** Cancels obsolete work and clears every information-layer selection. */
  const closeMapInformationPopup = useCallback(() => {
    clearInformationContext();
    closeSwitzerlandMobilityHikingSelection();
  }, [
    clearInformationContext,
    closeSwitzerlandMobilityHikingSelection,
  ]);

  /**
   * Replaces the currently rendered information without aborting the identify
   * request that has just found the new feature.
   */
  const replaceWithNonRouteInformation = useCallback(() => {
    clearDisplayedInformationContext();
    closeSwitzerlandMobilityHikingSelection();
    onInformationSelected();
  }, [
    clearDisplayedInformationContext,
    closeSwitzerlandMobilityHikingSelection,
    onInformationSelected,
  ]);

  /** Resolves a stop chooser and gives the selected stop visual priority. */
  const selectPublicTransportStop = useCallback(
    (stop: PublicTransportStop) => {
      const runtime = mapRuntimeRef.current;

      if (!runtime) {
        return;
      }

      updatePublicTransportStopSelection(
        runtime.publicTransportStopsDisplay,
        stop,
      );
      applyPublicTransportStopDeclutterVisibility(
        runtime.publicTransportStopsDisplay,
        runtime.map,
      );
      setPublicTransportStopPopup({ state: 'stop', stop });
    },
    [mapRuntimeRef],
  );

  /**
   * Preserves the current selection when the mobile shell consumes an empty map
   * click; desktop keeps the historical behaviour of dismissing the selection.
   */
  const handleEmptyMapClick = useCallback((preserveSelection: boolean) => {
    // A newer click owns the inspection pipeline even when the mobile shell
    // only toggles its chrome; stale provider responses must not reopen UI.
    informationRequestRef.current?.abort();
    informationRequestRef.current = null;

    if (preserveSelection) {
      return;
    }

    closeMapInformationPopup();
  }, [closeMapInformationPopup]);

  /** Closes the explicit public-route panel while preserving the fitted view. */
  const dismissSwitzerlandMobilityHikingPanel = useCallback(() => {
    clearInformationContext();
    dismissSwitzerlandMobilityHikingSelection();
  }, [
    clearInformationContext,
    dismissSwitzerlandMobilityHikingSelection,
  ]);

  useEffect(() => {
    persistVisibility(
      TRAIL_CLOSURES_VISIBILITY_STORAGE_KEY,
      areTrailClosuresVisible,
    );
  }, [areTrailClosuresVisible]);

  useEffect(() => {
    persistVisibility(
      SHOOTING_DANGER_ZONES_VISIBILITY_STORAGE_KEY,
      areShootingDangerZonesVisible,
    );
  }, [areShootingDangerZonesVisible]);

  useEffect(() => {
    persistVisibility(
      PUBLIC_TRANSPORT_STOPS_VISIBILITY_STORAGE_KEY,
      arePublicTransportStopsVisible,
    );
  }, [arePublicTransportStopsVisible]);

  useEffect(() => {
    const runtime = mapRuntimeRef.current;

    if (!runtime) {
      return;
    }

    runtime.setTrailClosuresVisible(areTrailClosuresVisible);

    if (!areTrailClosuresVisible && trailClosurePopup) {
      closeMapInformationPopup();
    }
  }, [
    areTrailClosuresVisible,
    closeMapInformationPopup,
    mapRuntimeRef,
    trailClosurePopup,
  ]);

  useEffect(() => {
    const runtime = mapRuntimeRef.current;

    if (!runtime) {
      return;
    }

    runtime.setShootingDangerZonesVisible(areShootingDangerZonesVisible);

    if (!areShootingDangerZonesVisible && shootingDangerZonePopup) {
      closeMapInformationPopup();
    }
  }, [
    areShootingDangerZonesVisible,
    closeMapInformationPopup,
    mapRuntimeRef,
    shootingDangerZonePopup,
  ]);

  useEffect(() => {
    if (
      !isSwitzerlandMobilityHikingVisible &&
      switzerlandMobilityHikingPanel
    ) {
      closeMapInformationPopup();
    }
  }, [
    closeMapInformationPopup,
    isSwitzerlandMobilityHikingVisible,
    switzerlandMobilityHikingPanel,
  ]);

  useEffect(() => {
    const runtime = mapRuntimeRef.current;

    if (!runtime) {
      return;
    }

    const { map, publicTransportStopsDisplay: display } = runtime;
    runtime.setPublicTransportStopsVisible(
      arePublicTransportStopsVisible,
    );

    if (!arePublicTransportStopsVisible) {
      display.source.clear();
      closeMapInformationPopup();
      return;
    }

    let abortController: AbortController | null = null;
    let debounceTimer: number | null = null;
    let pendingCoverage: PublicTransportStopsViewportCoverage | null = null;
    let loadedCoverage: PublicTransportStopsViewportCoverage | null = null;

    const clearDebounce = () => {
      if (debounceTimer !== null) {
        window.clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    };

    const cancelPendingRequest = () => {
      abortController?.abort();
      abortController = null;
      pendingCoverage = null;
    };

    const readViewport = () => {
      const imageSize = map.getSize();
      const zoom = map.getView().getZoom();

      if (
        !imageSize ||
        zoom === undefined ||
        zoom <= PUBLIC_TRANSPORT_STOPS_MIN_ZOOM
      ) {
        return null;
      }

      const normalizedImageSize: [number, number] = [
        imageSize[0],
        imageSize[1],
      ];

      return {
        viewportExtent: map.getView().calculateExtent(imageSize),
        imageSize: normalizedImageSize,
        zoom,
      };
    };

    const clearUnavailableStops = () => {
      clearDebounce();
      cancelPendingRequest();
      loadedCoverage = null;
      display.source.clear();
    };

    const loadVisibleStops = () => {
      clearDebounce();
      const viewport = readViewport();

      if (!viewport) {
        clearUnavailableStops();
        return;
      }

      const loadedCoverageMatches =
        publicTransportStopsCoverageContainsViewport(
          loadedCoverage,
          viewport.viewportExtent,
          viewport.zoom,
          viewport.imageSize,
        );
      const pendingCoverageMatches =
        publicTransportStopsCoverageContainsViewport(
          pendingCoverage,
          viewport.viewportExtent,
          viewport.zoom,
          viewport.imageSize,
        );

      if (loadedCoverageMatches || pendingCoverageMatches) {
        if (loadedCoverageMatches && !pendingCoverageMatches) {
          cancelPendingRequest();
        }
        return;
      }

      cancelPendingRequest();
      const coverage = createPublicTransportStopsViewportCoverage(
        viewport.viewportExtent,
        viewport.zoom,
        viewport.imageSize,
      );
      const request = new AbortController();
      pendingCoverage = coverage;
      abortController = request;

      void loadPublicTransportStops(
        {
          requestExtent: coverage.requestExtent,
          viewportExtent: viewport.viewportExtent,
          imageSize: viewport.imageSize,
          language,
        },
        request.signal,
      )
        .then((stops) => {
          const currentViewport = readViewport();

          if (
            request.signal.aborted ||
            !currentViewport ||
            !publicTransportStopsCoverageContainsViewport(
              coverage,
              currentViewport.viewportExtent,
              currentViewport.zoom,
              currentViewport.imageSize,
            )
          ) {
            return;
          }

          loadedCoverage = coverage;
          updatePublicTransportStopsDisplay(display, stops);
          applyPublicTransportStopDeclutterVisibility(display, map);
        })
        .catch((error: unknown) => {
          if (isAbortedRequest(error, request.signal)) {
            return;
          }

          // Optional stop information must never block route planning.
          console.error('Unable to load public-transport stops.', error);
        })
        .finally(() => {
          if (abortController === request) {
            abortController = null;
            pendingCoverage = null;
          }
        });
    };

    const scheduleVisibleStopsLoad = () => {
      const viewport = readViewport();

      if (!viewport) {
        clearUnavailableStops();
        return;
      }

      const loadedCoverageMatches =
        publicTransportStopsCoverageContainsViewport(
          loadedCoverage,
          viewport.viewportExtent,
          viewport.zoom,
          viewport.imageSize,
        );
      const pendingCoverageMatches =
        publicTransportStopsCoverageContainsViewport(
          pendingCoverage,
          viewport.viewportExtent,
          viewport.zoom,
          viewport.imageSize,
        );

      if (loadedCoverageMatches || pendingCoverageMatches) {
        clearDebounce();
        if (loadedCoverageMatches && !pendingCoverageMatches) {
          cancelPendingRequest();
        }
        return;
      }

      // Once the map leaves a pending buffer, its response can no longer serve
      // the new viewport. Abort immediately, then coalesce rapid uncached moves.
      cancelPendingRequest();
      clearDebounce();
      debounceTimer = window.setTimeout(
        loadVisibleStops,
        PUBLIC_TRANSPORT_STOPS_MOVEEND_DEBOUNCE_MS,
      );
    };

    const refreshStopDeclutter = () => {
      applyPublicTransportStopDeclutterVisibility(display, map);
    };

    map.on('moveend', scheduleVisibleStopsLoad);
    map.on('change:size', scheduleVisibleStopsLoad);
    map.getView().on('change:resolution', refreshStopDeclutter);
    map.getView().on('change:rotation', refreshStopDeclutter);
    loadVisibleStops();
    refreshStopDeclutter();

    return () => {
      map.un('moveend', scheduleVisibleStopsLoad);
      map.un('change:size', scheduleVisibleStopsLoad);
      map.getView().un('change:resolution', refreshStopDeclutter);
      map.getView().un('change:rotation', refreshStopDeclutter);
      clearDebounce();
      cancelPendingRequest();
    };
  }, [
    arePublicTransportStopsVisible,
    closeMapInformationPopup,
    language,
    mapRuntimeRef,
  ]);

  // Closure and shooting-danger popup templates are localized server-side,
  // while stop names and modes are reloaded for the selected language.
  useEffect(() => {
    closeMapInformationPopup();
  }, [closeMapInformationPopup, language]);

  /**
   * Keeps stop selections visible with minimal movement, while closure and
   * danger-zone clicks receive more context in the free map region. A resize
   * observer repeats the check when timetable or provider content changes the
   * panel dimensions after its initial render.
   */
  useEffect(() => {
    const runtime = mapRuntimeRef.current;
    const hasAnchoredInformationPopup =
      trailClosurePopup !== null ||
      shootingDangerZonePopup !== null ||
      publicTransportStopPopup !== null;

    if (
      !runtime ||
      !informationAnchorCoordinate ||
      !hasAnchoredInformationPopup
    ) {
      return;
    }

    const appElement = runtime.map.getTargetElement().parentElement;
    const popupElement = appElement?.querySelector<HTMLElement>(
      '.map-information-popup',
    );

    if (!popupElement) {
      return;
    }

    let animationFrameId: number | null = null;
    const keepAnchorVisible = () => {
      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
      }

      animationFrameId = window.requestAnimationFrame(() => {
        animationFrameId = null;
        ensureMapInformationCoordinateVisible(
          runtime.map,
          informationAnchorCoordinate,
          popupElement,
          publicTransportStopPopup === null
            ? 'focus-free-region'
            : 'keep-visible',
        );
      });
    };

    keepAnchorVisible();

    const resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(keepAnchorVisible);
    resizeObserver?.observe(popupElement);

    return () => {
      resizeObserver?.disconnect();

      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
      }
    };
  }, [
    informationAnchorCoordinate,
    mapRuntimeRef,
    publicTransportStopPopup,
    shootingDangerZonePopup,
    trailClosurePopup,
  ]);

  /**
   * Registers one prioritized click pipeline for optional information layers.
   * Already loaded passenger stops win first, then closures, public hiking
   * routes, and finally broad military polygons. This keeps safety lines
   * prominent while allowing a named route inside a danger zone to be selected.
   */
  useEffect(() => {
    const runtime = mapRuntimeRef.current;

    if (!runtime || isRouteCreationActive) {
      if (isRouteCreationActive) {
        closeMapInformationPopup();
      }
      return;
    }

    const { map } = runtime;

    const handleInformationLayerClick = (event: MapBrowserEvent) => {
      const imageSize = map.getSize();
      const zoom = map.getView().getZoom();

      if (!imageSize || zoom === undefined) {
        return;
      }

      // Mobile map-only mode reacts immediately instead of waiting for several
      // sequential GeoAdmin identify calls. A real feature selection restores
      // the chrome through `onInformationSelected`; only a genuinely empty click
      // leaves the optimistic toggle in place.
      const preserveSelectionOnEmptyClick = onMapClickStart?.() ?? false;

      if (!preserveSelectionOnEmptyClick) {
        // Desktop keeps the established immediate-dismiss behaviour rather than
        // waiting for the asynchronous identify pipeline to prove the click empty.
        closeMapInformationPopup();
      }

      const canInspectStops =
        arePublicTransportStopsVisible &&
        zoom > PUBLIC_TRANSPORT_STOPS_MIN_ZOOM;
      const canInspectClosures =
        areTrailClosuresVisible && zoom > HIKING_TRAILS_MIN_ZOOM;
      const canInspectSwitzerlandMobilityHiking =
        isSwitzerlandMobilityHikingVisible &&
        zoom > SWITZERLAND_MOBILITY_HIKING_MIN_ZOOM;
      const canInspectShootingDangerZones =
        areShootingDangerZonesVisible && zoom > HIKING_TRAILS_MIN_ZOOM;

      if (
        !canInspectStops &&
        !canInspectClosures &&
        !canInspectSwitzerlandMobilityHiking &&
        !canInspectShootingDangerZones
      ) {
        handleEmptyMapClick(preserveSelectionOnEmptyClick);
        return;
      }

      if (canInspectStops) {
        const stopDisplay = runtime.publicTransportStopsDisplay;
        const stop = map.forEachFeatureAtPixel(
          event.pixel,
          (feature) => getPublicTransportStopFromFeature(feature),
          {
            hitTolerance: PUBLIC_TRANSPORT_STOP_HIT_TOLERANCE_PX,
            layerFilter: (layer) => layer === stopDisplay.layer,
          },
        );

        // A rendered stop can represent hidden declutter neighbours. Only a
        // genuine layer hit reaches this lookup, so invisible stops never become
        // arbitrary click targets on otherwise empty map space.
        if (stop) {
          const stopChoices = getPublicTransportStopChoicesForVisibleStop(
            stopDisplay,
            map,
            stop,
          );
          closeMapInformationPopup();
          onInformationSelected();
          setInformationAnchorCoordinate([...event.coordinate] as Coordinate);

          if (stopChoices.length > 1) {
            updatePublicTransportStopDeclutterPriority(
              stopDisplay,
              stop.id,
            );
            applyPublicTransportStopDeclutterVisibility(stopDisplay, map);
            setPublicTransportStopPopup({
              state: 'choices',
              stops: stopChoices,
            });
          } else {
            selectPublicTransportStop(stop);
          }
          return;
        }
      }

      if (
        !canInspectClosures &&
        !canInspectSwitzerlandMobilityHiking &&
        !canInspectShootingDangerZones
      ) {
        handleEmptyMapClick(preserveSelectionOnEmptyClick);
        return;
      }

      informationRequestRef.current?.abort();
      const abortController = new AbortController();
      informationRequestRef.current = abortController;
      const context = {
        coordinate: [...event.coordinate] as Coordinate,
        mapExtent: map.getView().calculateExtent(imageSize),
        imageSize: [imageSize[0], imageSize[1]] as [number, number],
        language,
      };

      void (async () => {
        try {
          if (canInspectClosures) {
            try {
              const closure = await identifyTrailClosure(
                context,
                abortController.signal,
              );

              if (closure && !abortController.signal.aborted) {
                replaceWithNonRouteInformation();
                setInformationAnchorCoordinate(context.coordinate);
                setTrailClosurePopup({ state: 'loading', html: null });
                const html = await fetchTrailClosurePopup(
                  closure,
                  abortController.signal,
                );

                if (!abortController.signal.aborted) {
                  setTrailClosurePopup({ state: 'ready', html });
                }
                return;
              }
            } catch (error: unknown) {
              if (isAbortedRequest(error, abortController.signal)) {
                return;
              }

              console.error('Unable to load trail-closure details.', error);
              replaceWithNonRouteInformation();
              setInformationAnchorCoordinate(context.coordinate);
              setTrailClosurePopup({ state: 'error', html: null });
              return;
            }
          }

          if (canInspectSwitzerlandMobilityHiking) {
            const routeSelected = await inspectSwitzerlandMobilityHikingAt(
              context,
              abortController.signal,
            );

            if (routeSelected || abortController.signal.aborted) {
              return;
            }
          }

          if (canInspectShootingDangerZones) {
            try {
              const dangerZone = await identifyShootingDangerZone(
                context,
                abortController.signal,
              );

              if (dangerZone && !abortController.signal.aborted) {
                replaceWithNonRouteInformation();
                setInformationAnchorCoordinate(context.coordinate);
                updateShootingDangerZoneSelection(
                  runtime.shootingDangerZoneSelectionDisplay,
                  dangerZone,
                );
                setShootingDangerZonePopup({
                  state: 'loading',
                  html: null,
                });
                const html = await fetchShootingDangerZonePopup(
                  dangerZone,
                  abortController.signal,
                );

                if (!abortController.signal.aborted) {
                  setShootingDangerZonePopup({ state: 'ready', html });
                }
                return;
              }
            } catch (error: unknown) {
              if (isAbortedRequest(error, abortController.signal)) {
                return;
              }

              console.error(
                'Unable to load shooting danger-zone details.',
                error,
              );
              replaceWithNonRouteInformation();
              setInformationAnchorCoordinate(context.coordinate);
              setShootingDangerZonePopup({ state: 'error', html: null });
              return;
            }
          }

          if (!abortController.signal.aborted) {
            handleEmptyMapClick(preserveSelectionOnEmptyClick);
          }
        } finally {
          if (informationRequestRef.current === abortController) {
            informationRequestRef.current = null;
          }
        }
      })();
    };

    const handleInformationLayerZoomChange = () => {
      const zoom = map.getView().getZoom();

      if (zoom === undefined) {
        closeMapInformationPopup();
        return;
      }

      // A selected named route stays useful after its one-time full-geometry fit,
      // even when that fit zooms below the overview portrayal's minimum scale.
      const isAnyLayerVisibleAtZoom =
        switzerlandMobilityHikingPanelRef.current !== null ||
        (arePublicTransportStopsVisible &&
          zoom > PUBLIC_TRANSPORT_STOPS_MIN_ZOOM) ||
        (isSwitzerlandMobilityHikingVisible &&
          zoom > SWITZERLAND_MOBILITY_HIKING_MIN_ZOOM) ||
        ((areTrailClosuresVisible || areShootingDangerZonesVisible) &&
          zoom > HIKING_TRAILS_MIN_ZOOM);

      if (!isAnyLayerVisibleAtZoom) {
        closeMapInformationPopup();
      }
    };

    map.on('singleclick', handleInformationLayerClick);
    map.getView().on('change:resolution', handleInformationLayerZoomChange);

    return () => {
      map.un('singleclick', handleInformationLayerClick);
      map.getView().un(
        'change:resolution',
        handleInformationLayerZoomChange,
      );
      informationRequestRef.current?.abort();
      informationRequestRef.current = null;
    };
  }, [
    arePublicTransportStopsVisible,
    areShootingDangerZonesVisible,
    areTrailClosuresVisible,
    closeMapInformationPopup,
    handleEmptyMapClick,
    inspectSwitzerlandMobilityHikingAt,
    isRouteCreationActive,
    isSwitzerlandMobilityHikingVisible,
    language,
    mapRuntimeRef,
    onMapClickStart,
    onInformationSelected,
    replaceWithNonRouteInformation,
    selectPublicTransportStop,
  ]);

  useEffect(
    () => () => {
      informationRequestRef.current?.abort();
    },
    [],
  );

  return {
    areTrailClosuresVisible,
    setAreTrailClosuresVisible,
    areShootingDangerZonesVisible,
    setAreShootingDangerZonesVisible,
    arePublicTransportStopsVisible,
    setArePublicTransportStopsVisible,
    trailClosurePopup,
    shootingDangerZonePopup,
    publicTransportStopPopup,
    selectPublicTransportStop,
    switzerlandMobilityHikingPanel,
    selectSwitzerlandMobilityHikingCandidate,
    switzerlandMobilityHikingMapHoverDistanceMeters,
    handleSwitzerlandMobilityHikingProfileHoverDistanceChange,
    closeMapInformationPopup,
    dismissSwitzerlandMobilityHikingPanel,
  };
}
