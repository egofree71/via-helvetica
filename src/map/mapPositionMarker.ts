/**
 * Business context: displays the explicit point inspected by a desktop
 * right-click. It deliberately reuses the search-result marker appearance so
 * exact coordinates have one visual language regardless of how they were
 * obtained, while keeping an independent feature lifecycle.
 */
import type { Coordinate } from 'ol/coordinate.js';
import {
  clearSearchResultMarker,
  createSearchResultMarker,
  updateSearchResultMarker,
  type SearchResultMarker,
} from './searchResult';

/** Map-position marker kept independent from the current search result. */
export type MapPositionMarker = SearchResultMarker;

/** Explicit inspection stays above hover-only route/profile feedback. */
const MAP_POSITION_MARKER_Z_INDEX = 22;

/** Creates an initially hidden marker with the same style as exact search results. */
export function createMapPositionMarker(): MapPositionMarker {
  const marker = createSearchResultMarker();
  marker.layer.setZIndex(MAP_POSITION_MARKER_Z_INDEX);
  return marker;
}

/** Moves the inspected-position marker to one native map coordinate. */
export function updateMapPositionMarker(
  marker: MapPositionMarker,
  coordinate: Coordinate,
): void {
  updateSearchResultMarker(marker, coordinate);
}

/** Hides the inspected-position marker when its panel is dismissed. */
export function clearMapPositionMarker(marker: MapPositionMarker): void {
  clearSearchResultMarker(marker);
}
