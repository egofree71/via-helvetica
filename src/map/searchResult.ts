/**
 * Business context: renders the one temporary marker associated with a selected
 * place or coordinate search result. Keeping it in a dedicated layer lets
 * search selection change independently from geolocation, route editing, and
 * information popups.
 */
import type { Coordinate } from 'ol/coordinate.js';
import Feature from 'ol/Feature.js';
import Point from 'ol/geom/Point.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import {
  Circle as CircleStyle,
  Fill,
  Stroke,
  Style,
} from 'ol/style.js';

/** OpenLayers objects retained while the selected search result is displayed. */
export interface SearchResultMarker {
  /** Point feature whose geometry is replaced whenever another result is selected. */
  feature: Feature<Point>;
  /** Dedicated layer kept above the editable route and below the profile marker. */
  layer: VectorLayer<VectorSource<Feature<Point>>>;
}

/**
 * Creates the initially hidden marker used for the selected search result.
 * @returns The mutable point feature and its dedicated vector layer.
 */
export function createSearchResultMarker(): SearchResultMarker {
  const feature = new Feature<Point>();
  const source = new VectorSource<Feature<Point>>({
    features: [feature],
  });

  const layer = new VectorLayer({
    source,
    zIndex: 19,
    style: [
      new Style({
        image: new CircleStyle({
          radius: 9,
          fill: new Fill({
            color: '#d53c3c',
          }),
          stroke: new Stroke({
            color: '#ffffff',
            width: 3,
          }),
        }),
      }),
      new Style({
        image: new CircleStyle({
          radius: 2.5,
          fill: new Fill({
            color: '#ffffff',
          }),
        }),
      }),
    ],
  });

  return {
    feature,
    layer,
  };
}

/**
 * Moves the search-result marker to a projected map coordinate.
 * @param marker - Marker objects created by `createSearchResultMarker()`.
 * @param coordinate - Selected location in the current map projection.
 */
export function updateSearchResultMarker(
  marker: SearchResultMarker,
  coordinate: Coordinate,
): void {
  marker.feature.setGeometry(new Point(coordinate));
}

/**
 * Hides the selected search result when another map interaction takes over.
 * @param marker - Marker objects created by `createSearchResultMarker()`.
 */
export function clearSearchResultMarker(
  marker: SearchResultMarker,
): void {
  marker.feature.setGeometry(undefined);
}
