/**
 * Business context: owns the imperative OpenLayers runtime used by Via Helvetica.
 * It creates the map, official background and information layers, itinerary
 * displays, and transient markers as one disposable unit so React can coordinate
 * application state without managing a large collection of unrelated refs.
 */
import Map from 'ol/Map.js';
import View from 'ol/View.js';
import { defaults as defaultControls, ScaleLine } from 'ol/control.js';
import TileLayer from 'ol/layer/Tile.js';
import type TileWMS from 'ol/source/TileWMS.js';
import type WMTS from 'ol/source/WMTS.js';
import { createTrailClosuresSource } from '../closures/trailClosures';
import {
  createShootingDangerZoneSelectionDisplay,
  createShootingDangerZonesSource,
  type ShootingDangerZoneSelectionDisplay,
} from '../dangers/shootingDangerZones';
import {
  createPublicTransportStopsDisplay,
  type PublicTransportStopsDisplay,
} from '../transport/publicTransportStops';
import {
  createBaseMapSource,
  createGrayDetailMapSource,
  createHikingTrailsSource,
  createSwitzerlandMobilityHikingSource,
  DEFAULT_BASE_MAP_STYLE,
  DEFAULT_MAP_CENTER,
  GRAY_DETAIL_MIN_ZOOM,
  HIKING_TRAILS_MIN_ZOOM,
  SWITZERLAND_MOBILITY_HIKING_MIN_ZOOM,
  SWITZERLAND_MOBILITY_HIKING_OPACITY,
  MAP_EXTENT,
  MAP_ZOOM,
  type BaseMapStyle,
} from './config';
import {
  createImportedRouteDisplay,
  type ImportedRouteDisplay,
} from './importedRoute';
import {
  createRouteDisplay,
  type RouteDisplay,
} from './route';
import {
  createRouteProfileMarker,
  type RouteProfileMarker,
} from './routeProfileMarker';
import {
  createSwitzerlandMobilityHikingSelectionDisplay,
  type SwitzerlandMobilityHikingSelectionDisplay,
} from './switzerlandMobilityHikingSelection';
import {
  createSearchResultMarker,
  type SearchResultMarker,
} from './searchResult';
import {
  createUserLocationMarker,
  type UserLocationMarker,
} from './userLocation';
import {
  LV95_VIEW_RESOLUTIONS,
  MAP_PROJECTION_CODE,
} from './projection';

/** Layer order slot for the detailed grey supplement above the base map. */
const GRAY_DETAIL_Z_INDEX = 1;
/** Layer order slot for rendered hiking trails below named route overlays. */
const HIKING_TRAILS_Z_INDEX = 10;
/** Layer order slot for green SwitzerlandMobility routes above hiking trails. */
const SWITZERLAND_MOBILITY_HIKING_Z_INDEX = 11;
/** Selected public route stays above the overview but below safety overlays. */
const SWITZERLAND_MOBILITY_HIKING_SELECTION_Z_INDEX = 12;
/** Layer order slot for closures above hiking portrayals and transport stops. */
const TRAIL_CLOSURES_Z_INDEX = 13;
/** Layer order slot for military danger zones above other information layers. */
const SHOOTING_DANGER_ZONES_Z_INDEX = 16;
/** Half-step layer order keeps the selected polygon above its WMS portrayal. */
const SHOOTING_DANGER_SELECTION_Z_INDEX = 16.5;
/** Opacity ratio that preserves map detail beneath large military polygons. */
const SHOOTING_DANGER_ZONES_OPACITY = 0.6;
/** Minimum scale-bar width in screen pixels for legible metric labels. */
const SCALE_LINE_MIN_WIDTH_PX = 120;
/**
 * Pointer drift in screen pixels still accepted as a map click. Raising the
 * OpenLayers default avoids losing touch taps to small involuntary finger
 * movement, while keeping the threshold low enough for responsive panning.
 */
const MAP_CLICK_MOVE_TOLERANCE_PX = 6;

