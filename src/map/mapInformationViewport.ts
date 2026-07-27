/**
 * Business context: keeps the exact map location chosen by the user readable
 * when a temporary information panel opens. Stops are points, while closures
 * and military notices may represent long lines or broad polygons, so the click
 * coordinate is preserved instead of recentering an arbitrary feature extent.
 */
import type Map from 'ol/Map.js';
import type { Coordinate } from 'ol/coordinate.js';
import type { Pixel } from 'ol/pixel.js';

/**
 * Outer map margin in CSS pixels. It prevents a selected location from being
 * pushed directly against the viewport edge, where symbols become hard to read.
 */
const MAP_INFORMATION_VIEWPORT_MARGIN_PX = 24;
/**
 * Clearance in CSS pixels around the panel for point selections. A little
 * surrounding map context keeps a stop symbol visually distinguishable without
 * causing an unnecessary pan.
 */
const MAP_INFORMATION_POPUP_CLEARANCE_PX = 18;
/**
 * Clearance in CSS pixels used for line and polygon selections. The larger
 * buffer prevents a clicked closure or danger zone from remaining technically
 * visible as only a narrow fragment beside the panel.
 */
const MAP_INFORMATION_FOCUS_CLEARANCE_PX = 72;
/**
 * Minimum width or height in CSS pixels for preferring a free map region. This
 * avoids moving a selection into a narrow strip occupied by floating controls.
 */
const MAP_INFORMATION_MIN_USABLE_REGION_PX = 80;
/**
 * Pan duration in milliseconds. The movement should remain understandable
 * without delaying access to the newly opened information panel.
 */
const MAP_INFORMATION_PAN_DURATION_MS = 300;

/** Screen-space rectangle relative to the map viewport. */
export interface MapInformationPixelRect {
  /** Horizontal coordinate of the left edge in CSS pixels. */
  left: number;
  /** Vertical coordinate of the top edge in CSS pixels. */
  top: number;
  /** Horizontal coordinate of the right edge in CSS pixels. */
  right: number;
  /** Vertical coordinate of the bottom edge in CSS pixels. */
  bottom: number;
}

/** Placement policy for the exact map coordinate selected by the user. */
export type MapInformationAnchorPlacement =
  | 'keep-visible'
  | 'focus-free-region';

/** Inputs used by the pure screen-space visibility calculation. */
export interface MapInformationAnchorLayout {
  /** Current selected-location pixel relative to the map viewport. */
  anchorPixel: Pixel;
  /** Current OpenLayers viewport size in CSS pixels. */
  mapSize: [number, number];
  /** Information-panel bounds relative to the same map viewport. */
  popupRect: MapInformationPixelRect;
  /** Whether to minimize movement or provide more surrounding map context. */
  placement: MapInformationAnchorPlacement;
}

/** Candidate free rectangle and its closest point to the current anchor. */
interface FreeRegionCandidate {
  /** Closest usable pixel inside this free region. */
  nearestPixel: Pixel;
  /** Comfortable centre pixel used for line and polygon selections. */
  centerPixel: Pixel;
  /** Squared movement distance used to compare candidates cheaply. */
  distanceSquared: number;
  /** Region area used to prefer the map area with the most useful context. */
  area: number;
  /** Whether both dimensions provide a genuinely useful visible region. */
  isPreferred: boolean;
}

/** Restricts one value to an inclusive numeric interval. */
function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

/** Returns whether one pixel lies inside a rectangle's interior. */
function containsPixel(rect: MapInformationPixelRect, pixel: Pixel): boolean {
  return (
    pixel[0] > rect.left &&
    pixel[0] < rect.right &&
    pixel[1] > rect.top &&
    pixel[1] < rect.bottom
  );
}

/**
 * Creates the closest usable point inside one free rectangle.
 *
 * @param anchorPixel - Current or edge-clamped selected-location pixel.
 * @param region - Free rectangle outside the expanded information panel.
 * @returns A scored candidate, or `null` when the rectangle has no area.
 */
function createFreeRegionCandidate(
  anchorPixel: Pixel,
  region: MapInformationPixelRect,
): FreeRegionCandidate | null {
  const width = region.right - region.left;
  const height = region.bottom - region.top;

  if (width <= 0 || height <= 0) {
    return null;
  }

  const nearestPixel: Pixel = [
    clamp(anchorPixel[0], region.left, region.right),
    clamp(anchorPixel[1], region.top, region.bottom),
  ];
  const horizontalMovement = nearestPixel[0] - anchorPixel[0];
  const verticalMovement = nearestPixel[1] - anchorPixel[1];

  return {
    nearestPixel,
    centerPixel: [
      Math.round((region.left + region.right) / 2),
      Math.round((region.top + region.bottom) / 2),
    ],
    distanceSquared:
      horizontalMovement * horizontalMovement +
      verticalMovement * verticalMovement,
    area: width * height,
    isPreferred:
      width >= MAP_INFORMATION_MIN_USABLE_REGION_PX &&
      height >= MAP_INFORMATION_MIN_USABLE_REGION_PX,
  };
}

/**
 * Finds the nearest visible pixel for a selected map location.
 *
 * The calculation first respects ordinary viewport margins. Point selections
 * use the nearest free pixel to avoid needless movement. Line and polygon
 * selections use a larger comfort buffer and, when necessary, move the click to
 * the centre of the largest useful free region so more than a sliver remains
 * visible beside the panel. Narrow strips are considered only when no genuinely
 * useful region exists.
 *
 * @param layout - Current anchor, viewport size, and measured panel bounds.
 * @returns A new target pixel, or `null` when no map movement is needed.
 */
