/**
 * Business context: renders filtered passenger stops as client-side OpenLayers
 * vectors. The official raster portrayal cannot be filtered after rendering,
 * so this module owns zoom-aware pictograms, deterministic fan-out for nearby
 * facilities, screen-space decluttering, and the selected-stop halo used by the
 * information popup.
 */
import type { Coordinate } from 'ol/coordinate.js';
import type OlMap from 'ol/Map.js';
import Feature, { type FeatureLike } from 'ol/Feature.js';
import Point from 'ol/geom/Point.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import CircleStyle from 'ol/style/Circle.js';
import Fill from 'ol/style/Fill.js';
import Icon from 'ol/style/Icon.js';
import Stroke from 'ol/style/Stroke.js';
import Style from 'ol/style/Style.js';
import boatIconUrl from '../assets/public-transport-stops/boat.svg';
import busIconUrl from '../assets/public-transport-stops/bus.svg';
import cableCarIconUrl from '../assets/public-transport-stops/cable-car.svg';
import chairliftIconUrl from '../assets/public-transport-stops/chairlift.svg';
import funicularIconUrl from '../assets/public-transport-stops/funicular.svg';
import trainIconUrl from '../assets/public-transport-stops/train.svg';
import tramIconUrl from '../assets/public-transport-stops/tram.svg';
import { LV95_VIEW_RESOLUTIONS } from '../map/projection';
import {
  getPrimaryPublicTransportMode,
  type PublicTransportMode,
  type PublicTransportStop,
} from './publicTransportStopModel';

/**
 * Stops are useful only at detailed scales. OpenLayers treats this boundary as
 * exclusive, so a value of 18 displays the layer from native level 19.
 */
export const PUBLIC_TRANSPORT_STOPS_MIN_ZOOM = 18;

/** Compact symbol size in CSS pixels at broad urban and regional scales. */
const STOP_ICON_OVERVIEW_SIZE_PIXELS = 20;

/** Intermediate symbol size in CSS pixels before street-level planning. */
const STOP_ICON_MEDIUM_SIZE_PIXELS = 23;

/** Symbol size in CSS pixels once individual streets and paths are prominent. */
const STOP_ICON_DETAILED_SIZE_PIXELS = 29;

/** Symbol size in CSS pixels when building detail becomes dominant. */
const STOP_ICON_VERY_DETAILED_SIZE_PIXELS = 33;

/** Final symbol size in CSS pixels at the closest hiking-planning scales. */
const STOP_ICON_CLOSE_SIZE_PIXELS = 37;

/** First native zoom level receiving the medium symbol size. */
const STOP_ICON_MEDIUM_ZOOM = 21;

/** First native zoom level receiving the detailed symbol size. */
const STOP_ICON_DETAILED_ZOOM = 25;

/** First native zoom level receiving the very-detailed symbol size. */
const STOP_ICON_VERY_DETAILED_ZOOM = 26;

/** First native zoom level receiving the final close-scale symbol size. */
const STOP_ICON_CLOSE_ZOOM = 27;

/** Attribution attached to the vector source built from the official layer. */
const PUBLIC_TRANSPORT_STOPS_ATTRIBUTION =
  '<a href="https://www.bav.admin.ch/" target="_blank" rel="noopener noreferrer">© BAV</a>';

/** Internal feature property containing structured stop metadata. */
const STOP_PROPERTY_NAME = 'publicTransportStop';

/** Internal feature property describing close-stop visual separation. */
const STOP_OVERLAP_LAYOUT_PROPERTY_NAME = 'publicTransportStopOverlapLayout';

/** Internal presentation flag set by screen-space decluttering. */
const STOP_DECLUTTER_VISIBLE_PROPERTY_NAME =
  'publicTransportStopDeclutterVisible';

/** Extra centre-to-centre spacing in CSS pixels around the current icon. */
const STOP_DECLUTTER_PADDING_PIXELS = 4;

/**
 * Distinct stops within 60 metres can overlap at medium zoom levels. They stay
 * separate data objects and are only fanned apart visually until their real
 * positions become distinguishable.
 */
const STOP_OVERLAP_DISTANCE_METERS = 60;

/** Base fan-out radius in CSS pixels before scaling with the current icon size. */
const STOP_OVERLAP_DISPLAY_RADIUS_PIXELS = 17;

