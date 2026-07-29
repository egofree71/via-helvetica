/**
 * Business context: centralizes the official swisstopo layer identifiers,
 * native LV95 WMTS grids, geographic limits, and zoom policy used by the map.
 * Keeping these provider and scale decisions together prevents individual
 * components from inventing incompatible projections or visibility thresholds.
 */
import type { Coordinate } from 'ol/coordinate.js';
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

/**
 * This extent is not the exact administrative boundary. It keeps a small
 * margin around Switzerland so nearby cross-border access remains visible,
 * while preventing navigation to areas that are irrelevant to the project.
 *
 * Coordinate order: west, south, east, north (WGS 84 / EPSG:4326).
 */
export const MAP_BOUNDS_WGS84 = [5.7, 45.65, 10.75, 47.95];

/**
 * Checks the unprojected coordinate against the product's documented map
 * bounds before Swiss projection. This avoids accepting distant antipodal
 * coordinates that the Swiss Oblique Mercator projection can fold back into the LV95 extent.
 * @param coordinate - Longitude and latitude in decimal WGS 84 degrees.
 * @returns True when the coordinate belongs to the supported Swiss map area.
 */
export function isWgs84CoordinateInsideMapBounds(
  coordinate: Coordinate,
): boolean {
  const [longitude, latitude] = coordinate;
  const [west, south, east, north] = MAP_BOUNDS_WGS84;

  return (
    Number.isFinite(longitude) &&
    Number.isFinite(latitude) &&
    longitude >= west &&
    longitude <= east &&
    latitude >= south &&
    latitude <= north
  );
}

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
 * Minimum user-adjustable information-layer opacity ratio. A visible layer
 * below 20% can look broken while its visibility toggle remains enabled;
 * lowering this value increases that ambiguity, while raising it reduces the
 * useful adjustment range.
 */
export const MINIMUM_MAP_LAYER_OPACITY = 0.2;

/**
 * Default opacity ratio (0 = transparent, 1 = opaque) for ordinary hiking
 * trails. A value of 0.8 keeps the yellow network clearly readable while still
 * revealing labels and terrain details beneath the official portrayal.
 */
export const DEFAULT_HIKING_TRAILS_OPACITY = 0.8;

/**
 * Default opacity ratio for the thick green SwitzerlandMobility routes. A value
 * of 0.6 keeps route continuity clear while allowing place names, roads, and
 * terrain symbols to remain readable below the portrayal.
 */
export const DEFAULT_SWITZERLAND_MOBILITY_HIKING_OPACITY = 0.6;

/**
 * Default opacity ratio for closures and detours. A value of 0.8 keeps safety
 * information prominent while allowing labels and map details to remain visible.
 */
export const DEFAULT_TRAIL_CLOSURES_OPACITY = 0.8;

/**
 * Default opacity ratio for large military polygons. Partial opacity preserves
 * the perimeter while keeping map detail readable underneath.
 */
export const DEFAULT_SHOOTING_DANGER_ZONES_OPACITY = 0.6;

/**
 * Default opacity ratio for public-transport symbols. Full opacity keeps small
 * mode icons legible; visitors may reduce it when the map becomes crowded.
 */
export const DEFAULT_PUBLIC_TRANSPORT_STOPS_OPACITY = 1;

/*
 * The 1:10,000 grey map supplements the national grey background from native
 * level 25. Levels 27 and 28 are client zooms for this layer and stretch its
 * finest published tile level, as documented by the WMTS service.
 */
export const GRAY_DETAIL_MIN_ZOOM = 24;

/** Browser geolocation reveals nearby streets and trails at 5 m/px or closer. */
export const USER_LOCATION_ZOOM = 21;

/** Place search opens at the native 20 m/px planning level. */
export const LOCATION_SEARCH_ZOOM = 19;
/** Exact coordinate search opens at 5 m/px, matching explicit geolocation. */
export const COORDINATE_SEARCH_ZOOM = USER_LOCATION_ZOOM;

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