export function calculateVisibleMapInformationAnchorPixel(
  layout: MapInformationAnchorLayout,
): Pixel | null {
  const [mapWidth, mapHeight] = layout.mapSize;

  if (mapWidth <= 0 || mapHeight <= 0) {
    return null;
  }

  const horizontalMargin = Math.min(
    MAP_INFORMATION_VIEWPORT_MARGIN_PX,
    mapWidth / 2,
  );
  const verticalMargin = Math.min(
    MAP_INFORMATION_VIEWPORT_MARGIN_PX,
    mapHeight / 2,
  );
  const safeViewport: MapInformationPixelRect = {
    left: horizontalMargin,
    top: verticalMargin,
    right: mapWidth - horizontalMargin,
    bottom: mapHeight - verticalMargin,
  };
  const edgeClampedPixel: Pixel = [
    clamp(layout.anchorPixel[0], safeViewport.left, safeViewport.right),
    clamp(layout.anchorPixel[1], safeViewport.top, safeViewport.bottom),
  ];
  const popupClearance =
    layout.placement === 'focus-free-region'
      ? MAP_INFORMATION_FOCUS_CLEARANCE_PX
      : MAP_INFORMATION_POPUP_CLEARANCE_PX;
  const expandedPopup: MapInformationPixelRect = {
    left: layout.popupRect.left - popupClearance,
    top: layout.popupRect.top - popupClearance,
    right: layout.popupRect.right + popupClearance,
    bottom: layout.popupRect.bottom + popupClearance,
  };

  if (!containsPixel(expandedPopup, edgeClampedPixel)) {
    return edgeClampedPixel[0] === layout.anchorPixel[0] &&
      edgeClampedPixel[1] === layout.anchorPixel[1]
      ? null
      : edgeClampedPixel;
  }

  const regions: MapInformationPixelRect[] = [
    {
      left: safeViewport.left,
      top: safeViewport.top,
      right: Math.min(safeViewport.right, expandedPopup.left),
      bottom: safeViewport.bottom,
    },
    {
      left: Math.max(safeViewport.left, expandedPopup.right),
      top: safeViewport.top,
      right: safeViewport.right,
      bottom: safeViewport.bottom,
    },
    {
      left: safeViewport.left,
      top: safeViewport.top,
      right: safeViewport.right,
      bottom: Math.min(safeViewport.bottom, expandedPopup.top),
    },
    {
      left: safeViewport.left,
      top: Math.max(safeViewport.top, expandedPopup.bottom),
      right: safeViewport.right,
      bottom: safeViewport.bottom,
    },
  ];
  const candidates = regions
    .map((region) => createFreeRegionCandidate(edgeClampedPixel, region))
    .filter((candidate): candidate is FreeRegionCandidate => candidate !== null);
  const preferredCandidates = candidates.filter(
    (candidate) => candidate.isPreferred,
  );
  const usableCandidates =
    preferredCandidates.length > 0 ? preferredCandidates : candidates;
  const bestCandidate = usableCandidates.sort((left, right) => {
    if (layout.placement === 'focus-free-region') {
      const areaDifference = right.area - left.area;

      return areaDifference !== 0
        ? areaDifference
        : left.distanceSquared - right.distanceSquared;
    }

    const movementDifference = left.distanceSquared - right.distanceSquared;

    return movementDifference !== 0
      ? movementDifference
      : right.area - left.area;
  })[0];

  if (!bestCandidate) {
    return null;
  }

  return layout.placement === 'focus-free-region'
    ? bestCandidate.centerPixel
    : bestCandidate.nearestPixel;
}

/**
 * Pans the map when the selected coordinate is hidden, too close to a viewport
 * edge, or lacks useful context beside a line or polygon information panel. The
 * current zoom and the clicked geographic coordinate remain unchanged.
 *
 * @param map - Mounted OpenLayers map displaying the selected information.
 * @param coordinate - Exact coordinate clicked by the user in LV95.
 * @param popupElement - Rendered information panel whose bounds obscure the map.
 * @param placement - Minimal movement for stops or contextual focus for geometry.
 */
export function ensureMapInformationCoordinateVisible(
  map: Map,
  coordinate: Coordinate,
  popupElement: HTMLElement,
  placement: MapInformationAnchorPlacement,
): void {
  const mapSize = map.getSize();

  if (!mapSize) {
    return;
  }

  const mapTarget = map.getTargetElement();
  const mapBounds = mapTarget.getBoundingClientRect();
  const popupBounds = popupElement.getBoundingClientRect();
  const anchorPixel = map.getPixelFromCoordinate(coordinate);
  const targetPixel = calculateVisibleMapInformationAnchorPixel({
    anchorPixel,
    mapSize: [mapSize[0], mapSize[1]],
    popupRect: {
      left: popupBounds.left - mapBounds.left,
      top: popupBounds.top - mapBounds.top,
      right: popupBounds.right - mapBounds.left,
      bottom: popupBounds.bottom - mapBounds.top,
    },
    placement,
  });

  if (!targetPixel) {
    return;
  }

  // Moving the view centre by the inverse screen-space offset places the
  // selected geographic coordinate at the calculated unobstructed pixel.
  const currentCenterPixel: Pixel = [mapSize[0] / 2, mapSize[1] / 2];
  const targetCenterCoordinate = map.getCoordinateFromPixel([
    currentCenterPixel[0] + anchorPixel[0] - targetPixel[0],
    currentCenterPixel[1] + anchorPixel[1] - targetPixel[1],
  ]);

  map.getView().animate({
    center: targetCenterCoordinate,
    duration: MAP_INFORMATION_PAN_DURATION_MS,
  });
}