/** OpenLayers resources owned by the map runtime for the stop overlay. */
export interface PublicTransportStopsDisplay {
  /** Vector layer placed above hiking and closure information. */
  layer: VectorLayer<VectorSource<Feature<Point>>>;
  /** Mutable source replaced after each completed viewport request. */
  source: VectorSource<Feature<Point>>;
  /** Halo layer that keeps the selected stop identifiable under the popup. */
  selectionLayer: VectorLayer<VectorSource<Feature<Point>>>;
  /** Source containing at most one selected-stop marker. */
  selectionSource: VectorSource<Feature<Point>>;
  /** Concrete stop currently selected by the user and represented by a halo. */
  selectedStopId: string | null;
  /** Stop that temporarily wins decluttering, including a chooser representative. */
  declutterPriorityStopId: string | null;
  /** Current view rotation used by screen-aligned fan-out icon displacement. */
  viewRotation: number;
  /** Last screen-space inputs used to avoid redundant decluttering passes. */
  declutterSnapshot: string | null;
}

/** Visual layout for one stop that belongs to a close-symbol group. */
interface StopOverlapLayout {
  /** Stable identifier shared by stops intentionally fanned out together. */
  groupId: string;
  /** Shared group centre in EPSG:2056 map coordinates. */
  center: Coordinate;
  /** Furthest real stop distance from the group centre in LV95 metres. */
  radiusMapUnits: number;
  /** Desired symbol position relative to the centre in CSS pixels. */
  targetOffsetPixels: Coordinate;
}

/** Returns the discrete stop-symbol size for the current native LV95 scale. */
function getStopIconSize(resolution: number): number {
  if (!Number.isFinite(resolution) || resolution <= 0) {
    return STOP_ICON_OVERVIEW_SIZE_PIXELS;
  }

  if (resolution <= LV95_VIEW_RESOLUTIONS[STOP_ICON_CLOSE_ZOOM]) {
    return STOP_ICON_CLOSE_SIZE_PIXELS;
  }

  if (resolution <= LV95_VIEW_RESOLUTIONS[STOP_ICON_VERY_DETAILED_ZOOM]) {
    return STOP_ICON_VERY_DETAILED_SIZE_PIXELS;
  }

  if (resolution <= LV95_VIEW_RESOLUTIONS[STOP_ICON_DETAILED_ZOOM]) {
    return STOP_ICON_DETAILED_SIZE_PIXELS;
  }

  if (resolution <= LV95_VIEW_RESOLUTIONS[STOP_ICON_MEDIUM_ZOOM]) {
    return STOP_ICON_MEDIUM_SIZE_PIXELS;
  }

  return STOP_ICON_OVERVIEW_SIZE_PIXELS;
}

/** Keeps the fan-out radius tied directly to the rendered symbol radius. */
function getStopOverlapDisplayRadius(iconSize: number): number {
  return iconSize / 2 + 4.5;
}

/** Releases displacement once real positions leave only a small icon overlap. */
function getStopOverlapReleaseRadius(iconSize: number): number {
  return iconSize / 2 + 1.5;
}

/** Returns planar distance in LV95 metres between two map coordinates. */
function mapCoordinateDistance(
  first: Coordinate,
  second: Coordinate,
): number {
  return Math.hypot(first[0] - second[0], first[1] - second[1]);
}

/**
 * Assigns a deterministic fan layout to distinct stops whose symbols would
 * otherwise overlap. Nearby facilities remain independently selectable and
 * retain their own official identifiers and timetable requests.
 */
