/**
 * Business context: exposes the Swiss Armed Forces' published shooting notices
 * and danger zones as an optional planning-safety overlay. The WMS source keeps
 * the official portrayal, while GeoAdmin identify and HTML-popup services
 * provide localized operational details for a clicked polygon.
 */
import type { Coordinate } from 'ol/coordinate.js';
import type { Extent } from 'ol/extent.js';
import Feature from 'ol/Feature.js';
import GeoJSON, { type GeoJSONGeometry } from 'ol/format/GeoJSON.js';
import type Geometry from 'ol/geom/Geometry.js';
import VectorLayer from 'ol/layer/Vector.js';
import TileWMS from 'ol/source/TileWMS.js';
import VectorSource from 'ol/source/Vector.js';
import Fill from 'ol/style/Fill.js';
import Stroke from 'ol/style/Stroke.js';
import Style from 'ol/style/Style.js';
import type { Language } from '../i18n/translations';
import { sanitizeGeoAdminPopupHtml } from '../map/geoAdminPopup';
import { MAP_PROJECTION_CODE } from '../map/projection';

/** Technical GeoAdmin identifier for published shooting notices and danger zones. */
export const SHOOTING_DANGER_ZONES_LAYER_ID = 'ch.vbs.schiessanzeigen';

/** GeoAdmin identify endpoint used to find a danger zone near a map click. */
const IDENTIFY_ENDPOINT =
  'https://api3.geo.admin.ch/rest/services/ech/MapServer/identify';

/** GeoAdmin map service that renders the official military danger-zone style. */
const WMS_ENDPOINT = 'https://wms.geo.admin.ch/';

/** Small pixel radius that keeps polygon edges practical to select. */
const IDENTIFY_TOLERANCE_PIXELS = 5;

/** Browser display resolution sent to GeoAdmin for scale-aware identification. */
const IDENTIFY_DPI = 96;

/** Attribution displayed with the official Swiss Armed Forces dataset. */
const SHOOTING_DANGER_ZONES_ATTRIBUTION = '© Schweizer Armee';

/** Minimal identify result needed to request the official HTML popup. */
interface IdentifyFeature {
  /** Current feature identifier understood by the HTML-popup endpoint. */
  featureId: string | number;
  /** Technical layer identifier returned by GeoAdmin. */
  layerBodId: string;
  /** Optional GeoJSON polygon requested for client-side selection highlighting. */
  geometry?: unknown;
}

/** JSON envelope returned by the GeoAdmin identify service. */
interface IdentifyResponse {
  /** Features intersecting the click tolerance. */
  results?: unknown[];
}

/** Map context required for a scale-aware identify request. */
export interface ShootingDangerZoneIdentifyContext {
  /** Click coordinate in the OpenLayers display projection (EPSG:2056). */
  coordinate: Coordinate;
  /** Current visible map extent in EPSG:2056. */
  mapExtent: Extent;
  /** Current map canvas width and height in CSS pixels. */
  imageSize: [number, number];
  /** Language requested for layer metadata and popup content. */
  language: Language;
}

/** Identified danger zone and the map context reused by the popup request. */
export interface IdentifiedShootingDangerZone {
  /** Feature identifier in the official shooting-notice layer. */
  featureId: string | number;
  /** Official polygon geometry used only to highlight the selected zone. */
  geometry: Geometry | null;
  /** Click context required by scale-dependent popup templates. */
  context: ShootingDangerZoneIdentifyContext;
}

/** OpenLayers resources used to emphasize the currently selected danger zone. */
export interface ShootingDangerZoneSelectionDisplay {
  /** Vector layer drawn above the official WMS portrayal. */
  layer: VectorLayer<VectorSource<Feature<Geometry>>>;
  /** Mutable source containing at most one selected polygon. */
  source: VectorSource<Feature<Geometry>>;
}

/** Tests the small subset of identify fields required by this module. */
function isIdentifyFeature(value: unknown): value is IdentifyFeature {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const feature = value as Partial<IdentifyFeature>;
  return (
    (typeof feature.featureId === 'string' ||
      typeof feature.featureId === 'number') &&
    feature.layerBodId === SHOOTING_DANGER_ZONES_LAYER_ID
  );
}

/** GeoJSON reader configured for geometries already returned in EPSG:2056. */
const geoJsonReader = new GeoJSON({
  dataProjection: MAP_PROJECTION_CODE,
  featureProjection: MAP_PROJECTION_CODE,
});

