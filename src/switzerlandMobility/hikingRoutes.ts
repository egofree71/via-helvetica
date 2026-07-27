/**
 * Business context: exposes the public GeoAdmin feature metadata behind the
 * raster “Hiking SwitzerlandMobility” portrayal. The WMTS tiles remain the
 * authoritative overview, while these focused identify and feature requests let
 * Via Helvetica name, select, and measure one clicked route without depending on
 * SwitzerlandMobility's private editorial pages.
 */
import type { Coordinate } from 'ol/coordinate.js';
import type { Extent } from 'ol/extent.js';
import type { Language } from '../i18n/translations';

/** Technical GeoAdmin identifier for SwitzerlandMobility hiking routes. */
export const SWITZERLAND_MOBILITY_HIKING_LAYER_ID = 'ch.astra.wanderland';

/** GeoAdmin endpoint used to identify route features around a map click. */
const IDENTIFY_ENDPOINT =
  'https://api3.geo.admin.ch/rest/services/ech/MapServer/identify';

/** Base endpoint used to retrieve the complete geometry of one selected route. */
const FEATURE_ENDPOINT =
  'https://api3.geo.admin.ch/rest/services/ech/MapServer';

/** Pixel radius around a click; thick green routes remain practical to select. */
const IDENTIFY_TOLERANCE_PIXELS = 8;

/** Browser display resolution sent to GeoAdmin for scale-aware identification. */
const IDENTIFY_DPI = 96;

/** Maximum candidates retained when several routes share the same path. */
const IDENTIFY_RESULT_LIMIT = 20;

/**
 * Endpoint tolerance in metres for joining provider line parts. Small coordinate
 * rounding differences should not trigger one elevation request per road piece,
 * while genuine gaps must remain independent and contribute no invented distance.
 */
const GEOMETRY_JOIN_TOLERANCE_METERS = 2;

/** Public metadata and normalized labels for one selectable route candidate. */
export interface SwitzerlandMobilityHikingRouteCandidate {
  /** GeoAdmin feature identifier used to retrieve the complete geometry. */
  featureId: string | number;
  /** SwitzerlandMobility route number, for example `4` for ViaJacobi. */
  routeNumber: string | null;
  /** Public route or stage identifier, for example `4.16`. */
  routeId: string | null;
  /** Localized route name without the parenthesized stage endpoints. */
  routeName: string | null;
  /** Localized stage endpoints or subtitle extracted from the public title. */
  sectionName: string | null;
  /** Stage number derived from the route identifier when stages are published. */
  stageNumber: string | null;
  /** Whether the public metadata says that the route is split into stages. */
  hasStages: boolean;
}

/** Complete public geometry and metadata for one selected hiking route. */
export interface SwitzerlandMobilityHikingRoute
  extends SwitzerlandMobilityHikingRouteCandidate {
  /** Independent EPSG:2056 line segments, without invented links between gaps. */
  segments: Coordinate[][];
}

/** Map state required by GeoAdmin to convert a pixel tolerance into metres. */
export interface SwitzerlandMobilityHikingIdentifyContext {
  /** Click coordinate in the OpenLayers display projection (EPSG:2056). */
  coordinate: Coordinate;
  /** Current visible map extent in EPSG:2056. */
  mapExtent: Extent;
  /** Current map canvas width and height in CSS pixels. */
  imageSize: [number, number];
  /** Language requested for public route titles. */
  language: Language;
}

/** Untrusted identify envelope returned by GeoAdmin. */
interface IdentifyResponse {
  /** Features intersecting the click tolerance. */
  results?: unknown[];
}

/** Untrusted single-feature envelope returned by GeoAdmin. */
interface FeatureResponse {
  /** Feature returned when one identifier is requested. */
  feature?: unknown;
  /** Defensive support for collection-shaped responses. */
  features?: unknown[];
}

/** Localized title split into its route name and parenthesized section. */
export interface SwitzerlandMobilityHikingTitleParts {
  /** Route name before the final parenthesized section. */
  routeName: string | null;
  /** Text inside the final parentheses, usually stage endpoints. */
  sectionName: string | null;
}

/** Returns a trimmed external string or `null` for empty and non-string values. */
function readString(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }

  const text = String(value).trim();
  return text ? text : null;
}

/** Accepts common boolean encodings used by geodata databases and JSON APIs. */
function readBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  if (typeof value === 'string') {
    return ['1', 'true', 'yes', 'ja', 'oui', 'si'].includes(
      value.trim().toLowerCase(),
    );
  }

  return false;
}