function createStopOverlapLayouts(
  stops: PublicTransportStop[],
): Map<string, StopOverlapLayout> {
  const layouts = new Map<string, StopOverlapLayout>();
  const remaining = new Set(stops.map((stop) => stop.id));
  const orderedStops = [...stops].sort((first, second) =>
    first.id.localeCompare(second.id),
  );

  for (const anchor of orderedStops) {
    if (!remaining.has(anchor.id)) {
      continue;
    }

    const closeStops = orderedStops.filter(
      (candidate) =>
        remaining.has(candidate.id) &&
        mapCoordinateDistance(anchor.coordinate, candidate.coordinate) <=
          STOP_OVERLAP_DISTANCE_METERS,
    );

    for (const stop of closeStops) {
      remaining.delete(stop.id);
    }

    if (closeStops.length < 2) {
      continue;
    }

    const center: Coordinate = [
      closeStops.reduce((sum, stop) => sum + stop.coordinate[0], 0) /
        closeStops.length,
      closeStops.reduce((sum, stop) => sum + stop.coordinate[1], 0) /
        closeStops.length,
    ];
    const radiusMapUnits = Math.max(
      ...closeStops.map((stop) =>
        mapCoordinateDistance(stop.coordinate, center),
      ),
    );

    closeStops.forEach((stop, index) => {
      const angle = (2 * Math.PI * index) / closeStops.length;
      layouts.set(stop.id, {
        groupId: anchor.id,
        center,
        radiusMapUnits,
        targetOffsetPixels: [
          Math.cos(angle) * STOP_OVERLAP_DISPLAY_RADIUS_PIXELS,
          Math.sin(angle) * STOP_OVERLAP_DISPLAY_RADIUS_PIXELS,
        ],
      });
    });
  }

  return layouts;
}

/** Reads an internal close-symbol layout from one rendered feature. */
function getStopOverlapLayout(
  feature: FeatureLike,
): StopOverlapLayout | null {
  const value = feature.get(STOP_OVERLAP_LAYOUT_PROPERTY_NAME) as unknown;

  if (!value || typeof value !== 'object') {
    return null;
  }

  const layout = value as Partial<StopOverlapLayout>;
  return typeof layout.groupId === 'string' &&
    Array.isArray(layout.center) &&
    typeof layout.radiusMapUnits === 'number' &&
    Array.isArray(layout.targetOffsetPixels)
    ? (layout as StopOverlapLayout)
    : null;
}

/** Returns whether a close-stop group is still being visually fanned out. */
function isStopOverlapLayoutActive(
  layout: StopOverlapLayout | null,
  resolution: number,
  iconSize: number,
): layout is StopOverlapLayout {
  return Boolean(
    layout &&
      Number.isFinite(resolution) &&
      resolution > 0 &&
      layout.radiusMapUnits / resolution <
        getStopOverlapReleaseRadius(iconSize),
  );
}

/**
 * Converts a close-stop layout into an OpenLayers screen-aligned displacement.
 * Real map offsets are rotated into view axes before subtraction; otherwise a
 * rotated map would fan symbols around a different centre than the one painted.
 */
function calculateStopDisplacement(
  coordinate: Coordinate,
  layout: StopOverlapLayout | null,
  resolution: number,
  iconSize: number,
  rotation: number,
): Coordinate {
  if (!isStopOverlapLayoutActive(layout, resolution, iconSize)) {
    return [0, 0];
  }

  const mapOffsetX = (coordinate[0] - layout.center[0]) / resolution;
  const mapOffsetY = (coordinate[1] - layout.center[1]) / resolution;
  const cosRotation = Math.cos(rotation);
  const sinRotation = Math.sin(rotation);
  // Positive OpenLayers view rotation turns the map clockwise on screen, so the
  // map-space offset must be rotated by the opposite angle into icon axes.
  const naturalOffsetPixels: Coordinate = [
    mapOffsetX * cosRotation + mapOffsetY * sinRotation,
    -mapOffsetX * sinRotation + mapOffsetY * cosRotation,
  ];
  const targetRadiusScale =
    getStopOverlapDisplayRadius(iconSize) /
    STOP_OVERLAP_DISPLAY_RADIUS_PIXELS;

  return [
    layout.targetOffsetPixels[0] * targetRadiusScale - naturalOffsetPixels[0],
    layout.targetOffsetPixels[1] * targetRadiusScale - naturalOffsetPixels[1],
  ];
}

/** Returns the desired centre-to-centre spacing for current stop symbols. */
export function getPublicTransportStopDeclutterSeparationPixels(
  resolution: number,
): number {
  return getStopIconSize(resolution) + STOP_DECLUTTER_PADDING_PIXELS;
}

/** Returns whether one loaded stop currently survives screen-space decluttering. */
function isStopDeclutterVisible(feature: FeatureLike): boolean {
  return feature.get(STOP_DECLUTTER_VISIBLE_PROPERTY_NAME) !== false;
}

/** Screen-space placement derived from the exact fan-out used for rendering. */
interface StopVisualPlacement {
  /** CSS-pixel centre after applying any close-stop fan-out. */
  centerPixels: Coordinate;
  /** Fan-out group exempt from collisions only while fan-out is actually active. */
  activeOverlapGroupId: string | null;
}

