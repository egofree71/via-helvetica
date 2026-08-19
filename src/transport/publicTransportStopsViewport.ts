/**
 * Business context: bounds the stop data materialized around the visible map.
 * Buffered coverage avoids needless provider work during nearby pans; the local
 * static catalog can additionally refresh that coverage before its edge becomes
 * visible because filtering it does not create remote API traffic.
 */
import type { Extent } from 'ol/extent.js';
import { containsExtent } from 'ol/extent.js';

/**
 * Each request extends the visible width and height by 50 percent. This leaves
 * a 25-percent navigation margin on every side without quadrupling the queried
 * surface in dense city centres.
 */
const PUBLIC_TRANSPORT_STOPS_BUFFER_FACTOR = 1.5;

/**
 * Fraction of the visible width/height that must remain loaded beyond every
 * viewport edge before a local-catalog refresh can be skipped. Ten percent
 * keeps source reconciliation outside the visible map while still retaining
 * most of the 25-percent per-side navigation buffer for ordinary pans.
 */
const PUBLIC_TRANSPORT_STOPS_PREFETCH_MARGIN_FACTOR = 0.1;

/** Loaded or pending geographic coverage for one exact map scale context. */
export interface PublicTransportStopsViewportCoverage {
  /** Buffered EPSG:2056 envelope requested from the active stop provider. */
  requestExtent: Extent;
  /** OpenLayers zoom at which the request was prepared. */
  zoom: number;
  /** CSS-pixel canvas size used by the identify portrayal context. */
  imageSize: [number, number];
}

/**
 * Expands one viewport around its centre while preserving its aspect ratio.
 *
 * @param viewportExtent - Visible EPSG:2056 map extent.
 * @returns Buffered request extent used for passenger-stop loading.
 */
export function createBufferedPublicTransportStopsExtent(
  viewportExtent: Extent,
): Extent {
  const centerX = (viewportExtent[0] + viewportExtent[2]) / 2;
  const centerY = (viewportExtent[1] + viewportExtent[3]) / 2;
  const halfWidth =
    ((viewportExtent[2] - viewportExtent[0]) *
      PUBLIC_TRANSPORT_STOPS_BUFFER_FACTOR) /
    2;
  const halfHeight =
    ((viewportExtent[3] - viewportExtent[1]) *
      PUBLIC_TRANSPORT_STOPS_BUFFER_FACTOR) /
    2;

  return [
    centerX - halfWidth,
    centerY - halfHeight,
    centerX + halfWidth,
    centerY + halfHeight,
  ];
}

/**
 * Captures the buffered request envelope and the scale context that makes it
 * reusable for later nearby pans.
 *
 * @param viewportExtent - Visible EPSG:2056 map extent.
 * @param zoom - Current OpenLayers zoom.
 * @param imageSize - Current map canvas size in CSS pixels.
 * @returns Immutable coverage metadata for a pending or completed request.
 */
export function createPublicTransportStopsViewportCoverage(
  viewportExtent: Extent,
  zoom: number,
  imageSize: [number, number],
): PublicTransportStopsViewportCoverage {
  return {
    requestExtent: createBufferedPublicTransportStopsExtent(viewportExtent),
    zoom,
    imageSize: [...imageSize],
  };
}

/** Returns whether coverage was prepared for the current scale and canvas. */
function publicTransportStopsCoverageMatchesViewContext(
  coverage: PublicTransportStopsViewportCoverage | null,
  zoom: number,
  imageSize: [number, number],
): coverage is PublicTransportStopsViewportCoverage {
  return Boolean(
    coverage &&
      coverage.zoom === zoom &&
      coverage.imageSize[0] === imageSize[0] &&
      coverage.imageSize[1] === imageSize[1],
  );
}

/**
 * Reports whether one pending or completed request can serve the current view.
 * A zoom or canvas-size change invalidates reuse because GeoAdmin identify uses
 * both values to describe portrayal scale, even when the geometry still fits.
 *
 * @param coverage - Existing pending or completed request metadata.
 * @param viewportExtent - Current visible EPSG:2056 extent.
 * @param zoom - Current OpenLayers zoom.
 * @param imageSize - Current map canvas size in CSS pixels.
 * @returns Whether another provider request can be skipped safely.
 */
export function publicTransportStopsCoverageContainsViewport(
  coverage: PublicTransportStopsViewportCoverage | null,
  viewportExtent: Extent,
  zoom: number,
  imageSize: [number, number],
): boolean {
  return (
    publicTransportStopsCoverageMatchesViewContext(
      coverage,
      zoom,
      imageSize,
    ) && containsExtent(coverage.requestExtent, viewportExtent)
  );
}

/**
 * Reports whether buffered data still extends beyond the current viewport by a
 * small safety margin. The local catalog uses this stronger condition while the
 * map is moving so entering/leaving features are reconciled off-screen instead
 * of appearing as a visible band after the old coverage edge is reached.
 *
 * GeoAdmin requests deliberately do not use this proactive policy because each
 * refresh can fan out into many remote identify calls.
 *
 * @param coverage - Existing local-catalog coverage metadata.
 * @param viewportExtent - Current visible EPSG:2056 extent.
 * @param zoom - Current OpenLayers zoom.
 * @param imageSize - Current map canvas size in CSS pixels.
 * @returns Whether the current viewport still has the required loaded margin.
 */
export function publicTransportStopsCoverageKeepsPrefetchMargin(
  coverage: PublicTransportStopsViewportCoverage | null,
  viewportExtent: Extent,
  zoom: number,
  imageSize: [number, number],
): boolean {
  if (
    !publicTransportStopsCoverageMatchesViewContext(
      coverage,
      zoom,
      imageSize,
    )
  ) {
    return false;
  }

  const width = viewportExtent[2] - viewportExtent[0];
  const height = viewportExtent[3] - viewportExtent[1];
  const horizontalMargin =
    width * PUBLIC_TRANSPORT_STOPS_PREFETCH_MARGIN_FACTOR;
  const verticalMargin =
    height * PUBLIC_TRANSPORT_STOPS_PREFETCH_MARGIN_FACTOR;

  return containsExtent(coverage.requestExtent, [
    viewportExtent[0] - horizontalMargin,
    viewportExtent[1] - verticalMargin,
    viewportExtent[2] + horizontalMargin,
    viewportExtent[3] + verticalMargin,
  ]);
}