/** Initial base-map loading state reported to the React shell. */
export type MapLoadStatus = 'loading' | 'ready' | 'error';

/** Initial layer visibility supplied when the OpenLayers runtime is created. */
export interface MapRuntimeVisibility {
  /** Whether the rendered official hiking-trail overlay starts visible. */
  hikingTrails: boolean;
  /** Whether official SwitzerlandMobility hiking routes start visible. */
  switzerlandMobilityHiking: boolean;
  /** Whether official hiking closures and detours start visible. */
  trailClosures: boolean;
  /** Whether military shooting notices and danger zones start visible. */
  shootingDangerZones: boolean;
  /** Whether filtered passenger public-transport stops start visible. */
  publicTransportStops: boolean;
}

/** Construction options for the single map runtime. */
export interface CreateMapRuntimeOptions {
  /** DOM element that receives the OpenLayers canvas and interactions. */
  target: HTMLElement;
  /** Persisted initial visibility for independently switchable overlays. */
  visibility: MapRuntimeVisibility;
  /** Receives the blocking initial base-map loading state. */
  onLoadStatusChange: (status: MapLoadStatus) => void;
}

/**
 * Disposable OpenLayers resources owned by the application shell.
 * Create instances through `createMapRuntime()` so layer order, projection,
 * markers, and cleanup remain consistent.
 */
export interface MapRuntime {
  /** Sole OpenLayers map instance. */
  map: Map;
  /** Client-side highlight for one selected SwitzerlandMobility hiking route. */
  switzerlandMobilityHikingSelectionDisplay:
    SwitzerlandMobilityHikingSelectionDisplay;
  /** Client-side highlight for the selected military danger zone. */
  shootingDangerZoneSelectionDisplay: ShootingDangerZoneSelectionDisplay;
  /** Filtered public-transport stop layers and vector sources. */
  publicTransportStopsDisplay: PublicTransportStopsDisplay;
  /** Marker used for browser geolocation. */
  userLocationMarker: UserLocationMarker;
  /** Temporary marker used by official location search. */
  searchResultMarker: SearchResultMarker;
  /** Read-only imported GPX display. */
  importedRouteDisplay: ImportedRouteDisplay;
  /** Editable route display and interaction-facing features. */
  routeDisplay: RouteDisplay;
  /** Transient marker shared by map and elevation-profile exploration. */
  routeProfileMarker: RouteProfileMarker;
  /** Replaces the active official background without recreating the map. */
  setBaseMapStyle: (style: BaseMapStyle) => void;
  /** Shows or hides the rendered official hiking-trail overlay. */
  setHikingTrailsVisible: (visible: boolean) => void;
  /** Shows or hides official SwitzerlandMobility hiking routes. */
  setSwitzerlandMobilityHikingVisible: (visible: boolean) => void;
  /** Shows or hides official hiking closures and detours. */
  setTrailClosuresVisible: (visible: boolean) => void;
  /** Shows or hides military danger zones and their selection highlight. */
  setShootingDangerZonesVisible: (visible: boolean) => void;
  /** Shows or hides public-transport stops and their selection halo. */
  setPublicTransportStopsVisible: (visible: boolean) => void;
  /** Detaches listeners and releases the OpenLayers DOM target. */
  dispose: () => void;
}

/**
 * Creates the complete OpenLayers runtime with the project's explicit layer
 * order and native LV95 view.
 *
 * @param options - DOM target, initial overlay visibility, and load callback.
 * @returns One disposable runtime containing the map and every shared display.
 */