/**
 * Converts one stop's official coordinate plus any active fan-out displacement
 * to the exact CSS-pixel centre used by OpenLayers for the current rendered view.
 */
function getStopVisualPlacement(
  map: OlMap,
  feature: Feature<Point>,
  resolution: number,
): StopVisualPlacement | null {
  const stop = getPublicTransportStopFromFeature(feature);

  if (!stop) {
    return null;
  }

  const basePixel = map.getPixelFromCoordinate(stop.coordinate);

  if (!basePixel) {
    return null;
  }

  const layout = getStopOverlapLayout(feature);
  const iconSize = getStopIconSize(resolution);
  const displacement = calculateStopDisplacement(
    stop.coordinate,
    layout,
    resolution,
    iconSize,
    map.getView().getRotation(),
  );

  // OpenLayers icon displacement uses a positive Y value upwards, whereas map
  // screen pixels grow downwards. Mirror that axis when comparing real centres.
  return {
    centerPixels: [
      basePixel[0] + displacement[0],
      basePixel[1] - displacement[1],
    ],
    activeOverlapGroupId: isStopOverlapLayoutActive(
      layout,
      resolution,
      iconSize,
    )
      ? layout.groupId
      : null,
  };
}

/** Spatial-grid entry used to keep dense-city decluttering close to O(n). */
interface DeclutterCandidate {
  /** Loaded feature whose visibility flag is updated in place. */
  feature: Feature<Point>;
  /** Stable stop identifier used for deterministic ordering. */
  stopId: string;
  /** CSS-pixel centre after applying any close-stop fan-out. */
  centerPixels: Coordinate;
  /** Fan-out group exempt from blocking collisions with its own members. */
  collisionGroup: string | null;
}

/** Returns one signed grid key for a CSS-pixel symbol centre. */
function declutterGridKey(x: number, y: number): string {
  return `${x}:${y}`;
}

/**
 * Applies deterministic screen-space decluttering without removing any stop
 * feature from the source. The current declutter-priority stop is considered
 * first, while members of the same actively fanned-out group never hide each
 * other.
 *
 * @param display - Persistent OpenLayers resources for public-transport stops.
 * @param map - Mounted map used to resolve exact rotated screen positions.
 */