/** Reads feature attributes from either identify or get-feature response shapes. */
function readAttributes(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const feature = value as {
    properties?: unknown;
    attributes?: unknown;
  };
  const attributes = feature.properties ?? feature.attributes;

  return attributes && typeof attributes === 'object'
    ? (attributes as Record<string, unknown>)
    : {};
}

/** Reads the stable feature identifier needed by the get-feature endpoint. */
function readFeatureId(value: unknown): string | number | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const feature = value as {
    featureId?: unknown;
    id?: unknown;
    layerBodId?: unknown;
  };

  if (
    feature.layerBodId !== undefined &&
    feature.layerBodId !== SWITZERLAND_MOBILITY_HIKING_LAYER_ID
  ) {
    return null;
  }

  const featureId = feature.featureId ?? feature.id;

  return typeof featureId === 'string' || typeof featureId === 'number'
    ? featureId
    : null;
}

/**
 * Splits the public title's final parenthesized suffix without assuming a
 * language-specific separator between the two endpoint names.
 *
 * @param title - Localized `chmobil_title` value.
 * @returns Route name and optional section text.
 */
export function splitSwitzerlandMobilityHikingTitle(
  title: string | null,
): SwitzerlandMobilityHikingTitleParts {
  if (!title) {
    return { routeName: null, sectionName: null };
  }

  const match = title.match(/^(.+?)\s*\(([^()]*)\)\s*$/);

  if (!match) {
    return { routeName: title, sectionName: null };
  }

  const routeName = match[1].trim();
  const sectionName = match[2].trim();

  return {
    routeName: routeName || null,
    sectionName: sectionName || null,
  };
}

/** Derives a human stage number such as `16` from a route id such as `4.16`. */
function deriveStageNumber(
  routeId: string | null,
  routeNumber: string | null,
  hasStages: boolean,
): string | null {
  if (!hasStages || !routeId || routeId === routeNumber) {
    return null;
  }

  const identifierParts = routeId.split('.');

  // Stage identifiers published by GeoAdmin follow `<route>.<stage>`. Requiring
  // that shape prevents an unrelated database id from becoming a fake stage.
  if (identifierParts.length < 2) {
    return null;
  }

  const identifierRouteNumber = identifierParts[0]?.trim();
  const rawStage = identifierParts[identifierParts.length - 1]?.trim();

  if (routeNumber && identifierRouteNumber !== routeNumber) {
    return null;
  }

  if (!rawStage) {
    return null;
  }

  const numericStage = Number(rawStage);
  return Number.isFinite(numericStage) ? String(numericStage) : rawStage;
}

/** Converts one untrusted API feature into the public route candidate model. */
function readCandidate(
  value: unknown,
): SwitzerlandMobilityHikingRouteCandidate | null {
  const featureId = readFeatureId(value);

  if (featureId === null) {
    return null;
  }

  const attributes = readAttributes(value);
  const routeNumber = readString(attributes.chmobil_route_number);
  const topLevelId =
    value && typeof value === 'object'
      ? readString((value as { id?: unknown }).id)
      : null;
  // GeoAdmin identify responses expose the public stage id at the feature level,
  // while some feature endpoints also duplicate it inside the attributes.
  const routeId = readString(attributes.id) ?? topLevelId;
  const hasStages = readBoolean(attributes.chmobil_has_segment);
  const title = readString(attributes.chmobil_title);
  const { routeName, sectionName } = splitSwitzerlandMobilityHikingTitle(title);

  return {
    featureId,
    routeNumber,
    routeId,
    routeName,
    sectionName,
    stageNumber: deriveStageNumber(routeId, routeNumber, hasStages),
    hasStages,
  };
}

/** Produces one stable semantic key to remove duplicate underlying table hits. */
function candidateKey(
  candidate: SwitzerlandMobilityHikingRouteCandidate,
): string {
  const semanticParts = [
    candidate.routeId ?? '',
    candidate.routeNumber ?? '',
    candidate.routeName ?? '',
    candidate.sectionName ?? '',
  ];

  // Missing provider labels must not collapse unrelated features into one
  // anonymous choice merely because all normalized metadata fields are empty.
  return semanticParts.some(Boolean)
    ? semanticParts.join('|')
    : `feature:${candidate.featureId}`;
}

/** Tests and copies one finite 2D coordinate from untrusted GeoJSON. */
function readCoordinate(value: unknown): Coordinate | null {
  if (!Array.isArray(value) || value.length < 2) {
    return null;
  }

  const easting = Number(value[0]);
  const northing = Number(value[1]);

  return Number.isFinite(easting) && Number.isFinite(northing)
    ? [easting, northing]
    : null;
}

