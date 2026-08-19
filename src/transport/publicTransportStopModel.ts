/**
 * Business context: converts official public-transport records from GeoAdmin or
 * the static FOT catalog into the small passenger-stop model used by the map and
 * timetable popup. The source also contains operating points and retired
 * facilities, so this module owns the multilingual filtering rules that keep only
 * useful passenger access points for hiking-route planning.
 */
import type { Coordinate } from 'ol/coordinate.js';

/** Technical GeoAdmin identifier for official public-transport stops. */
export const PUBLIC_TRANSPORT_STOPS_LAYER_ID = 'ch.bav.haltestellen-oev';

/**
 * Passenger transport categories accepted by the map overlay.
 *
 * Keeping this list explicit prevents unknown or empty provider values from
 * silently becoming a generic stop category.
 */
export const ACCEPTED_PUBLIC_TRANSPORT_MODES = [
  'train',
  'metro',
  'tram',
  'bus',
  'boat',
  'cableCar',
  'chairlift',
  'funicular',
] as const;

/** Passenger transport category represented in the stop overlay and popup. */
export type PublicTransportMode =
  (typeof ACCEPTED_PUBLIC_TRANSPORT_MODES)[number];

/** Raw stop fields shared by remote identify and static-catalog providers. */
export interface PublicTransportStopInput {
  /** Stable identifier exposed by the source dataset. */
  id: string;
  /** Timetable identifier; defaults to `id` for the FOT GeoAdmin dataset. */
  stationId?: string;
  /** Official stop name. */
  name: string;
  /** Provider description of served passenger transport modes. */
  meansOfTransport?: string | null;
  /** Provider stop type used to reject explicitly retired facilities. */
  stopType?: string | null;
  /** Official LV95 point coordinate. */
  coordinate: Coordinate;
}

/** Passenger stop displayed on the map and in the compact information popup. */
export interface PublicTransportStop {
  /** Stable official feature identifier used by OpenLayers and React. */
  id: string;
  /** Official BAV identifier used by the timetable API. */
  stationId: string;
  /** Official stop name in the selected GeoAdmin language when available. */
  name: string;
  /** Normalized transport categories used for symbols and translated titles. */
  modes: PublicTransportMode[];
  /** Point coordinate in the OpenLayers display projection (EPSG:2056). */
  coordinate: Coordinate;
}

/** GeoJSON point returned by the identify service. */
interface GeoJsonPoint {
  /** GeoJSON geometry discriminator. */
  type: 'Point';
  /** Provider coordinates whose runtime values require validation. */
  coordinates: unknown[];
}

/** Minimal identify feature shape; layer attributes vary by publication. */
interface IdentifyFeature {
  /** Primary identifier used by current GeoAdmin responses. */
  featureId?: string | number;
  /** Fallback identifier exposed by some response variants. */
  id?: string | number;
  /** Technical layer identifier used to reject unrelated records. */
  layerBodId?: string;
  /** Optional point geometry returned when requested. */
  geometry?: GeoJsonPoint;
  /** Optional point-like bounding box used as a geometry fallback. */
  bbox?: unknown[];
  /** Newer property envelope used by some GeoAdmin publications. */
  properties?: Record<string, unknown>;
  /** Legacy attribute envelope used by other publications. */
  attributes?: Record<string, unknown>;
}

/** Primary-mode ordering keeps the most structurally useful symbol visible. */
const MODE_PRIORITY: PublicTransportMode[] = [
  'train',
  'metro',
  'tram',
  'boat',
  'cableCar',
  'chairlift',
  'funicular',
  'bus',
];

/** Normalizes field names and values for multilingual, punctuation-free matching. */
function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Normalizes a technical property key without spaces for candidate matching. */
function normalizeKey(value: string): string {
  return normalizeText(value).replaceAll(' ', '');
}

