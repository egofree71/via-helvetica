/**
 * Business context: coordinates the map-centred application shell around one
 * disposable OpenLayers runtime. It composes search, geolocation, editable-route,
 * editable and read-only itinerary, information-layer, and metrics capabilities
 * while delegating their imperative lifecycles and provider contracts to focused
 * modules.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { containsCoordinate } from 'ol/extent.js';
import AboutDialog from './components/AboutDialog';
import ReleaseNotesDialog from './components/ReleaseNotesDialog';
import MapLayersSelector from './components/MapLayersSelector';
import LanguageSelector from './components/LanguageSelector';
import LocationSearch from './components/LocationSearch';
import RouteImportControl from './components/RouteImportControl';
import RouteControls from './components/RouteControls';
import RouteExportDialog from './components/RouteExportDialog';
import PublicTransportStopPopup from './components/PublicTransportStopPopup';
import ShootingDangerZonePopup from './components/ShootingDangerZonePopup';
import TrailClosurePopup from './components/TrailClosurePopup';
import SwitzerlandMobilityHikingPanel from './components/SwitzerlandMobilityHikingPanel';
import RouteStatistics from './components/RouteStatistics';
import {
  createNamedImportedGpxDocument,
  createRouteGpx,
  createRouteSegmentsGpx,
  downloadGpxDocument,
} from './export/gpx';
import {
  isEditableImportedRoutePristine as isEditableImportedRoutePristineState,
  resolveExactImportedRouteSource,
  resolveItineraryExportSource,
  type EditableImportedRouteExportOrigin,
} from './export/itineraryExportSource';
import { useI18n } from './i18n/I18nContext';
import {
  createSwisstopoShare,
  isSwisstopoShareConfigured,
  type SwisstopoShare,
} from './share/swisstopoShare';
import {
  COORDINATE_SEARCH_ZOOM,
  isWgs84CoordinateInsideMapBounds,
  LOCATION_SEARCH_ZOOM,
  MAP_EXTENT,
} from './map/config';
import { fromWgs84 } from './map/projection';
import {
  createEditableRouteFromImportedGeometry,
  ImportedRouteSparseGeometryError,
  ImportedRouteTooManyVerticesError,
  MAX_EDITABLE_IMPORTED_VERTEX_COUNT,
} from './map/importedRouteConversion';
import { useEditableRoute } from './map/useEditableRoute';
import { useImportedRoute } from './map/useImportedRoute';
import {
  resolveInitialMapInformationLayerVisibility,
  useMapInformationLayers,
} from './map/useMapInformationLayers';
import { useMapRuntime } from './map/useMapRuntime';
import {
  resolveInitialMapLayerOpacities,
  useMapLayerOpacities,
} from './map/useMapLayerOpacities';
import {
  resolveInitialHikingTrailsVisibility,
  resolveInitialSwitzerlandMobilityHikingVisibility,
  useMapViewControls,
} from './map/useMapViewControls';
import {
  clearSearchResultMarker,
  updateSearchResultMarker,
} from './map/searchResult';
import { useItineraryMetrics } from './metrics/useItineraryMetrics';
import type { RouteElevationSummary } from './metrics/routeMetrics';
import type { LocationSearchResult } from './search/locationSearch';
import {
  getCurrentReleaseDialogItems,
  markCurrentReleaseSeen,
  shouldShowCurrentRelease,
} from './releases/releaseHistory';

/** Itinerary source named by the shared GPX export dialog. */
type RouteExportSource = 'editable' | 'imported' | 'switzerlandMobility';

/** Original GPX resources retained while a converted editable route may return to pristine. */
interface EditableImportedRouteOrigin extends EditableImportedRouteExportOrigin {
  /** Embedded GPX profile retained while geometry remains pristine. */
  elevationSummary: RouteElevationSummary | null;
}

/**
 * Builds an unambiguous local timestamp for the proposed GPX name. The ISO-like
 * date order works consistently in every interface language, while the colon
 * remains readable inside the GPX and is sanitized only for the filename.
 */