export function applyPublicTransportStopDeclutterVisibility(
  display: PublicTransportStopsDisplay,
  map: OlMap,
): void {
  const mapSize = map.getSize();

  // OpenLayers can still dispatch postrender while a temporarily detached or
  // collapsed map target has zero area. Do not invalidate the layer from that
  // unusable frame or it would schedule another identical render indefinitely.
  if (!mapSize || mapSize[0] <= 0 || mapSize[1] <= 0) {
    display.declutterSnapshot = null;
    return;
  }

  const resolution = map.getView().getResolution();
  const rotation = map.getView().getRotation();

  if (!resolution || !Number.isFinite(resolution) || resolution <= 0) {
    for (const feature of display.source.getFeatures()) {
      feature.set(STOP_DECLUTTER_VISIBLE_PROPERTY_NAME, true, true);
    }
    display.declutterSnapshot = null;
    display.layer.changed();
    return;
  }

  const sourceRevision = display.source.getRevision();
  const snapshot = [
    sourceRevision,
    resolution,
    rotation,
    display.declutterPriorityStopId ?? '',
  ].join(':');

  if (display.declutterSnapshot === snapshot) {
    return;
  }

  const separation =
    getPublicTransportStopDeclutterSeparationPixels(resolution);
  const separationSquared = separation * separation;
  const candidates: DeclutterCandidate[] = [];
  let hadUnresolvedPixel = false;

  for (const feature of display.source.getFeatures()) {
    const stop = getPublicTransportStopFromFeature(feature);
    const placement = getStopVisualPlacement(map, feature, resolution);

    if (!stop || !placement) {
      // Missing frame transforms are transient. Degrade to visible and avoid
      // caching this incomplete pass so the next rendered frame can retry.
      feature.set(STOP_DECLUTTER_VISIBLE_PROPERTY_NAME, true, true);
      hadUnresolvedPixel = hadUnresolvedPixel || Boolean(stop);
      continue;
    }

    candidates.push({
      feature,
      stopId: stop.id,
      centerPixels: placement.centerPixels,
      collisionGroup: placement.activeOverlapGroupId,
    });
  }

  if (hadUnresolvedPixel && candidates.length === 0) {
    display.declutterSnapshot = null;
    return;
  }

  candidates.sort((first, second) => {
    const firstSelected = first.stopId === display.declutterPriorityStopId;
    const secondSelected = second.stopId === display.declutterPriorityStopId;

    if (firstSelected !== secondSelected) {
      return firstSelected ? -1 : 1;
    }

    return first.stopId.localeCompare(second.stopId);
  });

  const acceptedByCell = new Map<string, DeclutterCandidate[]>();

  for (const candidate of candidates) {
    const cellX = Math.floor(candidate.centerPixels[0] / separation);
    const cellY = Math.floor(candidate.centerPixels[1] / separation);
    let blocked = false;

    for (let xOffset = -1; xOffset <= 1 && !blocked; xOffset += 1) {
      for (let yOffset = -1; yOffset <= 1 && !blocked; yOffset += 1) {
        const neighbours = acceptedByCell.get(
          declutterGridKey(cellX + xOffset, cellY + yOffset),
        );

        if (!neighbours) {
          continue;
        }

        for (const neighbour of neighbours) {
          if (
            candidate.collisionGroup &&
            candidate.collisionGroup === neighbour.collisionGroup
          ) {
            continue;
          }

          const deltaX =
            candidate.centerPixels[0] - neighbour.centerPixels[0];
          const deltaY =
            candidate.centerPixels[1] - neighbour.centerPixels[1];

          if (deltaX * deltaX + deltaY * deltaY < separationSquared) {
            blocked = true;
            break;
          }
        }
      }
    }

    candidate.feature.set(
      STOP_DECLUTTER_VISIBLE_PROPERTY_NAME,
      !blocked,
      true,
    );

    if (!blocked) {
      const key = declutterGridKey(cellX, cellY);
      const cell = acceptedByCell.get(key) ?? [];
      cell.push(candidate);
      acceptedByCell.set(key, cell);
    }
  }

  display.declutterSnapshot = hadUnresolvedPixel ? null : snapshot;
  display.layer.changed();
}

/**
 * Returns hidden stop neighbours represented by a visible symbol that was
 * genuinely hit by OpenLayers. Calling this only after a rendered hit prevents
 * invisible stops from creating clickable "ghost" targets on empty map space.
 *
 * @param display - Persistent stop display containing visible and hidden features.
 * @param map - Mounted map used to reproduce exact fan-out screen positions.
 * @param visibleStop - Stop returned by the rendered layer hit-test.
 * @returns The clicked stop first, followed by nearby hidden stops, deduplicated.
 */
export function getPublicTransportStopChoicesForVisibleStop(
  display: PublicTransportStopsDisplay,
  map: OlMap,
  visibleStop: PublicTransportStop,
): PublicTransportStop[] {
  const resolution = map.getView().getResolution();

  if (!resolution || !Number.isFinite(resolution) || resolution <= 0) {
    return [visibleStop];
  }

  const visibleFeature = display.source.getFeatureById(visibleStop.id);

  if (!visibleFeature) {
    return [visibleStop];
  }

  const visiblePlacement = getStopVisualPlacement(
    map,
    visibleFeature,
    resolution,
  );

  if (!visiblePlacement) {
    return [visibleStop];
  }

  const separation =
    getPublicTransportStopDeclutterSeparationPixels(resolution);
  const separationSquared = separation * separation;
  const hiddenNeighbours: PublicTransportStop[] = [];
  const seenStopIds = new Set<string>([visibleStop.id]);

  for (const feature of display.source.getFeatures()) {
    const stop = getPublicTransportStopFromFeature(feature);

    if (
      !stop ||
      seenStopIds.has(stop.id) ||
      isStopDeclutterVisible(feature)
    ) {
      continue;
    }

    const placement = getStopVisualPlacement(map, feature, resolution);

    if (!placement) {
      continue;
    }

    const deltaX =
      placement.centerPixels[0] - visiblePlacement.centerPixels[0];
    const deltaY =
      placement.centerPixels[1] - visiblePlacement.centerPixels[1];

    if (deltaX * deltaX + deltaY * deltaY < separationSquared) {
      seenStopIds.add(stop.id);
      hiddenNeighbours.push(stop);
    }
  }

  hiddenNeighbours.sort((first, second) => first.id.localeCompare(second.id));
  return [visibleStop, ...hiddenNeighbours];
}