/** Returns the first non-empty string value matching one technical field key. */
function findStringProperty(
  properties: Record<string, unknown>,
  candidates: string[],
): string | null {
  const normalizedCandidates = candidates.map(normalizeKey);

  for (const [key, value] of Object.entries(properties)) {
    const normalizedPropertyKey = normalizeKey(key);
    const matchesCandidate = normalizedCandidates.some(
      (candidate) =>
        normalizedPropertyKey === candidate ||
        normalizedPropertyKey.startsWith(candidate) ||
        normalizedPropertyKey.endsWith(candidate),
    );

    if (matchesCandidate && typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

/** Extracts a point coordinate from GeoJSON geometry or a point-like bbox. */
function extractCoordinate(feature: IdentifyFeature): Coordinate | null {
  const coordinates = feature.geometry?.coordinates;

  if (
    feature.geometry?.type === 'Point' &&
    Array.isArray(coordinates) &&
    typeof coordinates[0] === 'number' &&
    typeof coordinates[1] === 'number'
  ) {
    return [coordinates[0], coordinates[1]];
  }

  const bbox = feature.bbox;

  if (
    Array.isArray(bbox) &&
    bbox.length >= 4 &&
    bbox.every((value) => typeof value === 'number')
  ) {
    return [
      (Number(bbox[0]) + Number(bbox[2])) / 2,
      (Number(bbox[1]) + Number(bbox[3])) / 2,
    ];
  }

  return null;
}

/**
 * Maps the official multilingual transport description to stable UI modes.
 * Cable systems are checked before generic railway words because names such as
 * `Seilbahn` also contain the German word `Bahn`.
 */
function detectTransportModes(value: string): PublicTransportMode[] {
  const normalized = normalizeText(value);
  const modes = new Set<PublicTransportMode>();
  const isFunicular =
    /standseilbahn|funiculaire|funicolare|funicular/.test(normalized);
  const isChairlift =
    /sesselbahn|sessellift|telesiege|seggiovia|chairlift|chair lift/.test(
      normalized,
    );

  if (isFunicular) {
    modes.add('funicular');
  }

  if (isChairlift) {
    modes.add('chairlift');
  }

  // `Standseilbahn` and `Sesselbahn` both contain the generic word `Seilbahn`.
  // Keeping cable-system categories mutually exclusive prevents funiculars and
  // chairlifts from inheriting the gondola icon through that shared substring.
  if (
    !isFunicular &&
    !isChairlift &&
    /kabinenbahn|gondelbahn|pendelbahn|seilbahn|luftseilbahn|gondel|telepherique|telecabine|funivia|cabinovia|cable car/.test(
      normalized,
    )
  ) {
    modes.add('cableCar');
  }

  if (/schiff|bateau|navire|battello|nave|boat|ship|ferry/.test(normalized)) {
    modes.add('boat');
  }

  if (
    /metro|metropolitain|metropolitana|u bahn|underground|subway/.test(
      normalized,
    )
  ) {
    modes.add('metro');
  }

  if (/tram|strassenbahn|streetcar/.test(normalized)) {
    modes.add('tram');
  }

  if (/bus|autobus|trolleybus|car postal|postauto/.test(normalized)) {
    modes.add('bus');
  }

  if (
    /zug|train|treno|rail|eisenbahn|chemin de fer|ferrovia|zahnrad|cremaillere/.test(
      normalized,
    )
  ) {
    modes.add('train');
  }

  return [...modes];
}

/**
 * Reads only a final parenthesized mode qualifier from an official stop name.
 *
 * A few useful cableway records omit the transport field but retain a suffix
 * such as `(téléphérique)`. Restricting the fallback to that explicit suffix
 * avoids classifying place names such as `Zug Süd` as railway passenger stops.
 */
function detectTransportModesFromNameQualifier(
  name: string,
): PublicTransportMode[] {
  const qualifier = name.match(/\(([^()]*)\)\s*$/)?.[1];
  return qualifier ? detectTransportModes(qualifier) : [];
}

/**
 * Tests one provider stop-type value for an explicit unavailable-state marker.
 * Dictionary-backed catalogs can memoize this result once per distinct value
 * instead of repeating Unicode normalization for every stop record.
 *
 * @param value - Localized provider stop-type description.
 * @returns `true` only when the source explicitly marks the stop unavailable.
 */
export function isPublicTransportStopTypeOutOfService(
  value: string | null | undefined,
): boolean {
  if (!value) {
    return false;
  }

  return /hors service|ausser betrieb|außer betrieb|out of service|fuori servizio|disused/.test(
    normalizeText(value),
  );
}

/**
 * Classifies one provider transport description into normalized passenger modes.
 * Static catalogs intern these descriptions, so callers may compute the result
 * once per dictionary entry and reuse it for all referenced records.
 *
 * @param value - Raw localized means-of-transport description.
 * @returns Stable, deduplicated passenger transport modes derived from metadata.
 */
export function classifyPublicTransportMeansOfTransport(
  value: string | null | undefined,
): PublicTransportMode[] {
  const usableValue = value && value.trim() !== '-' ? value : '';
  return normalizeModes(detectTransportModes(usableValue));
}

/** Returns the stable display priority of one normalized transport mode. */
function getModePriority(mode: PublicTransportMode): number {
  const priority = MODE_PRIORITY.indexOf(mode);
  return priority === -1 ? MODE_PRIORITY.length : priority;
}

/** Sorts and deduplicates accepted passenger transport modes. */
function normalizeModes(
  modes: Iterable<PublicTransportMode>,
): PublicTransportMode[] {
  const uniqueModes = new Set(modes);

  return [...uniqueModes].sort(
    (first, second) => getModePriority(first) - getModePriority(second),
  );
}

/**
 * Returns the primary map symbol for a normalized set of transport modes.
 *
 * @param modes - Accepted modes already associated with one official stop.
 * @returns The highest-priority mode used for the single map pictogram.
 */
export function getPrimaryPublicTransportMode(
  modes: PublicTransportMode[],
): PublicTransportMode {
  return MODE_PRIORITY.find((mode) => modes.includes(mode)) ?? modes[0];
}

/**
 * Normalizes one stop after provider metadata classification has already run.
 *
 * Dictionary-backed sources use this entry point to reuse transport and stop-type
 * classification across thousands of records while keeping name fallback and all
 * passenger filtering rules centralized in this module.
 *
 * @param input - Validated official identifier, name, and LV95 point.
 * @param metadataModes - Modes already classified from provider metadata.
 * @param outOfService - Whether provider metadata explicitly retires this stop.
 * @returns A passenger stop or `null` when the record is retired, technical,
 * unsupported, or otherwise irrelevant to hiking-route planning.
 */
export function normalizePublicTransportStopWithPrecomputedMetadata(
  input: PublicTransportStopInput,
  metadataModes: PublicTransportMode[],
  outOfService: boolean,
): PublicTransportStop | null {
  const { id, stationId = id, name, coordinate } = input;

  if (!name || outOfService) {
    return null;
  }

  // Very close zoom levels and complete source downloads can expose technical
  // operating points named only `01`, `02`, and similar platform identifiers.
  // Passenger stop names always contain at least one letter.
  if (!/\p{L}/u.test(name)) {
    return null;
  }

  const fallbackModes =
    metadataModes.length > 0
      ? metadataModes
      : normalizeModes(detectTransportModesFromNameQualifier(name));

  // The FOT source intentionally includes pure operating points. A record is
  // passenger-relevant only when metadata, or the explicit cableway qualifier
  // fallback above, resolves to one of the accepted transport categories.
  if (fallbackModes.length === 0) {
    return null;
  }

  return {
    id,
    stationId,
    name,
    // Local catalog dictionary entries are shared across many records. Copy the
    // tiny mode array so one stop cannot mutate another stop's presentation data.
    modes: [...fallbackModes],
    coordinate,
  };
}

/**
 * Normalizes source-independent FOT stop fields into the passenger-stop model.
 *
 * @param input - Validated official identifier, name, metadata, and LV95 point.
 * @returns A passenger stop or `null` when the record is retired, technical,
 * unsupported, or otherwise irrelevant to hiking-route planning.
 */
export function normalizePublicTransportStop(
  input: PublicTransportStopInput,
): PublicTransportStop | null {
  return normalizePublicTransportStopWithPrecomputedMetadata(
    input,
    classifyPublicTransportMeansOfTransport(input.meansOfTransport),
    isPublicTransportStopTypeOutOfService(input.stopType),
  );
}

/**
 * Converts one loosely typed identify result into a passenger stop.
 *
 * @param value - One untrusted result from the GeoAdmin identify response.
 * @returns A normalized passenger stop, or `null` for operating-only, retired,
 * numeric-only, unsupported, malformed, or unrelated records.
 */
export function parsePublicTransportStop(
  value: unknown,
): PublicTransportStop | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const feature = value as IdentifyFeature;

  if (feature.layerBodId !== PUBLIC_TRANSPORT_STOPS_LAYER_ID) {
    return null;
  }

  const coordinate = extractCoordinate(feature);
  const featureId = feature.featureId ?? feature.id;

  if (
    !coordinate ||
    (typeof featureId !== 'string' && typeof featureId !== 'number')
  ) {
    return null;
  }

  const properties = {
    ...(feature.attributes ?? {}),
    ...(feature.properties ?? {}),
  };
  const name = findStringProperty(properties, [
    'name',
    'nom',
    'nome',
    'bezeichnung',
    'designation',
    'stopName',
    'haltestellenname',
    'label',
  ]);
  const meansOfTransport = findStringProperty(properties, [
    'verkehrsmittel',
    'meansOfTransport',
    'moyenDeTransport',
    'moyenTransport',
    'mezzoDiTrasporto',
    'transportmittel',
    'transportMode',
    'modeTransport',
  ]);
  const stopType = findStringProperty(properties, [
    'type',
    'typ',
    'art',
    'stopType',
    'haltestellentyp',
  ]);

  if (!name) {
    return null;
  }

  return normalizePublicTransportStop({
    id: String(featureId),
    name,
    meansOfTransport,
    stopType,
    coordinate,
  });
}
