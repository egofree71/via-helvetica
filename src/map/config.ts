/**
 * Business context: centralizes the official swisstopo layer identifiers,
 * native LV95 WMTS grids, geographic limits, and zoom policy used by the map.
 * Keeping these provider and scale decisions together prevents individual
 * components from inventing incompatible projections or visibility thresholds.
 */
import { transformExtent } from 'ol/proj.js';
import WMTS from 'ol/source/WMTS.js';
import WMTSTileGrid from 'ol/tilegrid/WMTS.js';
import {
  fromWgs84,
  LV95_FINE_SOURCE_MATRIX_INDICES,
  LV95_MATRIX_SIZES,
  LV95_STANDARD_SOURCE_MATRIX_INDICES,
  LV95_VIEW_RESOLUTIONS,
  LV95_WMTS_EXTENT,
  MAP_PROJECTION_CODE,
  WGS84_PROJECTION_CODE,
} from './projection';

/** Backgrounds available through the official swisstopo WMTS service. */
export type BaseMapStyle = 'color' | 'gray' | 'aerial';

/** Default background used when the application starts. */
export const DEFAULT_BASE_MAP_STYLE: BaseMapStyle = 'color';

/** Provider layer identifiers for each selectable background. */
const SWISSTOPO_BASE_MAP_LAYER_IDS: Record<BaseMapStyle, string> = {
  color: 'ch.swisstopo.pixelkarte-farbe',
  gray: 'ch.swisstopo.pixelkarte-grau',
  aerial: 'ch.swisstopo.swissimage',
};

/** Detailed grey-map layer used only at close planning scales. */
const SWISSTOPO_GRAY_DETAIL_LAYER_ID =
  'ch.swisstopo.landeskarte-grau-10';

/** Official rendered hiking-trail portrayal shown independently from routing. */
const SWISSTOPO_HIKING_TRAILS_LAYER_ID =
  'ch.swisstopo.swisstlm3d-wanderwege';

/** Official SwitzerlandMobility hiking-route portrayal shown as green routes. */
const SWITZERLAND_MOBILITY_HIKING_LAYER_ID = 'ch.astra.wanderland';

/** HTML attribution required by the official swisstopo tile service. */
const SWISSTOPO_ATTRIBUTION =
  '<a href="https://www.swisstopo.admin.ch/" target="_blank" rel="noopener noreferrer">© swisstopo</a>';

/*
 * This extent is not the exact administrative boundary. It keeps a small
 * margin around Switzerland so nearby cross-border access remains visible,
 * while preventing navigation to areas that are irrelevant to the project.
 *
 * Coordinate order: west, south, east, north (WGS 84 / EPSG:4326).
 */
const MAP_BOUNDS_WGS84 = [5.7, 45.65, 10.75, 47.95];

/** Initial map centre near the geographic middle of Switzerland, in LV95. */
export const DEFAULT_MAP_CENTER = fromWgs84([8.2275, 46.8182]);

/** Navigable LV95 extent derived from the documented WGS84 border margin. */
export const MAP_EXTENT = transformExtent(
  MAP_BOUNDS_WGS84,
  WGS84_PROJECTION_CODE,
  MAP_PROJECTION_CODE,
);

/*
 * Zoom values are indices in swisstopo's native LV95 resolution pyramid.
 * The view may interpolate between levels, while WMTS requests still use only
 * matrices actually published by each source.
 */
export const MAP_ZOOM = {
  initial: 6,
  minimum: 0,
  maximum: 28,
} as const;

/*
 * OpenLayers treats a layer's minZoom as an exclusive boundary. Level 19 has
 * a native resolution of 20 metres per pixel, matching the former detailed
 * visibility threshold closely without reprojecting the portrayal.
 */
export const HIKING_TRAILS_MIN_ZOOM = 18;

/**
 * Minimum OpenLayers zoom index for SwitzerlandMobility hiking routes.
 * It deliberately matches the ordinary hiking portrayal so the dense green
 * network does not cover national-map labels at overview scales.
 */
export const SWITZERLAND_MOBILITY_HIKING_MIN_ZOOM =
  HIKING_TRAILS_MIN_ZOOM;

/**
 * Layer opacity ratio (0 = transparent, 1 = opaque) for the thick green routes.
 * A value of 0.6 keeps route continuity clear while allowing place names,
 * roads, and terrain symbols to remain readable below the portrayal.
 */
export const SWITZERLAND_MOBILITY_HIKING_OPACITY = 0.6;