/** Converts one untrusted coordinate array into a usable line segment. */
function readLineString(value: unknown): Coordinate[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const coordinates = value
    .map(readCoordinate)
    .filter((coordinate): coordinate is Coordinate => coordinate !== null);

  return coordinates.length >= 2 ? coordinates : null;
}

/**
 * Reads line geometry from GeoJSON while preserving independent parts. Geometry
 * collections are supported defensively because provider storage can evolve
 * without changing the conceptual hiking-route contract.
 *
 * @param value - Untrusted GeoJSON geometry or feature value.
 * @returns Usable line parts in their provider order; malformed parts are omitted.
 */
function readGeometrySegments(value: unknown): Coordinate[][] {
  if (!value || typeof value !== 'object') {
    return [];
  }

  const geometry = value as {
    type?: unknown;
    coordinates?: unknown;
    geometries?: unknown;
    geometry?: unknown;
  };

  if (geometry.type === 'Feature') {
    return readGeometrySegments(geometry.geometry);
  }

  if (geometry.type === 'LineString') {
    const segment = readLineString(geometry.coordinates);
    return segment ? [segment] : [];
  }

  if (
    geometry.type === 'MultiLineString' &&
    Array.isArray(geometry.coordinates)
  ) {
    return geometry.coordinates
      .map(readLineString)
      .filter((segment): segment is Coordinate[] => segment !== null);
  }

  if (
    geometry.type === 'GeometryCollection' &&
    Array.isArray(geometry.geometries)
  ) {
    return geometry.geometries.flatMap(readGeometrySegments);
  }

  return [];
}

/** Returns whether two LV95 endpoints represent the same route junction. */
function endpointsMatch(first: Coordinate, second: Coordinate): boolean {
  const eastingDifference = first[0] - second[0];
  const northingDifference = first[1] - second[1];

  return (
    eastingDifference * eastingDifference +
      northingDifference * northingDifference <=
    GEOMETRY_JOIN_TOLERANCE_METERS * GEOMETRY_JOIN_TOLERANCE_METERS
  );
}

/**
 * Joins contiguous provider line parts before elevation profiling. Route tables
 * can split one stage at many road boundaries and may reverse individual parts;
 * preserving those splits would multiply network requests without adding
 * planning information. Disconnected parts remain separate.
 *
 * @param segments - Provider line parts in EPSG:2056, in arbitrary direction.
 * @returns Contiguous chains with genuine geographic gaps still separated.
 */
function stitchLineSegments(segments: Coordinate[][]): Coordinate[][] {
  const remaining = segments.map((segment) =>
    segment.map((coordinate): Coordinate => [coordinate[0], coordinate[1]]),
  );
  const stitchedSegments: Coordinate[][] = [];

  while (remaining.length > 0) {
    let chain = remaining.shift() ?? [];
    let extended = true;

    while (extended && chain.length >= 2) {
      extended = false;
      const chainStart = chain[0];
      const chainEnd = chain[chain.length - 1];

      for (let index = 0; index < remaining.length; index += 1) {
        const candidate = remaining[index];
        const candidateStart = candidate[0];
        const candidateEnd = candidate[candidate.length - 1];

        if (endpointsMatch(chainEnd, candidateStart)) {
          chain = chain.concat(candidate.slice(1));
        } else if (endpointsMatch(chainEnd, candidateEnd)) {
          chain = chain.concat([...candidate].reverse().slice(1));
        } else if (endpointsMatch(chainStart, candidateEnd)) {
          chain = candidate.slice(0, -1).concat(chain);
        } else if (endpointsMatch(chainStart, candidateStart)) {
          chain = [...candidate].reverse().slice(0, -1).concat(chain);
        } else {
          continue;
        }

        remaining.splice(index, 1);
        extended = true;
        break;
      }
    }

    if (chain.length >= 2) {
      stitchedSegments.push(chain);
    }
  }

  return stitchedSegments;
}

/** Finds the feature object inside the supported single-feature response shapes. */
function readFeatureEnvelope(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const response = payload as FeatureResponse;

  if (response.feature) {
    return response.feature;
  }

  if (Array.isArray(response.features)) {
    return response.features[0] ?? null;
  }

  return payload;
}