export function createMapRuntime(
  options: CreateMapRuntimeOptions,
): MapRuntime {
  const rasterSource = createBaseMapSource(DEFAULT_BASE_MAP_STYLE);
  const grayDetailSource = createGrayDetailMapSource();
  const hikingTrailsSource = createHikingTrailsSource();
  const switzerlandMobilityHikingSource =
    createSwitzerlandMobilityHikingSource();
  const trailClosuresSource = createTrailClosuresSource();
  const shootingDangerZonesSource = createShootingDangerZonesSource();
  const switzerlandMobilityHikingSelectionDisplay =
    createSwitzerlandMobilityHikingSelectionDisplay();
  const shootingDangerZoneSelectionDisplay =
    createShootingDangerZoneSelectionDisplay();
  const publicTransportStopsDisplay = createPublicTransportStopsDisplay();
  const userLocationMarker = createUserLocationMarker();
  const searchResultMarker = createSearchResultMarker();
  const importedRouteDisplay = createImportedRouteDisplay();
  const routeDisplay = createRouteDisplay();
  const routeProfileMarker = createRouteProfileMarker();

  const baseMapLayer = new TileLayer<WMTS>({
    source: rasterSource,
  });
  const grayDetailLayer = new TileLayer<WMTS>({
    source: grayDetailSource,
    minZoom: GRAY_DETAIL_MIN_ZOOM,
    visible: false,
    zIndex: GRAY_DETAIL_Z_INDEX,
  });
  const hikingTrailsLayer = new TileLayer<WMTS>({
    source: hikingTrailsSource,
    minZoom: HIKING_TRAILS_MIN_ZOOM,
    visible: options.visibility.hikingTrails,
    zIndex: HIKING_TRAILS_Z_INDEX,
  });
  const switzerlandMobilityHikingLayer = new TileLayer<WMTS>({
    source: switzerlandMobilityHikingSource,
    minZoom: SWITZERLAND_MOBILITY_HIKING_MIN_ZOOM,
    visible: options.visibility.switzerlandMobilityHiking,
    // The official routes are much thicker than the ordinary hiking portrayal.
    // Partial opacity keeps labels, roads, and terrain readable underneath.
    opacity: SWITZERLAND_MOBILITY_HIKING_OPACITY,
    zIndex: SWITZERLAND_MOBILITY_HIKING_Z_INDEX,
  });
  const trailClosuresLayer = new TileLayer<TileWMS>({
    source: trailClosuresSource,
    minZoom: HIKING_TRAILS_MIN_ZOOM,
    visible: options.visibility.trailClosures,
    zIndex: TRAIL_CLOSURES_Z_INDEX,
  });
  const shootingDangerZonesLayer = new TileLayer<TileWMS>({
    source: shootingDangerZonesSource,
    minZoom: HIKING_TRAILS_MIN_ZOOM,
    visible: options.visibility.shootingDangerZones,
    // Partial opacity keeps map detail readable while preserving the safety
    // perimeter's visual priority above closures and transport stops.
    opacity: SHOOTING_DANGER_ZONES_OPACITY,
    zIndex: SHOOTING_DANGER_ZONES_Z_INDEX,
  });

  switzerlandMobilityHikingSelectionDisplay.layer.setZIndex(
    SWITZERLAND_MOBILITY_HIKING_SELECTION_Z_INDEX,
  );
  shootingDangerZoneSelectionDisplay.layer.setMinZoom(
    HIKING_TRAILS_MIN_ZOOM,
  );
  shootingDangerZoneSelectionDisplay.layer.setVisible(
    options.visibility.shootingDangerZones,
  );
  shootingDangerZoneSelectionDisplay.layer.setZIndex(
    SHOOTING_DANGER_SELECTION_Z_INDEX,
  );
  publicTransportStopsDisplay.layer.setVisible(
    options.visibility.publicTransportStops,
  );
  publicTransportStopsDisplay.selectionLayer.setVisible(
    options.visibility.publicTransportStops,
  );

  let firstTileLoaded = false;

  const handleTileLoaded = () => {
    if (firstTileLoaded) {
      return;
    }

    firstTileLoaded = true;
    options.onLoadStatusChange('ready');
  };

  const handleTileError = () => {
    // A late isolated tile failure must not replace an already usable map with
    // the blocking startup error card.
    if (!firstTileLoaded) {
      options.onLoadStatusChange('error');
    }
  };

  rasterSource.on('tileloadend', handleTileLoaded);
  rasterSource.on('tileloaderror', handleTileError);

  const map = new Map({
    target: options.target,
    moveTolerance: MAP_CLICK_MOVE_TOLERANCE_PX,
    layers: [
      baseMapLayer,
      grayDetailLayer,
      hikingTrailsLayer,
      switzerlandMobilityHikingLayer,
      switzerlandMobilityHikingSelectionDisplay.layer,
      trailClosuresLayer,
      publicTransportStopsDisplay.selectionLayer,
      publicTransportStopsDisplay.layer,
      shootingDangerZonesLayer,
      shootingDangerZoneSelectionDisplay.layer,
      importedRouteDisplay.layer,
      routeDisplay.layer,
      searchResultMarker.layer,
      userLocationMarker.layer,
      routeProfileMarker.layer,
    ],
    view: new View({
      projection: MAP_PROJECTION_CODE,
      resolutions: [...LV95_VIEW_RESOLUTIONS],
      center: DEFAULT_MAP_CENTER,
      zoom: MAP_ZOOM.initial,
      minZoom: MAP_ZOOM.minimum,
      maxZoom: MAP_ZOOM.maximum,
      extent: MAP_EXTENT,
      constrainOnlyCenter: false,
      // The Swiss extent is narrower than common desktop viewports. One
      // dimension may exceed it so the whole country remains visible without
      // relaxing the geographic navigation boundary in both dimensions.
      showFullExtent: true,
      smoothExtentConstraint: false,
    }),
    controls: defaultControls({
      zoom: false,
      // Complete provider credits live in the accessible About dialog, so the
      // OpenLayers attribution expander would duplicate that information.
      attribution: false,
    }).extend([
      new ScaleLine({
        units: 'metric',
        bar: true,
        text: true,
        minWidth: SCALE_LINE_MIN_WIDTH_PX,
      }),
    ]),
  });

  let activeBaseMapStyle = DEFAULT_BASE_MAP_STYLE;

  const setBaseMapStyle = (style: BaseMapStyle) => {
    // The 1:10,000 detail layer complements only the grey background.
    grayDetailLayer.setVisible(style === 'gray');

    if (activeBaseMapStyle === style) {
      return;
    }

    // Replacing only the source preserves the view, route, markers, overlays,
    // and every active OpenLayers interaction.
    baseMapLayer.setSource(createBaseMapSource(style));
    activeBaseMapStyle = style;
  };

  const setHikingTrailsVisible = (visible: boolean) => {
    hikingTrailsLayer.setVisible(visible);
  };

  const setSwitzerlandMobilityHikingVisible = (visible: boolean) => {
    switzerlandMobilityHikingLayer.setVisible(visible);
  };

  const setTrailClosuresVisible = (visible: boolean) => {
    trailClosuresLayer.setVisible(visible);
  };

  const setShootingDangerZonesVisible = (visible: boolean) => {
    shootingDangerZonesLayer.setVisible(visible);
    shootingDangerZoneSelectionDisplay.layer.setVisible(visible);
  };

  const setPublicTransportStopsVisible = (visible: boolean) => {
    publicTransportStopsDisplay.layer.setVisible(visible);
    publicTransportStopsDisplay.selectionLayer.setVisible(visible);
  };

  const dispose = () => {
    rasterSource.un('tileloadend', handleTileLoaded);
    rasterSource.un('tileloaderror', handleTileError);
    map.setTarget(undefined);
  };

  return {
    map,
    switzerlandMobilityHikingSelectionDisplay,
    shootingDangerZoneSelectionDisplay,
    publicTransportStopsDisplay,
    userLocationMarker,
    searchResultMarker,
    importedRouteDisplay,
    routeDisplay,
    routeProfileMarker,
    setBaseMapStyle,
    setHikingTrailsVisible,
    setSwitzerlandMobilityHikingVisible,
    setTrailClosuresVisible,
    setShootingDangerZonesVisible,
    setPublicTransportStopsVisible,
    dispose,
  };
}