function createRouteExportDefaultName(baseName: string, date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const datePart = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const timePart = `${pad(date.getHours())}:${pad(date.getMinutes())}`;

  return `${baseName} — ${datePart} ${timePart}`;
}

/** Root application coordinator for UI state and map-level workflows. */
export default function App() {
  const { language, locale, t } = useI18n();
  const appRef = useRef<HTMLElement>(null);
  const mapTargetRef = useRef<HTMLDivElement>(null);

  const [isAboutDialogOpen, setIsAboutDialogOpen] = useState(false);
  const [isReleaseNotesDialogOpen, setIsReleaseNotesDialogOpen] =
    useState(false);
  const [shouldAnnounceCurrentRelease, setShouldAnnounceCurrentRelease] =
    useState(() => {
      if (getCurrentReleaseDialogItems(language).length === 0) {
        // A release may remain in the complete history without having compact
        // highlights worth blocking the map with an empty announcement.
        markCurrentReleaseSeen();
        return false;
      }

      return shouldShowCurrentRelease();
    });
  const [isRouteExportDialogOpen, setIsRouteExportDialogOpen] =
    useState(false);
  const [isMobileSearchOpen, setIsMobileSearchOpen] = useState(false);
  const [locationSearchResetVersion, setLocationSearchResetVersion] =
    useState(0);
  const [routeExportDefaultName, setRouteExportDefaultName] = useState('');
  const [routeExportSource, setRouteExportSource] =
    useState<RouteExportSource>('editable');
  const [editableImportedRouteOrigin, setEditableImportedRouteOrigin] =
    useState<EditableImportedRouteOrigin | null>(null);
  const initialHikingTrailsVisibility = useMemo(
    resolveInitialHikingTrailsVisibility,
    [],
  );
  const initialSwitzerlandMobilityHikingVisibility = useMemo(
    resolveInitialSwitzerlandMobilityHikingVisibility,
    [],
  );
  const initialMapInformationVisibility = useMemo(
    resolveInitialMapInformationLayerVisibility,
    [],
  );
  const initialMapLayerOpacities = useMemo(
    resolveInitialMapLayerOpacities,
    [],
  );
  const {
    runtimeRef: mapRuntimeRef,
    status,
    isFullscreen,
  } = useMapRuntime({
    mapTargetRef,
    fullscreenElementRef: appRef,
    initialVisibility: {
      hikingTrails: initialHikingTrailsVisibility,
      switzerlandMobilityHiking:
        initialSwitzerlandMobilityHikingVisibility,
      trailClosures: initialMapInformationVisibility.trailClosures,
      shootingDangerZones:
        initialMapInformationVisibility.shootingDangerZones,
      publicTransportStops:
        initialMapInformationVisibility.publicTransportStops,
    },
    initialOpacity: initialMapLayerOpacities,
  });
  const { layerOpacities, setLayerOpacity } = useMapLayerOpacities({
    mapRuntimeRef,
    initialOpacities: initialMapLayerOpacities,
  });

  useEffect(() => {
    if (status === 'ready' && shouldAnnounceCurrentRelease) {
      // Wait for the map to become usable so the first visit is not covered by
      // both a startup status and a release announcement at the same time.
      setIsReleaseNotesDialogOpen(true);
    }
  }, [shouldAnnounceCurrentRelease, status]);

  const {
    baseMapStyle,
    setBaseMapStyle,
    areHikingTrailsVisible,
    setAreHikingTrailsVisible,
    isSwitzerlandMobilityHikingVisible,
    setIsSwitzerlandMobilityHikingVisible,
    locationStatus,
    locationMessage,
    locationButtonLabel,
    fullscreenButtonLabel,
    changeZoom,
    toggleFullscreen,
    locateUser,
  } = useMapViewControls({
    mapRuntimeRef,
    fullscreenElementRef: appRef,
    initialHikingTrailsVisibility,
    initialSwitzerlandMobilityHikingVisibility,
    isFullscreen,
    t,
  });

  /**
   * Clears both the temporary marker and the search control when another map
   * workflow takes priority over the selected location.
   */
  const clearSelectedSearchResult = useCallback(() => {
    const marker = mapRuntimeRef.current?.searchResultMarker;

    if (marker) {
      clearSearchResultMarker(marker);
    }

    setLocationSearchResetVersion((version) => version + 1);
  }, [mapRuntimeRef]);

  /** Removes only the temporary marker while preserving focus and typed text. */
  const clearSearchResultMarkerOnly = useCallback(() => {
    const marker = mapRuntimeRef.current?.searchResultMarker;

    if (marker) {
      clearSearchResultMarker(marker);
    }
  }, [mapRuntimeRef]);

  useEffect(() => {
    const marker = mapRuntimeRef.current?.searchResultMarker;

    // A selected location and its label belong to the same temporary search
    // context. A language change invalidates both instead of leaving an
    // unexplained marker after the search control has been reset.
    if (marker) {
      clearSearchResultMarker(marker);
    }
  }, [language, mapRuntimeRef]);

  const {
    routeHistory,
    routeCoordinates,
    isRouteCreationActive,
    isRouteSnapEnabled,
    isRouteOperationPending,
    routeMessage,
    routeMessageType,
    routeContextHint,
    isRoutePointerInteractionActive,
    toggleRouteCreation,
    toggleRouteSnap,
    undoRoutePoint,
    redoRoutePoint,
    reverseRoute,
    toggleRouteLoop,
    deleteRoute,
    startEditingFromRouteState,
    replaceWithReadOnlyItinerary,
    showTemporaryRouteMessage,
    isPointerInteractionActive,
  } = useEditableRoute({
    mapRuntimeRef,
    mapTargetRef,
    locale,
    t,
  });

  const handleImportedRouteAccepted = useCallback(() => {
    clearSelectedSearchResult();
    setEditableImportedRouteOrigin(null);
    replaceWithReadOnlyItinerary();
  }, [clearSelectedSearchResult, replaceWithReadOnlyItinerary]);

  const handleImportedRouteError = useCallback(
    (message: string) => showTemporaryRouteMessage(message, 'error'),
    [showTemporaryRouteMessage],
  );

  const {
    segments: importedRouteSegments,
    source: importedRouteSource,
    elevationSummary: importedRouteElevationSummary,
    importRouteFile,
    clearImportedRoute,
  } = useImportedRoute({
    mapRuntimeRef,
    t,
    onImportAccepted: handleImportedRouteAccepted,
    onImportError: handleImportedRouteError,
  });

  const isEditableImportedRoutePristine =
    isEditableImportedRoutePristineState(
      routeHistory,
      editableImportedRouteOrigin,
    );

  /** Converts the current continuous GPX to editable state without rerouting. */
  const editImportedRoute = useCallback(() => {
    if (!importedRouteSource || importedRouteSegments.length !== 1) {
      showTemporaryRouteMessage(
        t('route.editImportedSingleSegmentOnly'),
        'error',
      );
      return;
    }

    const coordinates = importedRouteSegments[0];

    if (coordinates.length > MAX_EDITABLE_IMPORTED_VERTEX_COUNT) {
      showTemporaryRouteMessage(
        t('route.editImportedTooManyPoints', {
          maximum: MAX_EDITABLE_IMPORTED_VERTEX_COUNT.toLocaleString(locale),
        }),
        'error',
      );
      return;
    }

    if (
      coordinates.some(
        (coordinate) => !containsCoordinate(MAP_EXTENT, coordinate),
      )
    ) {
      showTemporaryRouteMessage(t('route.editImportedOutsideMap'), 'error');
      return;
    }

    try {
      const state = createEditableRouteFromImportedGeometry(coordinates);

      setEditableImportedRouteOrigin({
        source: importedRouteSource,
        elevationSummary: importedRouteElevationSummary,
        pristineState: state,
      });
      clearSelectedSearchResult();
      clearImportedRoute();
      startEditingFromRouteState(state);
    } catch (error) {
      if (error instanceof ImportedRouteTooManyVerticesError) {
        showTemporaryRouteMessage(
          t('route.editImportedTooManyPoints', {
            maximum: error.maximumVertexCount.toLocaleString(locale),
          }),
          'error',
        );
        return;
      }

      if (error instanceof ImportedRouteSparseGeometryError) {
        showTemporaryRouteMessage(
          t('route.editImportedSparseGeometry', {
            maximum: error.maximumDistanceMeters / 1_000,
          }),
          'error',
        );
        return;
      }

      console.error(
        'Unable to convert the imported GPX to an editable route.',
        error,
      );
      showTemporaryRouteMessage(t('route.editImportedError'), 'error');
    }
  }, [
    clearImportedRoute,
    clearSelectedSearchResult,
    importedRouteElevationSummary,
    importedRouteSegments,
    importedRouteSource,
    locale,
    showTemporaryRouteMessage,
    startEditingFromRouteState,
    t,
  ]);

  /** Makes one validated public route the sole current itinerary. */
  const handleSwitzerlandMobilityHikingRouteAccepted = useCallback(() => {
    clearSelectedSearchResult();
    clearImportedRoute();
    setEditableImportedRouteOrigin(null);
    replaceWithReadOnlyItinerary();
  }, [
    clearImportedRoute,
    clearSelectedSearchResult,
    replaceWithReadOnlyItinerary,
  ]);

  const previousRouteStepCountRef = useRef(routeHistory.steps.length);

  useEffect(() => {
    const routeStepCount = routeHistory.steps.length;
    const hasAddedRoutePoint =
      isRouteCreationActive &&
      routeStepCount > previousRouteStepCountRef.current;

    previousRouteStepCountRef.current = routeStepCount;

    if (!hasAddedRoutePoint) {
      return;
    }

    const marker = mapRuntimeRef.current?.searchResultMarker;

    // Keep the searched position available as a target while route mode is
    // merely armed. The first committed route point then owns the map context.
    if (marker?.feature.getGeometry()) {
      clearSelectedSearchResult();
    }
  }, [
    clearSelectedSearchResult,
    isRouteCreationActive,
    mapRuntimeRef,
    routeHistory.steps.length,
  ]);

  const handleToggleRouteCreation = useCallback(() => {
    if (!isRouteCreationActive) {
      // Invalidate a pending File.text() read even before an imported source is
      // available, otherwise a late GPX result could replace a newly started route.
      clearImportedRoute();

      if (importedRouteSource) {
        setEditableImportedRouteOrigin(null);
      }
    }

    toggleRouteCreation();
  }, [
    clearImportedRoute,
    importedRouteSource,
    isRouteCreationActive,
    toggleRouteCreation,
  ]);

  /** Clears the route and any retained GPX origin that no longer has geometry. */
  const handleDeleteRoute = useCallback(() => {
    deleteRoute();
    setEditableImportedRouteOrigin(null);
  }, [deleteRoute]);

  const {
    areTrailClosuresVisible,
    setAreTrailClosuresVisible,
    areShootingDangerZonesVisible,
    setAreShootingDangerZonesVisible,
    arePublicTransportStopsVisible,
    setArePublicTransportStopsVisible,
    trailClosurePopup,
    shootingDangerZonePopup,
    publicTransportStopPopup,
    switzerlandMobilityHikingPanel,
    selectSwitzerlandMobilityHikingCandidate,
    switzerlandMobilityHikingMapHoverDistanceMeters,
    handleSwitzerlandMobilityHikingProfileHoverDistanceChange,
    closeMapInformationPopup,
    dismissSwitzerlandMobilityHikingPanel,
  } = useMapInformationLayers({
    mapRuntimeRef,
    initialVisibility: initialMapInformationVisibility,
    language,
    isSwitzerlandMobilityHikingVisible,
    isRouteCreationActive,
    onInformationSelected: clearSelectedSearchResult,
    onSwitzerlandMobilityHikingRouteAccepted:
      handleSwitzerlandMobilityHikingRouteAccepted,
  });

  const {
    activeRouteSegments,
    distanceMeters: routeDistanceMeters,
    elevationStatus: routeElevationStatus,
    elevation: routeElevation,
    durationMinutes: routeDurationMinutes,
    mapHoverDistanceMeters: routeMapHoverDistanceMeters,
    handleProfileHoverDistanceChange,
  } = useItineraryMetrics({
    mapRuntimeRef,
    editableRouteCoordinates: routeCoordinates,
    importedRouteSegments,
    embeddedRouteElevationSummary:
      importedRouteElevationSummary ??
      (isEditableImportedRoutePristine
        ? editableImportedRouteOrigin?.elevationSummary ?? null
        : null),
    isRoutePointerInteractionActive,
    // The selected public route owns the shared black marker and profile cursor
    // while it is the current read-only itinerary.
    isProfileInteractionEnabled:
      switzerlandMobilityHikingPanel === null,
    isPointerInteractionActive,
    isRouteOperationPending,
  });

  /** Opens project information after dismissing any map-feature popup behind it. */
  const openAboutDialog = useCallback(() => {
    closeMapInformationPopup();
    setIsAboutDialogOpen(true);
  }, [closeMapInformationPopup]);

  /** Acknowledges the current release before dismissing its one-time dialog. */
  const closeReleaseNotesDialog = useCallback(() => {
    markCurrentReleaseSeen();
    setShouldAnnounceCurrentRelease(false);
    setIsReleaseNotesDialogOpen(false);
  }, []);

  /** Places a temporary marker and frames one place or coordinate result. */
  const selectSearchResult = (result: LocationSearchResult) => {
    const map = mapRuntimeRef.current?.map;
    const marker = mapRuntimeRef.current?.searchResultMarker;

    if (!map || !marker) {
      return;
    }

    const wgs84Coordinate = [result.longitude, result.latitude];

    if (!isWgs84CoordinateInsideMapBounds(wgs84Coordinate)) {
      return;
    }

    const coordinate = fromWgs84(wgs84Coordinate);

    if (!containsCoordinate(MAP_EXTENT, coordinate)) {
      return;
    }

    updateSearchResultMarker(marker, coordinate);

    const isCoordinateResult =
      result.origin === 'wgs84' || result.origin === 'lv95';

    // A coordinate denotes an exact point, unlike a locality or postal-code
    // result, so it uses the same close planning scale as explicit geolocation.
    map.getView().animate({
      center: coordinate,
      zoom: isCoordinateResult
        ? COORDINATE_SEARCH_ZOOM
        : LOCATION_SEARCH_ZOOM,
      duration: 600,
    });
  };

  /** Opens the shared export/share dialog for whichever itinerary is current. */
  const requestCurrentItineraryExport = () => {
    if (switzerlandMobilityHikingPanel?.state === 'ready') {
      const route = switzerlandMobilityHikingPanel.route;
      const baseName = route.routeName
        ?? (route.routeNumber
          ? t('switzerlandMobilityHiking.routeNumber', {
              number: route.routeNumber,
            })
          : t('switzerlandMobilityHiking.unnamedRoute'));
      const stageName = route.stageNumber
        ? `${baseName} — ${t('switzerlandMobilityHiking.stage', {
            number: route.stageNumber,
          })}`
        : baseName;

      setRouteExportDefaultName(
        route.sectionName
          ? `${stageName} — ${route.sectionName}`
          : stageName,
      );
      setRouteExportSource('switzerlandMobility');
      setIsRouteExportDialogOpen(true);
      return;
    }

    const source = resolveItineraryExportSource({
      importedRouteSource,
      editableImportedRouteOrigin,
      routeHistory,
      isRouteOperationPending,
    });

    if (!source) {
      return;
    }

    if (source.kind === 'imported') {
      setRouteExportDefaultName(source.source.name);
      setRouteExportSource('imported');
      setIsRouteExportDialogOpen(true);
      return;
    }

    setRouteExportDefaultName(
      editableImportedRouteOrigin?.source.name ??
        createRouteExportDefaultName(t('gpx.routeName')),
    );
    setRouteExportSource('editable');
    setIsRouteExportDialogOpen(true);
  };

  /**
   * Builds the GPX document for the export source selected when the dialog opened.
   * The same document is used for local download and the optional swisstopo hand-off
   * so both actions preserve the same pristine/imported versus generated semantics.
   *
   * @param routeName - User-confirmed name written into the exported GPX.
   * @returns Complete GPX XML for the selected current itinerary source.
   * @throws {Error} If the selected source is no longer available or an editable
   * route mutation is still pending.
   */
  const createCurrentRouteGpxDocument = (routeName: string): string => {
    const generatedAt = new Date();

    if (routeExportSource === 'switzerlandMobility') {
      if (switzerlandMobilityHikingPanel?.state !== 'ready') {
        throw new Error('The selected SwitzerlandMobility route is unavailable.');
      }

      return createRouteSegmentsGpx(
        switzerlandMobilityHikingPanel.route.segments,
        generatedAt,
        routeName,
        switzerlandMobilityHikingPanel.elevation?.points ?? [],
      );
    }

    if (routeExportSource === 'imported') {
      const source = resolveExactImportedRouteSource(
        importedRouteSource,
        editableImportedRouteOrigin,
        routeHistory,
      );

      if (!source) {
        throw new Error('The imported GPX route is unavailable.');
      }

      // Keep provider-specific metadata and extensions from the source GPX
      // while the converted editable geometry still matches its pristine state.
      return createNamedImportedGpxDocument(
        source.gpxDocument,
        routeName,
      );
    }

    if (isRouteOperationPending) {
      throw new Error('The editable route is still being updated.');
    }

    return createRouteGpx(
      routeHistory.steps,
      generatedAt,
      routeName,
      routeElevation?.points ?? [],
      routeHistory.closure,
    );
  };

  /** Downloads the exact GPX document also used by the swisstopo transfer. */
  const exportRoute = (routeName: string) => {
    try {
      downloadGpxDocument(
        createCurrentRouteGpxDocument(routeName),
        routeName,
      );
      setIsRouteExportDialogOpen(false);
    } catch (error) {
      console.error('Unable to export the route as GPX.', error);
      showTemporaryRouteMessage(
        t('route.exportError'),
        'error',
      );
    }
  };

  /** Uploads the named GPX only on explicit request and returns its QR hand-off. */
  const shareRouteWithSwisstopo = async (
    routeName: string,
  ): Promise<SwisstopoShare> => {
    const gpxDocument = createCurrentRouteGpxDocument(routeName);
    return createSwisstopoShare(gpxDocument);
  };

  return (
    <main
      className={[
        'app',
        isRouteCreationActive ? 'app--route-creation' : '',
        isRouteOperationPending ? 'app--route-busy' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      ref={appRef}
    >
      <h1 className="visually-hidden">{t('app.title')}</h1>

      <div
        ref={mapTargetRef}
        className="map"
        aria-label={t('map.aria')}
      />

      {routeContextHint && (
        <div
          className={[
            'route-context-hint',
            routeContextHint.below ? 'route-context-hint--below' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          style={{
            left: routeContextHint.left,
            top: routeContextHint.top,
          }}
          role="tooltip"
        >
          {routeContextHint.target === 'waypoint'
            ? t('route.waypointHint')
            : t('route.segmentHint')}
        </div>
      )}

      <LocationSearch
        key={`${language}:${locationSearchResetVersion}`}
        isMobileOverlayOpen={isMobileSearchOpen}
        onMobileOverlayClose={() => setIsMobileSearchOpen(false)}
        onSearchFocus={closeMapInformationPopup}
        onSelect={selectSearchResult}
        onClear={clearSearchResultMarkerOnly}
      />

      <nav className="map-controls" aria-label={t('map.controls')}>
        <RouteControls
          isActive={isRouteCreationActive}
          isSnapEnabled={isRouteSnapEnabled}
          isBusy={isRouteOperationPending}
          canUndo={
            !isRouteOperationPending && routeHistory.undoStates.length > 0
          }
          canRedo={
            !isRouteOperationPending && routeHistory.redoStates.length > 0
          }
          canReverse={
            !isRouteOperationPending && routeHistory.steps.length > 1
          }
          canToggleLoop={
            !isRouteOperationPending && routeHistory.steps.length > 1
          }
          isLoopClosed={routeHistory.closure !== null}
          canDelete={
            !isRouteOperationPending && routeHistory.steps.length > 0
          }
          onToggle={handleToggleRouteCreation}
          onUndo={undoRoutePoint}
          onRedo={redoRoutePoint}
          onToggleSnap={toggleRouteSnap}
          onReverse={reverseRoute}
          onToggleLoop={toggleRouteLoop}
          onDelete={handleDeleteRoute}
        />

        <button
          type="button"
          className="map-control-button map-control-button--search"
          aria-label={t('search.label')}
          title={t('search.label')}
          onClick={() => {
            closeMapInformationPopup();
            setIsMobileSearchOpen(true);
          }}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <circle cx="10.5" cy="10.5" r="6.5" />
            <path d="m15.5 15.5 5 5" />
          </svg>
        </button>

        {/* Export follows the current itinerary, not whether route editing is active. */}
        {(routeHistory.steps.length > 0 ||
          importedRouteSource ||
          switzerlandMobilityHikingPanel?.state === 'ready') && (
          <button
            type="button"
            className="map-control-button map-control-button--route-export"
            aria-label={t('route.export')}
            title={t('route.export')}
            disabled={
              switzerlandMobilityHikingPanel?.state === 'ready'
                ? switzerlandMobilityHikingPanel.elevationStatus === 'loading'
                : !importedRouteSource &&
                  (isRouteOperationPending || routeHistory.steps.length < 2)
            }
            onClick={requestCurrentItineraryExport}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M12 3v12" />
              <path d="m7.5 10.5 4.5 4.5 4.5-4.5" />
              <path d="M5 18v2h14v-2" />
            </svg>
          </button>
        )}

        <RouteImportControl
          onOpen={closeMapInformationPopup}
          onSelectFile={importRouteFile}
        />


        <MapLayersSelector
          baseMapStyle={baseMapStyle}
          onBaseMapChange={setBaseMapStyle}
          areHikingTrailsVisible={areHikingTrailsVisible}
          onHikingTrailsChange={setAreHikingTrailsVisible}
          isSwitzerlandMobilityHikingVisible={
            isSwitzerlandMobilityHikingVisible
          }
          onSwitzerlandMobilityHikingChange={
            setIsSwitzerlandMobilityHikingVisible
          }
          areTrailClosuresVisible={areTrailClosuresVisible}
          onTrailClosuresChange={setAreTrailClosuresVisible}
          areShootingDangerZonesVisible={areShootingDangerZonesVisible}
          onShootingDangerZonesChange={setAreShootingDangerZonesVisible}
          arePublicTransportStopsVisible={arePublicTransportStopsVisible}
          onPublicTransportStopsChange={setArePublicTransportStopsVisible}
          layerOpacities={layerOpacities}
          onLayerOpacityChange={setLayerOpacity}
          onOpen={closeMapInformationPopup}
          onOpenAbout={openAboutDialog}
        />

        <div className="zoom-controls">
          <button
            type="button"
            className="map-control-button map-control-button--zoom"
            aria-label={t('map.zoomIn')}
            title={t('map.zoomIn')}
            onClick={() => changeZoom(1)}
          >
            +
          </button>

          <button
            type="button"
            className="map-control-button map-control-button--zoom"
            aria-label={t('map.zoomOut')}
            title={t('map.zoomOut')}
            onClick={() => changeZoom(-1)}
          >
            −
          </button>
        </div>

        <button
          type="button"
          className={[
            'map-control-button',
            'map-control-button--location',
            locationStatus === 'located'
              ? 'map-control-button--active'
              : '',
          ]
            .filter(Boolean)
            .join(' ')}
          aria-label={locationButtonLabel}
          aria-busy={locationStatus === 'locating'}
          title={locationButtonLabel}
          disabled={locationStatus === 'locating'}
          onClick={locateUser}
        >
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            focusable="false"
          >
            <circle cx="12" cy="12" r="7" />
            <circle
              cx="12"
              cy="12"
              r="2.2"
              className="location-icon-center"
            />
            <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3" />
          </svg>
        </button>

        {document.fullscreenEnabled && (
          <button
            type="button"
            className="map-control-button map-control-button--fullscreen"
            aria-label={fullscreenButtonLabel}
            aria-pressed={isFullscreen}
            title={fullscreenButtonLabel}
            onClick={() => void toggleFullscreen()}
          >
            <svg
              viewBox="0 0 24 24"
              aria-hidden="true"
              focusable="false"
            >
              {isFullscreen ? (
                <path d="M9 3v6H3M15 3v6h6M21 15h-6v6M3 15h6v6" />
              ) : (
                <path d="M9 3H3v6M15 3h6v6M21 15v6h-6M3 15v6h6" />
              )}
            </svg>
          </button>
        )}

        <LanguageSelector />

        <button
          type="button"
          className="map-control-button about-button"
          aria-label={t('about.open')}
          title={t('about.open')}
          onClick={openAboutDialog}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 11v6M12 7.5h.01" />
          </svg>
        </button>

        {locationMessage && (
          <div
            className={[
              'location-message',
              locationStatus === 'error'
                ? 'location-message--error'
                : '',
            ]
              .filter(Boolean)
              .join(' ')}
            role={locationStatus === 'error' ? 'alert' : 'status'}
          >
            {locationMessage}
          </div>
        )}
      </nav>

      {trailClosurePopup && (
        <TrailClosurePopup
          status={trailClosurePopup}
          onClose={closeMapInformationPopup}
        />
      )}

      {shootingDangerZonePopup && (
        <ShootingDangerZonePopup
          status={shootingDangerZonePopup}
          onClose={closeMapInformationPopup}
        />
      )}

      {publicTransportStopPopup && (
        <PublicTransportStopPopup
          stop={publicTransportStopPopup}
          onClose={closeMapInformationPopup}
        />
      )}

      {switzerlandMobilityHikingPanel && (
        <SwitzerlandMobilityHikingPanel
          status={switzerlandMobilityHikingPanel}
          onSelectCandidate={selectSwitzerlandMobilityHikingCandidate}
          onProfileHoverDistanceChange={
            handleSwitzerlandMobilityHikingProfileHoverDistanceChange
          }
          routeHoverDistanceMeters={
            switzerlandMobilityHikingMapHoverDistanceMeters
          }
          onClose={dismissSwitzerlandMobilityHikingPanel}
        />
      )}

      {activeRouteSegments.length > 0 &&
        !switzerlandMobilityHikingPanel && (
          <RouteStatistics
            distanceMeters={routeDistanceMeters}
            elevationStatus={routeElevationStatus}
            ascentMeters={routeElevation?.ascentMeters ?? null}
            descentMeters={routeElevation?.descentMeters ?? null}
            durationMinutes={routeDurationMinutes}
            elevationPoints={routeElevation?.points ?? []}
            onProfileHoverDistanceChange={
              handleProfileHoverDistanceChange
            }
            routeHoverDistanceMeters={routeMapHoverDistanceMeters}
            editAction={
              importedRouteSource
                ? {
                    label: t('route.editImported'),
                    onClick: editImportedRoute,
                  }
                : null
            }
          />
        )}

      {routeMessage && (
        <div
          className={[
            'route-message',
            routeMessageType === 'error' ? 'route-message--error' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          role={routeMessageType === 'error' ? 'alert' : 'status'}
        >
          {routeMessage}
        </div>
      )}

      <ReleaseNotesDialog
        isOpen={isReleaseNotesDialogOpen}
        onClose={closeReleaseNotesDialog}
      />

      <AboutDialog
        isOpen={isAboutDialogOpen}
        onClose={() => setIsAboutDialogOpen(false)}
      />

      <RouteExportDialog
        isOpen={isRouteExportDialogOpen}
        defaultName={routeExportDefaultName}
        canShareWithSwisstopo={isSwisstopoShareConfigured()}
        onCancel={() => setIsRouteExportDialogOpen(false)}
        onExportGpx={exportRoute}
        onCreateSwisstopoShare={shareRouteWithSwisstopo}
      />

      {status === 'loading' && (
        <div className="status-card" role="status">
          {t('map.loading')}
        </div>
      )}

      {status === 'error' && (
        <div className="status-card status-card--error" role="alert">
          <strong>{t('map.loadFailed')}</strong>
          <span>{t('map.tileError')}</span>
          <span>{t('map.retry')}</span>
        </div>
      )}
    </main>
  );
}