/**
 * Finds the public hiking routes intersecting one map click.
 *
 * A whole-route record is hidden only when a stage of that same numbered route
 * is also returned. This avoids duplicate choices such as ViaJacobi plus one of
 * its stages without discarding an unrelated local route that has no stages.
 *
 * @param context - Click coordinate, map extent, canvas size, and language.
 * @param signal - Abort signal for superseded clicks or panel closure.
 * @returns Deduplicated route candidates, possibly empty.
 * @throws {Error} When GeoAdmin returns an unsuccessful or malformed response.
 */
export async function identifySwitzerlandMobilityHikingRoutes(
  context: SwitzerlandMobilityHikingIdentifyContext,
  signal: AbortSignal,
): Promise<SwitzerlandMobilityHikingRouteCandidate[]> {
  const parameters = new URLSearchParams({
    geometry: `${context.coordinate[0]},${context.coordinate[1]}`,
    geometryType: 'esriGeometryPoint',
    geometryFormat: 'geojson',
    layers: `all:${SWITZERLAND_MOBILITY_HIKING_LAYER_ID}`,
    tolerance: String(IDENTIFY_TOLERANCE_PIXELS),
    mapExtent: context.mapExtent.join(','),
    imageDisplay: [
      Math.round(context.imageSize[0]),
      Math.round(context.imageSize[1]),
      IDENTIFY_DPI,
    ].join(','),
    returnGeometry: 'false',
    sr: '2056',
    lang: context.language,
    limit: String(IDENTIFY_RESULT_LIMIT),
  });
  const response = await fetch(`${IDENTIFY_ENDPOINT}?${parameters}`, {
    signal,
  });

  if (!response.ok) {
    throw new Error(
      `SwitzerlandMobility hiking identify failed with ${response.status}.`,
    );
  }

  const payload = (await response.json()) as IdentifyResponse;

  if (payload.results !== undefined && !Array.isArray(payload.results)) {
    throw new Error('SwitzerlandMobility identify response is malformed.');
  }

  const uniqueCandidates = new Map<
    string,
    SwitzerlandMobilityHikingRouteCandidate
  >();

  for (const result of payload.results ?? []) {
    const candidate = readCandidate(result);

    if (candidate) {
      uniqueCandidates.set(candidateKey(candidate), candidate);
    }
  }

  const candidates = Array.from(uniqueCandidates.values());
  const stagedRouteNumbers = new Set(
    candidates
      .filter((candidate) => candidate.stageNumber !== null)
      .map((candidate) => candidate.routeNumber)
      .filter((routeNumber): routeNumber is string => routeNumber !== null),
  );

  // GeoAdmin can return both a whole-route record and the clicked stage. Only
  // suppress that duplicate for the same route number; other unsegmented local
  // routes sharing the path remain valid choices for the user.
  return candidates.filter(
    (candidate) =>
      candidate.stageNumber !== null ||
      candidate.routeNumber === null ||
      !stagedRouteNumbers.has(candidate.routeNumber),
  );
}

/**
 * Retrieves complete EPSG:2056 geometry and refreshed localized metadata for one
 * candidate selected directly or from the overlap chooser.
 *
 * @param candidate - Route candidate returned by the identify service.
 * @param language - Current interface language for localized public attributes.
 * @param signal - Abort signal for panel closure or a newer selection.
 * @returns Complete public route geometry and normalized metadata.
 * @throws {Error} When the feature response or its line geometry is unusable.
 */
export async function fetchSwitzerlandMobilityHikingRoute(
  candidate: SwitzerlandMobilityHikingRouteCandidate,
  language: Language,
  signal: AbortSignal,
): Promise<SwitzerlandMobilityHikingRoute> {
  const featureId = encodeURIComponent(String(candidate.featureId));
  const parameters = new URLSearchParams({
    geometryFormat: 'geojson',
    returnGeometry: 'true',
    sr: '2056',
    lang: language,
  });
  const response = await fetch(
    `${FEATURE_ENDPOINT}/${SWITZERLAND_MOBILITY_HIKING_LAYER_ID}/${featureId}?${parameters}`,
    { signal },
  );

  if (!response.ok) {
    throw new Error(
      `SwitzerlandMobility hiking feature failed with ${response.status}.`,
    );
  }

  const feature = readFeatureEnvelope(await response.json());
  const refreshedCandidate = readCandidate(feature) ?? candidate;
  const geometry =
    feature && typeof feature === 'object'
      ? (feature as { geometry?: unknown }).geometry
      : null;
  const segments = stitchLineSegments(readGeometrySegments(geometry));

  if (segments.length === 0) {
    throw new Error(
      'SwitzerlandMobility route contains no usable line geometry.',
    );
  }

  return {
    ...refreshedCandidate,
    featureId: candidate.featureId,
    segments,
  };
}