/**
 * Locally bundled vector symbols remain sharp on high-density displays while
 * preserving the familiar Swiss public-transport map language.
 */
const MODE_ICON_URLS: Record<PublicTransportMode, string> = {
  train: trainIconUrl,
  // Metro keeps its own popup label but uses the clear railway map symbol.
  metro: trainIconUrl,
  tram: tramIconUrl,
  bus: busIconUrl,
  boat: boatIconUrl,
  cableCar: cableCarIconUrl,
  chairlift: chairliftIconUrl,
  funicular: funicularIconUrl,
};

/** Cached icon variants keyed by mode, displacement, and CSS-pixel size. */
const MODE_STYLES = new Map<string, Style>();

/** Returns a zoom-aware mode style with one rounded pixel displacement. */
function getModeStyle(
  mode: PublicTransportMode,
  displacement: Coordinate,
  iconSize: number,
): Style {
  const roundedDisplacement: Coordinate = [
    Math.round(displacement[0]),
    Math.round(displacement[1]),
  ];
  const key = `${mode}:${iconSize}:${roundedDisplacement[0]}:${roundedDisplacement[1]}`;
  const cached = MODE_STYLES.get(key);

  if (cached) {
    return cached;
  }

  const style = new Style({
    image: new Icon({
      src: MODE_ICON_URLS[mode],
      width: iconSize,
      height: iconSize,
      displacement: roundedDisplacement,
    }),
  });
  MODE_STYLES.set(key, style);
  return style;
}

/** Cached selection-halo variants aligned with displaced stop symbols. */
const SELECTED_STOP_STYLES = new Map<string, Style>();

/** Returns the selected-stop halo for one displacement and icon size. */
function getSelectedStopStyle(
  displacement: Coordinate,
  iconSize: number,
): Style {
  const roundedDisplacement: Coordinate = [
    Math.round(displacement[0]),
    Math.round(displacement[1]),
  ];
  const key = `${iconSize}:${roundedDisplacement[0]}:${roundedDisplacement[1]}`;
  const cached = SELECTED_STOP_STYLES.get(key);

  if (cached) {
    return cached;
  }

  const style = new Style({
    image: new CircleStyle({
      radius: iconSize / 2 + 4.5,
      displacement: roundedDisplacement,
      fill: new Fill({ color: 'rgba(255, 255, 255, 0.88)' }),
      stroke: new Stroke({ color: '#1769e0', width: 3 }),
    }),
  });
  SELECTED_STOP_STYLES.set(key, style);
  return style;
}

/** Creates the persistent vector layers for filtered and selected stops. */
export function createPublicTransportStopsDisplay(): PublicTransportStopsDisplay {
  let display: PublicTransportStopsDisplay | null = null;
  const source = new VectorSource<Feature<Point>>({
    attributions: PUBLIC_TRANSPORT_STOPS_ATTRIBUTION,
  });
  const selectionSource = new VectorSource<Feature<Point>>();
  const selectionLayer = new VectorLayer({
    source: selectionSource,
    minZoom: PUBLIC_TRANSPORT_STOPS_MIN_ZOOM,
    zIndex: 14,
    style: (feature, resolution) => {
      const iconSize = getStopIconSize(resolution);
      const geometry = feature.getGeometry();
      const coordinate =
        geometry instanceof Point ? geometry.getCoordinates() : null;
      const displacement = coordinate
        ? calculateStopDisplacement(
            coordinate,
            getStopOverlapLayout(feature),
            resolution,
            iconSize,
            display?.viewRotation ?? 0,
          )
        : [0, 0];
      return getSelectedStopStyle(displacement, iconSize);
    },
  });
  const layer = new VectorLayer({
    source,
    minZoom: PUBLIC_TRANSPORT_STOPS_MIN_ZOOM,
    zIndex: 15,
    style: (feature, resolution) => {
      const stop = getPublicTransportStopFromFeature(feature);

      if (!stop || !isStopDeclutterVisible(feature)) {
        return undefined;
      }

      const iconSize = getStopIconSize(resolution);
      const displacement = calculateStopDisplacement(
        stop.coordinate,
        getStopOverlapLayout(feature),
        resolution,
        iconSize,
        display?.viewRotation ?? 0,
      );
      return getModeStyle(
        getPrimaryPublicTransportMode(stop.modes),
        displacement,
        iconSize,
      );
    },
  });

  display = {
    layer,
    source,
    selectionLayer,
    selectionSource,
    selectedStopId: null,
    declutterPriorityStopId: null,
    viewRotation: 0,
    declutterSnapshot: null,
  };
  return display;
}