/*
 * The 1:10,000 grey map supplements the national grey background from native
 * level 25. Levels 27 and 28 are client zooms for this layer and stretch its
 * finest published tile level, as documented by the WMTS service.
 */
export const GRAY_DETAIL_MIN_ZOOM = 24;

/** Browser geolocation reveals nearby streets and trails at 5 m/px or closer. */
export const USER_LOCATION_ZOOM = 21;

/** Location search opens at the native 20 m/px planning level. */
export const LOCATION_SEARCH_ZOOM = 19;

/** GPX framing may use the finest native national-map level for very short itineraries. */
export const IMPORTED_ROUTE_MAX_ZOOM = 26;

/** Image formats published by the configured swisstopo WMTS layers. */
type SwissTopoTileFormat = 'jpeg' | 'png';

/** Index into the shared native LV95 resolution and matrix-size arrays. */
type MatrixIndex = number;

/**
 * Builds a WMTS tile grid from the exact native LV95 matrices exposed by one
 * source. Views may interpolate between resolutions, but tile requests must
 * never target an unpublished matrix.
 *
 * @param matrixIndices - Ordered indices retained from the shared LV95 pyramid.
 * @returns An OpenLayers tile grid matching the selected source matrices.
 */
function createLv95TileGrid(matrixIndices: readonly MatrixIndex[]): WMTSTileGrid {
  return new WMTSTileGrid({
    extent: LV95_WMTS_EXTENT,
    origin: [LV95_WMTS_EXTENT[0], LV95_WMTS_EXTENT[3]],
    resolutions: matrixIndices.map((index) => LV95_VIEW_RESOLUTIONS[index]),
    matrixIds: matrixIndices.map(String),
    sizes: matrixIndices.map((index) => [...LV95_MATRIX_SIZES[index]]),
    tileSize: 256,
  });
}

/** Native matrices available to the national maps and hiking portrayal. */
const STANDARD_LV95_TILE_GRID = createLv95TileGrid(
  LV95_STANDARD_SOURCE_MATRIX_INDICES,
);
/** Additional fine matrices published by SWISSIMAGE at close zoom levels. */
const FINE_LV95_TILE_GRID = createLv95TileGrid(
  LV95_FINE_SOURCE_MATRIX_INDICES,
);

/**
 * Creates one REST-encoded swisstopo WMTS source in EPSG:2056.
 *
 * @param layerId - Official provider layer identifier.
 * @param format - Image format published by that layer.
 * @param supportsFineMatrices - Whether the source exposes the extra close-scale matrices.
 * @returns A non-wrapping OpenLayers source with the required attribution.
 */
function createSwissTopoWmtsSource(
  layerId: string,
  format: SwissTopoTileFormat,
  supportsFineMatrices = false,
): WMTS {
  return new WMTS({
    url: `https://wmts.geo.admin.ch/1.0.0/${layerId}/default/current/2056/{TileMatrix}/{TileCol}/{TileRow}.${format}`,
    layer: layerId,
    matrixSet: '2056',
    style: 'default',
    format: `image/${format}`,
    projection: MAP_PROJECTION_CODE,
    requestEncoding: 'REST',
    tileGrid: supportsFineMatrices
      ? FINE_LV95_TILE_GRID
      : STANDARD_LV95_TILE_GRID,
    attributions: SWISSTOPO_ATTRIBUTION,
    crossOrigin: 'anonymous',
    wrapX: false,
  });
}

/** Creates one official swisstopo background in the native LV95 WMTS grid. */
export function createBaseMapSource(style: BaseMapStyle): WMTS {
  return createSwissTopoWmtsSource(
    SWISSTOPO_BASE_MAP_LAYER_IDS[style],
    'jpeg',
    style === 'aerial',
  );
}

/** Creates the detailed 1:10,000 grey map used at close zoom levels. */
export function createGrayDetailMapSource(): WMTS {
  return createSwissTopoWmtsSource(
    SWISSTOPO_GRAY_DETAIL_LAYER_ID,
    'png',
  );
}

/** Creates the rendered official hiking-trail overlay in native LV95. */
export function createHikingTrailsSource(): WMTS {
  return createSwissTopoWmtsSource(
    SWISSTOPO_HIKING_TRAILS_LAYER_ID,
    'png',
  );
}

/** Creates the official SwitzerlandMobility hiking-route overlay in native LV95. */
export function createSwitzerlandMobilityHikingSource(): WMTS {
  return createSwissTopoWmtsSource(
    SWITZERLAND_MOBILITY_HIKING_LAYER_ID,
    'png',
  );
}
