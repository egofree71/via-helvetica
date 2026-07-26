/**
 * Business context: highlights one public SwitzerlandMobility hiking route above
 * the green raster overview. The separate vector overlay gives the selected
 * route a clear white casing and opaque centre line while keeping the user's own
 * imported or editable itinerary visually dominant.
 */
import type { Coordinate } from 'ol/coordinate.js';
import type { Extent } from 'ol/extent.js';
import { isEmpty } from 'ol/extent.js';
import Feature from 'ol/Feature.js';
import LineString from 'ol/geom/LineString.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import Stroke from 'ol/style/Stroke.js';
import Style from 'ol/style/Style.js';
import type { SwitzerlandMobilityHikingRoute } from '../switzerlandMobility/hikingRoutes';

/** OpenLayers resources used to emphasize one selected public hiking route. */
export interface SwitzerlandMobilityHikingSelectionDisplay {
  /** Vector layer inserted above the general route portrayal. */
  layer: VectorLayer<VectorSource<Feature<LineString>>>;
  /** Mutable source replaced whenever the route selection changes. */
  source: VectorSource<Feature<LineString>>;
}

/** White halo width in screen pixels; separates green routes from dense maps. */
const SELECTION_CASING_WIDTH_PX = 10;

/** Opaque centre-line width in screen pixels; remains legible after fitting out. */
const SELECTION_LINE_WIDTH_PX = 5;

/** Darker green distinguishes the selected route from the 60% raster overlay. */
const SELECTION_LINE_COLOR = '#087f2c';

/** Dual stroke keeps the route readable over colour, grey, and aerial maps. */
const SELECTION_STYLE = [
  new Style({
    stroke: new Stroke({
      color: 'rgba(255, 255, 255, 0.95)',
      width: SELECTION_CASING_WIDTH_PX,
      lineCap: 'round',
      lineJoin: 'round',
    }),
    zIndex: 0,
  }),
  new Style({
    stroke: new Stroke({
      color: SELECTION_LINE_COLOR,
      width: SELECTION_LINE_WIDTH_PX,
      lineCap: 'round',
      lineJoin: 'round',
    }),
    zIndex: 1,
  }),
];

/** Creates the persistent vector overlay used for one temporary selection. */
export function createSwitzerlandMobilityHikingSelectionDisplay(): SwitzerlandMobilityHikingSelectionDisplay {
  const source = new VectorSource<Feature<LineString>>();
  const layer = new VectorLayer({
    source,
    style: SELECTION_STYLE,
  });

  return { layer, source };
}

/**
 * Replaces or clears the highlighted route while preserving independent line
 * parts returned by the public dataset.
 *
 * @param display - Persistent OpenLayers selection resources.
 * @param route - Complete selected route, or `null` to clear the overlay.
 * @returns Selected geometry extent in EPSG:2056, or `null` when cleared.
 */
export function updateSwitzerlandMobilityHikingSelection(
  display: SwitzerlandMobilityHikingSelectionDisplay,
  route: SwitzerlandMobilityHikingRoute | null,
): Extent | null {
  display.source.clear();

  if (!route) {
    return null;
  }

  const features = route.segments
    .filter((segment) => segment.length >= 2)
    .map(
      (segment) =>
        new Feature<LineString>({
          geometry: new LineString(
            segment.map(
              (coordinate): Coordinate => [coordinate[0], coordinate[1]],
            ),
          ),
        }),
    );

  display.source.addFeatures(features);
  const extent = display.source.getExtent();

  return features.length > 0 && !isEmpty(extent) ? [...extent] : null;
}