/** Replaces loaded stop features after one completed viewport request. */
export function updatePublicTransportStopsDisplay(
  display: PublicTransportStopsDisplay,
  stops: PublicTransportStop[],
): void {
  const overlapLayouts = createStopOverlapLayouts(stops);
  const features = stops.map((stop) => {
    const feature = new Feature<Point>({
      geometry: new Point(stop.coordinate),
    });
    feature.setId(stop.id);
    feature.set(STOP_PROPERTY_NAME, stop);
    // New viewport data waits for the first coherent rendered-frame declutter
    // pass instead of flashing every dense-city symbol for one frame.
    feature.set(STOP_DECLUTTER_VISIBLE_PROPERTY_NAME, false, true);

    const overlapLayout = overlapLayouts.get(stop.id);

    if (overlapLayout) {
      feature.set(STOP_OVERLAP_LAYOUT_PROPERTY_NAME, overlapLayout);
    }

    return feature;
  });

  display.source.clear();
  display.source.addFeatures(features);
  display.declutterSnapshot = null;

  // A buffered viewport reload can change a close-stop fan-out group. Refresh
  // the halo from the new source feature so it keeps the exact same displacement
  // as the selected symbol instead of retaining stale layout metadata.
  if (display.selectedStopId) {
    const selectedFeature = display.source.getFeatureById(
      display.selectedStopId,
    );
    const selectedStop = selectedFeature
      ? getPublicTransportStopFromFeature(selectedFeature)
      : null;

    if (selectedStop) {
      updatePublicTransportStopSelection(display, selectedStop);
    }
  }
}

/**
 * Changes only the stop that wins decluttering, without drawing a selection
 * halo. The overlap chooser uses this to keep its clicked representative stable
 * until the user resolves the group to one concrete stop.
 */
export function updatePublicTransportStopDeclutterPriority(
  display: PublicTransportStopsDisplay,
  stopId: string | null,
): void {
  display.declutterPriorityStopId = stopId;
  display.declutterSnapshot = null;
}

/**
 * Updates the view rotation used by screen-aligned fan-out styles. Decluttering
 * itself waits for a rendered frame so its coordinate-to-pixel transform matches.
 */
export function updatePublicTransportStopsViewRotation(
  display: PublicTransportStopsDisplay,
  rotation: number,
): void {
  if (display.viewRotation === rotation) {
    return;
  }

  display.viewRotation = rotation;
  display.declutterSnapshot = null;
  display.layer.changed();
  display.selectionLayer.changed();
}

/** Updates the selected-stop halo without changing loaded stop features. */
export function updatePublicTransportStopSelection(
  display: PublicTransportStopsDisplay,
  stop: PublicTransportStop | null,
): void {
  display.selectionSource.clear();
  display.selectedStopId = stop?.id ?? null;
  updatePublicTransportStopDeclutterPriority(display, stop?.id ?? null);

  if (!stop) {
    return;
  }

  const selectionFeature = new Feature<Point>({
    geometry: new Point(stop.coordinate),
  });
  const sourceFeature = display.source.getFeatureById(stop.id);
  const overlapLayout = sourceFeature?.get(
    STOP_OVERLAP_LAYOUT_PROPERTY_NAME,
  ) as unknown;

  if (overlapLayout) {
    selectionFeature.set(STOP_OVERLAP_LAYOUT_PROPERTY_NAME, overlapLayout);
  }

  display.selectionSource.addFeature(selectionFeature);
}

/** Reads structured stop metadata from one feature hit by OpenLayers. */
export function getPublicTransportStopFromFeature(
  feature: FeatureLike,
): PublicTransportStop | null {
  const value = feature.get(STOP_PROPERTY_NAME) as unknown;

  if (!value || typeof value !== 'object') {
    return null;
  }

  const stop = value as Partial<PublicTransportStop>;
  return typeof stop.name === 'string' &&
    Array.isArray(stop.modes) &&
    typeof stop.stationId === 'string'
    ? (stop as PublicTransportStop)
    : null;
}
