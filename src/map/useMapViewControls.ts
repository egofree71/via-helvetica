/**
 * Business context: owns the compact controls that navigate and configure the
 * shared map without changing itinerary state. It keeps the selected official
 * background, rendered hiking-trail and SwitzerlandMobility preferences, zoom,
 * fullscreen requests, and explicit browser geolocation feedback outside the
 * application shell.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { containsCoordinate } from 'ol/extent.js';
import type { TranslationKey } from '../i18n/translations';
import {
  DEFAULT_BASE_MAP_STYLE,
  isWgs84CoordinateInsideMapBounds,
  MAP_EXTENT,
  USER_LOCATION_ZOOM,
  type BaseMapStyle,
} from './config';
import type { MapRuntime } from './mapRuntime';
import { fromWgs84 } from './projection';
import { updateUserLocationMarker } from './userLocation';

/** Browser geolocation state used by the location control and its feedback. */
export type LocationStatus = 'idle' | 'locating' | 'located' | 'error';

/** Inputs required by the map-view control capability. */
export interface UseMapViewControlsOptions {
  /** Shared OpenLayers runtime whose view and layers are controlled. */
  mapRuntimeRef: RefObject<MapRuntime | null>;
  /** Application root that enters and leaves browser fullscreen. */
  fullscreenElementRef: RefObject<HTMLElement | null>;
  /** Persisted hiking-trail choice captured before the map is created. */
  initialHikingTrailsVisibility: boolean;
  /** Persisted SwitzerlandMobility hiking choice captured before map creation. */
  initialSwitzerlandMobilityHikingVisibility: boolean;
  /** Current fullscreen state published by the runtime lifecycle hook. */
  isFullscreen: boolean;
  /** Typed interface translation helper. */
  t: (key: TranslationKey) => string;
}

/** State and actions consumed by the compact map controls. */
export interface MapViewControlsController {
  /** Selected official background style. */
  baseMapStyle: BaseMapStyle;
  /** Replaces the selected official background. */
  setBaseMapStyle: (style: BaseMapStyle) => void;
  /** Whether the rendered official hiking overlay is visible. */
  areHikingTrailsVisible: boolean;
  /** Shows or hides the rendered official hiking overlay. */
  setAreHikingTrailsVisible: (visible: boolean) => void;
  /** Whether official SwitzerlandMobility hiking routes are visible. */
  isSwitzerlandMobilityHikingVisible: boolean;
  /** Shows or hides official SwitzerlandMobility hiking routes. */
  setIsSwitzerlandMobilityHikingVisible: (visible: boolean) => void;
  /** Current browser geolocation request state. */
  locationStatus: LocationStatus;
  /** Temporary localized geolocation feedback. */
  locationMessage: string;
  /** Accessible label for the geolocation control. */
  locationButtonLabel: string;
  /** Accessible label for the fullscreen control. */
  fullscreenButtonLabel: string;
  /** Animates the map by one relative zoom step. */
  changeZoom: (delta: number) => void;
  /** Enters or leaves browser fullscreen for the application root. */
  toggleFullscreen: () => Promise<void>;
  /** Requests one explicit browser position and recentres the map. */
  locateUser: () => void;
}

/** Duration in milliseconds for transient geolocation feedback. */
const LOCATION_MESSAGE_DURATION_MS = 6_000;
/** Browser preference key for the rendered hiking-trail overlay. */
const HIKING_TRAILS_VISIBILITY_STORAGE_KEY =
  'via-helvetica.hiking-trails-visible';
/** Browser preference key for the optional SwitzerlandMobility hiking overlay. */
const SWITZERLAND_MOBILITY_HIKING_VISIBILITY_STORAGE_KEY =
  'via-helvetica.switzerland-mobility-hiking-visible';

/** Restores the hiking-trail preference, which is enabled by default. */
export function resolveInitialHikingTrailsVisibility(): boolean {
  try {
    return (
      window.localStorage.getItem(
        HIKING_TRAILS_VISIBILITY_STORAGE_KEY,
      ) !== 'false'
    );
  } catch {
    return true;
  }
}

/** Restores the SwitzerlandMobility hiking preference, disabled by default. */
export function resolveInitialSwitzerlandMobilityHikingVisibility(): boolean {
  try {
    return (
      window.localStorage.getItem(
        SWITZERLAND_MOBILITY_HIKING_VISIBILITY_STORAGE_KEY,
      ) === 'true'
    );
  } catch {
    return false;
  }
}

/**
 * Coordinates map background, overlay, navigation, and geolocation controls.
 *
 * @param options - Shared runtime, fullscreen root, and translation helper.
 * @returns Render state and stable actions for the map control strip.
 */
