/**
 * Business context: adapts map-framing margins to real desktop and mobile
 * viewport sizes. OpenLayers subtracts padding before choosing a resolution, so
 * fixed desktop margins can otherwise leave too little usable map area and zoom
 * unexpectedly far out on short screens.
 */
import type { Size } from 'ol/size.js';

/** Top, right, bottom, and left padding in CSS pixels. */
export type MapFitPadding = [number, number, number, number];

/** Returns one padding pair scaled to preserve the requested usable map area. */
function scalePaddingPair(
  startPadding: number,
  endPadding: number,
  viewportLength: number,
  minimumFitArea: number,
): [number, number] {
  const desiredTotal = startPadding + endPadding;
  const availableTotal = Math.max(0, viewportLength - minimumFitArea);
  const scale = desiredTotal > 0 ? Math.min(1, availableTotal / desiredTotal) : 1;

  return [Math.round(startPadding * scale), Math.round(endPadding * scale)];
}

/**
 * Scales desired framing margins only when the viewport would otherwise leave
 * too little room for the selected geometry.
 *
 * @param size - Current OpenLayers viewport width and height in CSS pixels.
 * @param desiredPadding - Desktop-oriented top, right, bottom, and left margins.
 * @param minimumFitArea - Minimum usable width and height left for geometry.
 * @returns Responsive top, right, bottom, and left padding in CSS pixels.
 */
export function calculateResponsiveMapFitPadding(
  size: Size,
  desiredPadding: MapFitPadding,
  minimumFitArea: number,
): MapFitPadding {
  const [top, bottom] = scalePaddingPair(
    desiredPadding[0],
    desiredPadding[2],
    size[1],
    minimumFitArea,
  );
  const [right, left] = scalePaddingPair(
    desiredPadding[1],
    desiredPadding[3],
    size[0],
    minimumFitArea,
  );

  return [top, right, bottom, left];
}
