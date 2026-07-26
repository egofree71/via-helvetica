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
  downloadRouteGpx,
  downloadRouteSegmentsGpx,
} from './export/gpx';
import { useI18n } from './i18n/I18nContext';
import { LOCATION_SEARCH_ZOOM, MAP_EXTENT } from './map/config';
import { fromWgs84 } from './map/projection';
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
import type { LocationSearchResult } from './search/locationSearch';

/** Itinerary source named by the shared GPX export dialog. */
type RouteExportSource = 'editable' | 'switzerlandMobility';

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
  const { language, t } = useI18n();
  const appRef = useRef<HTMLElement>(null);
  const mapTargetRef = useRef<HTMLDivElement>(null);

  const [isAboutDialogOpen, setIsAboutDialogOpen] = useState(false);
  const [isRouteExportDialogOpen, setIsRouteExportDialogOpen] =
    useState(false);
  const [locationSearchResetVersion, setLocationSearchResetVersion] =
    useState(0);
  const [routeExportDefaultName, setRouteExportDefaultName] = useState('');
  const [routeExportSource, setRouteExportSource] =
    useState<RouteExportSource>('editable');
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
    replaceWithReadOnlyItinerary,
    showTemporaryRouteMessage,
    isPointerInteractionActive,
  } = useEditableRoute({
    mapRuntimeRef,
    mapTargetRef,
    t,
  });

  const handleImportedRouteAccepted = useCallback(() => {
    clearSelectedSearchResult();
    replaceWithReadOnlyItinerary();
  }, [clearSelectedSearchResult, replaceWithReadOnlyItinerary]);

  const handleImportedRouteError = useCallback(
    (message: string) => showTemporaryRouteMessage(message, 'error'),
    [showTemporaryRouteMessage],
  );

  const {
    segments: importedRouteSegments,
    elevationSummary: importedRouteElevationSummary,
    importRouteFile,
    clearImportedRoute,
  } = useImportedRoute({
    mapRuntimeRef,
    t,
    onImportAccepted: handleImportedRouteAccepted,
    onImportError: handleImportedRouteError,
  });

  /** Makes one validated public route the sole current itinerary. */
  const handleSwitzerlandMobilityHikingRouteAccepted = useCallback(() => {
    clearSelectedSearchResult();
    clearImportedRoute();
    replaceWithReadOnlyItinerary();
  }, [
    clearImportedRoute,
    clearSelectedSearchResult,
    replaceWithReadOnlyItinerary,
  ]);

  const handleToggleRouteCreation = useCallback(() => {
    if (!isRouteCreationActive) {
      clearSelectedSearchResult();
      clearImportedRoute();
    }

    toggleRouteCreation();
  }, [
    clearImportedRoute,
    clearSelectedSearchResult,
    isRouteCreationActive,
    toggleRouteCreation,
  ]);

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
    importedRouteElevationSummary,
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

  /** Places a temporary marker and frames one official search result. */
  const selectSearchResult = (result: LocationSearchResult) => {
    const map = mapRuntimeRef.current?.map;
    const marker = mapRuntimeRef.current?.searchResultMarker;

    if (!map || !marker) {
      return;
    }

    const coordinate = fromWgs84([
      result.longitude,
      result.latitude,
    ]);

    if (!containsCoordinate(MAP_EXTENT, coordinate)) {
      return;
    }

    updateSearchResultMarker(marker, coordinate);

    map.getView().animate({
      center: coordinate,
      zoom: LOCATION_SEARCH_ZOOM,
      duration: 600,
    });
  };

  /** Opens the route-name dialog before any GPX content is generated. */
  const requestRouteExport = () => {
    if (
      isRouteOperationPending ||
      routeHistory.steps.length < 2
    ) {
      return;
    }

    setRouteExportDefaultName(
      createRouteExportDefaultName(t('gpx.routeName')),
    );
    setRouteExportSource('editable');
    setIsRouteExportDialogOpen(true);
  };

  /** Opens the shared name dialog for the selected public hiking route. */
  const requestSwitzerlandMobilityHikingExport = () => {
    if (switzerlandMobilityHikingPanel?.state !== 'ready') {
      return;
    }

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
  };

  /** Downloads the exact displayed route geometry under the chosen route name. */
  const exportRoute = (routeName: string) => {
    try {
      if (routeExportSource === 'switzerlandMobility') {
        if (switzerlandMobilityHikingPanel?.state !== 'ready') {
          return;
        }

        downloadRouteSegmentsGpx(
          switzerlandMobilityHikingPanel.route.segments,
          routeName,
          switzerlandMobilityHikingPanel.elevation?.points ?? [],
        );
      } else {
        if (isRouteOperationPending) {
          return;
        }

        downloadRouteGpx(
          routeHistory.steps,
          routeName,
          routeElevation?.points ?? [],
          routeHistory.closure,
        );
      }

      setIsRouteExportDialogOpen(false);
    } catch (error) {
      console.error('Unable to export the route as GPX.', error);
      showTemporaryRouteMessage(
        t('route.exportError'),
        'error',
      );
    }
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
        onSearchFocus={closeMapInformationPopup}
        onSelect={selectSearchResult}
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
          canExport={
            !isRouteOperationPending && routeHistory.steps.length > 1
          }
          onToggle={handleToggleRouteCreation}
          onUndo={undoRoutePoint}
          onRedo={redoRoutePoint}
          onToggleSnap={toggleRouteSnap}
          onReverse={reverseRoute}
          onToggleLoop={toggleRouteLoop}
          onDelete={deleteRoute}
          onExport={requestRouteExport}
        />

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
          onExport={requestSwitzerlandMobilityHikingExport}
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

      <AboutDialog
        isOpen={isAboutDialogOpen}
        onClose={() => setIsAboutDialogOpen(false)}
      />

      <RouteExportDialog
        isOpen={isRouteExportDialogOpen}
        defaultName={routeExportDefaultName}
        onCancel={() => setIsRouteExportDialogOpen(false)}
        onConfirm={exportRoute}
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