/** Pale selection fill and orange outline inspired by the federal map viewer. */
const SHOOTING_DANGER_ZONE_SELECTION_STYLE = new Style({
  fill: new Fill({ color: 'rgba(255, 244, 194, 0.76)' }),
  stroke: new Stroke({ color: '#f47a1f', width: 3 }),
});

/** Accepts only area geometries relevant to the shooting-danger publication. */
function isDangerZoneGeoJsonGeometry(
  value: unknown,
): value is GeoJSONGeometry {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const geometry = value as {
    type?: unknown;
    coordinates?: unknown;
  };

  return (
    (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') &&
    Array.isArray(geometry.coordinates)
  );
}

/** Converts one returned GeoJSON polygon without failing the metadata popup. */
function readDangerZoneGeometry(value: unknown): Geometry | null {
  if (!isDangerZoneGeoJsonGeometry(value)) {
    return null;
  }

  try {
    return geoJsonReader.readGeometry(value);
  } catch {
    return null;
  }
}

/** Compact or already formatted 24-hour values around a shooting-time dash. */
const SHOOTING_TIME_RANGE_PATTERN =
  /\b((?:[01]\d|2[0-3])(?::?[0-5]\d)|24(?::?00))(\s*[-–—]\s*)((?:[01]\d|2[0-3])(?::?[0-5]\d)|24(?::?00))\b/g;

/** Adds the conventional separator only when GeoAdmin supplies compact `HHMM`. */
function formatShootingTime(value: string): string {
  return value.includes(':') ? value : `${value.slice(0, 2)}:${value.slice(2)}`;
}

/**
 * Normalizes time ranges inside one official shooting-notice row.
 * Restricting the transformation to rows carrying a PDF notice avoids treating
 * unrelated numeric ranges elsewhere in the popup as hours.
 */
function normalizeShootingTimeRanges(root: Element): void {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let textNode = walker.nextNode();

  // Collect first so rewriting text cannot disturb TreeWalker traversal.
  while (textNode) {
    textNodes.push(textNode as Text);
    textNode = walker.nextNode();
  }

  for (const node of textNodes) {
    const value = node.textContent ?? '';
    const normalized = value.replace(
      SHOOTING_TIME_RANGE_PATTERN,
      (_match, from: string, separator: string, to: string) =>
        `${formatShootingTime(from)}${separator}${formatShootingTime(to)}`,
    );

    if (normalized !== value) {
      node.textContent = normalized;
    }
  }
}

/** Tests whether one sanitized popup anchor is a PDF notice link. */
function isPdfLink(anchor: HTMLAnchorElement): boolean {
  const href = anchor.getAttribute('href') ?? '';
  const label = anchor.textContent?.trim().toLowerCase() ?? '';
  return /\.pdf(?:$|[?#])/i.test(href) || label === 'pdf';
}

/**
 * Removes PDF download links while preserving the corresponding shooting dates
 * and the rest of the official metadata. Compact shooting hours are normalized
 * only in rows that carry an official PDF notice, keeping the transformation
 * away from unrelated numeric ranges elsewhere in the popup.
 */
function removePdfLinks(html: string): string {
  const documentNode = new DOMParser().parseFromString(html, 'text/html');
  const shootingNoticeRows = new Set<Element>();

  for (const anchor of Array.from(documentNode.querySelectorAll('a'))) {
    if (!(anchor instanceof HTMLAnchorElement) || !isPdfLink(anchor)) {
      continue;
    }

    const row = anchor.closest('tr');
    if (row) {
      shootingNoticeRows.add(row);
    }

    const tableCell = anchor.closest('td, th');
    anchor.remove();

    if (
      tableCell &&
      !tableCell.textContent?.trim() &&
      tableCell.children.length === 0
    ) {
      tableCell.remove();
    }
  }

  for (const row of shootingNoticeRows) {
    normalizeShootingTimeRanges(row);
  }

  for (const row of Array.from(documentNode.querySelectorAll('tr'))) {
    if (!row.textContent?.trim() && row.children.length === 0) {
      row.remove();
    }
  }

  return documentNode.body.innerHTML.trim();
}

/**
 * Creates the official transparent WMS overlay with server-side styling.
 * @returns TileWMS source for an OpenLayers layer placed below closures.
 */
export function createShootingDangerZonesSource(): TileWMS {
  return new TileWMS({
    url: WMS_ENDPOINT,
    params: {
      LAYERS: SHOOTING_DANGER_ZONES_LAYER_ID,
      FORMAT: 'image/png',
      TRANSPARENT: true,
      TILED: true,
    },
    attributions: SHOOTING_DANGER_ZONES_ATTRIBUTION,
    crossOrigin: 'anonymous',
    projection: MAP_PROJECTION_CODE,
    wrapX: false,
  });
}

/** Creates the client-side overlay used for one selected danger-zone polygon. */
export function createShootingDangerZoneSelectionDisplay(): ShootingDangerZoneSelectionDisplay {
  const source = new VectorSource<Feature<Geometry>>();
  const layer = new VectorLayer({
    source,
    style: SHOOTING_DANGER_ZONE_SELECTION_STYLE,
  });

  return { layer, source };
}

/** Replaces or clears the selected danger-zone polygon. */
export function updateShootingDangerZoneSelection(
  display: ShootingDangerZoneSelectionDisplay,
  dangerZone: IdentifiedShootingDangerZone | null,
): void {
  display.source.clear();

  if (!dangerZone?.geometry) {
    return;
  }

  display.source.addFeature(
    new Feature<Geometry>({
      geometry: dangerZone.geometry.clone(),
    }),
  );
}

/**
 * Finds the first published military danger zone at a map click.
 *
 * @param context - Current click, map extent, canvas size, and language.
 * @param signal - Abort signal for superseded clicks or layer deactivation.
 * @returns Identified feature, or `null` when the click hits no danger zone.
 * @throws {Error} When GeoAdmin returns an unsuccessful or malformed response.
 */
export async function identifyShootingDangerZone(
  context: ShootingDangerZoneIdentifyContext,
  signal: AbortSignal,
): Promise<IdentifiedShootingDangerZone | null> {
  const parameters = new URLSearchParams({
    geometry: `${context.coordinate[0]},${context.coordinate[1]}`,
    geometryType: 'esriGeometryPoint',
    layers: `all:${SHOOTING_DANGER_ZONES_LAYER_ID}`,
    tolerance: String(IDENTIFY_TOLERANCE_PIXELS),
    mapExtent: context.mapExtent.join(','),
    imageDisplay: `${Math.round(context.imageSize[0])},${Math.round(context.imageSize[1])},${IDENTIFY_DPI}`,
    returnGeometry: 'true',
    geometryFormat: 'geojson',
    sr: '2056',
    lang: context.language,
    limit: '5',
  });
  const response = await fetch(`${IDENTIFY_ENDPOINT}?${parameters}`, {
    signal,
  });

  if (!response.ok) {
    throw new Error(
      `Shooting danger-zone identify failed with ${response.status}.`,
    );
  }

  const payload = (await response.json()) as IdentifyResponse;
  const feature = payload.results?.find(isIdentifyFeature);

  if (!feature) {
    return null;
  }

  return {
    featureId: feature.featureId,
    geometry: readDangerZoneGeometry(feature.geometry),
    context,
  };
}

/**
 * Loads localized official metadata for one danger zone, removes PDF download
 * links, and normalizes compact shooting-hour ranges for readability.
 *
 * @param dangerZone - Feature and map context returned by identification.
 * @param signal - Abort signal for superseded clicks or panel closure.
 * @returns Safe HTML with the operational dates and principal metadata.
 * @throws {Error} When the popup endpoint fails or returns no usable content.
 */
export async function fetchShootingDangerZonePopup(
  dangerZone: IdentifiedShootingDangerZone,
  signal: AbortSignal,
): Promise<string> {
  const { context } = dangerZone;
  const parameters = new URLSearchParams({
    lang: context.language,
    sr: '2056',
    mapExtent: context.mapExtent.join(','),
    imageDisplay: `${Math.round(context.imageSize[0])},${Math.round(context.imageSize[1])},${IDENTIFY_DPI}`,
    coord: `${context.coordinate[0]},${context.coordinate[1]}`,
  });
  const featureId = encodeURIComponent(String(dangerZone.featureId));
  const endpoint = `https://api3.geo.admin.ch/rest/services/ech/MapServer/${SHOOTING_DANGER_ZONES_LAYER_ID}/${featureId}/htmlPopup?${parameters}`;
  const response = await fetch(endpoint, { signal });

  if (!response.ok) {
    throw new Error(
      `Shooting danger-zone popup failed with ${response.status}.`,
    );
  }

  const sanitizedHtml = sanitizeGeoAdminPopupHtml(await response.text());
  const compactHtml = removePdfLinks(sanitizedHtml);

  if (!compactHtml) {
    throw new Error('Shooting danger-zone popup returned no usable content.');
  }

  return compactHtml;
}