export function useMapViewControls(
  options: UseMapViewControlsOptions,
): MapViewControlsController {
  const locationMessageTimerRef = useRef<number | null>(null);
  const [baseMapStyle, setBaseMapStyle] = useState<BaseMapStyle>(
    DEFAULT_BASE_MAP_STYLE,
  );
  const [areHikingTrailsVisible, setAreHikingTrailsVisible] = useState(
    options.initialHikingTrailsVisibility,
  );
  const [
    isSwitzerlandMobilityHikingVisible,
    setIsSwitzerlandMobilityHikingVisible,
  ] = useState(options.initialSwitzerlandMobilityHikingVisibility);
  const [locationStatus, setLocationStatus] =
    useState<LocationStatus>('idle');
  const [locationMessage, setLocationMessage] = useState('');

  const clearLocationMessageTimer = useCallback(() => {
    if (locationMessageTimerRef.current !== null) {
      window.clearTimeout(locationMessageTimerRef.current);
      locationMessageTimerRef.current = null;
    }
  }, []);

  const showTemporaryLocationMessage = useCallback(
    (message: string) => {
      clearLocationMessageTimer();
      setLocationMessage(message);

      locationMessageTimerRef.current = window.setTimeout(() => {
        setLocationMessage('');
        locationMessageTimerRef.current = null;
      }, LOCATION_MESSAGE_DURATION_MS);
    },
    [clearLocationMessageTimer],
  );

  const changeZoom = useCallback(
    (delta: number) => {
      const view = options.mapRuntimeRef.current?.map.getView();
      const currentZoom = view?.getZoom();

      if (!view || currentZoom === undefined) {
        return;
      }

      view.animate({
        zoom: currentZoom + delta,
        duration: 200,
      });
    },
    [options.mapRuntimeRef],
  );

  const toggleFullscreen = useCallback(async () => {
    const app = options.fullscreenElementRef.current;

    if (!app || !document.fullscreenEnabled) {
      return;
    }

    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await app.requestFullscreen();
      }
    } catch (error) {
      console.error('Unable to toggle fullscreen mode.', error);
    }
  }, [options.fullscreenElementRef]);

  const locateUser = useCallback(() => {
    const map = options.mapRuntimeRef.current?.map;
    const marker = options.mapRuntimeRef.current?.userLocationMarker;

    if (!map || !marker) {
      return;
    }

    if (!navigator.geolocation) {
      setLocationStatus('error');
      showTemporaryLocationMessage(options.t('geolocation.unavailable'));
      return;
    }

    clearLocationMessageTimer();
    setLocationMessage(options.t('geolocation.searching'));
    setLocationStatus('locating');

    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const wgs84Coordinate = [coords.longitude, coords.latitude];

        if (!isWgs84CoordinateInsideMapBounds(wgs84Coordinate)) {
          setLocationStatus('error');
          showTemporaryLocationMessage(options.t('geolocation.outside'));
          return;
        }

        const coordinate = fromWgs84(wgs84Coordinate);

        if (!containsCoordinate(MAP_EXTENT, coordinate)) {
          setLocationStatus('error');
          showTemporaryLocationMessage(options.t('geolocation.outside'));
          return;
        }

        updateUserLocationMarker(marker, coordinate);

        const view = map.getView();
        const currentZoom = view.getZoom() ?? USER_LOCATION_ZOOM;

        view.animate({
          center: coordinate,
          zoom: Math.max(currentZoom, USER_LOCATION_ZOOM),
          duration: 600,
        });

        clearLocationMessageTimer();
        setLocationMessage('');
        setLocationStatus('located');
      },
      (error) => {
        const messages: Record<number, string> = {
          [GeolocationPositionError.PERMISSION_DENIED]: options.t(
            'geolocation.permissionDenied',
          ),
          [GeolocationPositionError.POSITION_UNAVAILABLE]: options.t(
            'geolocation.positionUnavailable',
          ),
          [GeolocationPositionError.TIMEOUT]: options.t(
            'geolocation.timeout',
          ),
        };

        setLocationStatus('error');
        showTemporaryLocationMessage(
          messages[error.code] ?? options.t('geolocation.error'),
        );
      },
      {
        enableHighAccuracy: true,
        timeout: 10_000,
        maximumAge: 30_000,
      },
    );
  }, [
    clearLocationMessageTimer,
    options.mapRuntimeRef,
    options.t,
    showTemporaryLocationMessage,
  ]);

  useEffect(() => {
    options.mapRuntimeRef.current?.setBaseMapStyle(baseMapStyle);
  }, [baseMapStyle, options.mapRuntimeRef]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        HIKING_TRAILS_VISIBILITY_STORAGE_KEY,
        String(areHikingTrailsVisible),
      );
    } catch {
      // Layer visibility remains functional when browser storage is unavailable.
    }
  }, [areHikingTrailsVisible]);

  useEffect(() => {
    options.mapRuntimeRef.current?.setHikingTrailsVisible(
      areHikingTrailsVisible,
    );
  }, [areHikingTrailsVisible, options.mapRuntimeRef]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        SWITZERLAND_MOBILITY_HIKING_VISIBILITY_STORAGE_KEY,
        String(isSwitzerlandMobilityHikingVisible),
      );
    } catch {
      // Layer visibility remains functional when browser storage is unavailable.
    }
  }, [isSwitzerlandMobilityHikingVisible]);

  useEffect(() => {
    options.mapRuntimeRef.current?.setSwitzerlandMobilityHikingVisible(
      isSwitzerlandMobilityHikingVisible,
    );
  }, [isSwitzerlandMobilityHikingVisible, options.mapRuntimeRef]);

  useEffect(
    () => () => {
      clearLocationMessageTimer();
    },
    [clearLocationMessageTimer],
  );

  return {
    baseMapStyle,
    setBaseMapStyle,
    areHikingTrailsVisible,
    setAreHikingTrailsVisible,
    isSwitzerlandMobilityHikingVisible,
    setIsSwitzerlandMobilityHikingVisible,
    locationStatus,
    locationMessage,
    locationButtonLabel:
      locationStatus === 'located'
        ? options.t('geolocation.recenter')
        : options.t('geolocation.show'),
    fullscreenButtonLabel: options.isFullscreen
      ? options.t('map.fullscreenExit')
      : options.t('map.fullscreenEnter'),
    changeZoom,
    toggleFullscreen,
    locateUser,
  };
}
