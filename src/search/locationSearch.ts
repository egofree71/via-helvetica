/**
 * Business context: defines the small place-or-coordinate result contract and
 * adapts official GeoAdmin SearchServer places to it. Repeated text searches are
 * cached for the browser session so common typing and deletion cycles do not
 * issue the same provider request again.
 */
import type { Language } from '../i18n/translations';

const SEARCH_ENDPOINT =
  'https://api3.geo.admin.ch/rest/services/ech/SearchServer';

/** Maximum results displayed by the compact search panel. */
const RESULT_LIMIT = 8;
/**
 * Maximum exact searches retained for the browser session. The small LRU bound
 * prevents an unusually long session from growing memory without limit while
 * preserving the recent queries most likely to be revisited.
 */
const SEARCH_CACHE_LIMIT = 64;
const SEARCH_ORIGINS = ['zipcode', 'gg25', 'gazetteer'] as const;

/** GeoAdmin origin used to translate provider categories in the interface. */
export type SearchOrigin = (typeof SEARCH_ORIGINS)[number];

/** Locally recognized coordinate system shown beneath a coordinate result. */
export type CoordinateSearchOrigin = 'wgs84' | 'lv95';

/** Category shared by provider-backed places and local coordinate results. */
export type LocationSearchOrigin = SearchOrigin | CoordinateSearchOrigin;

/** Loose top-level contract returned by the GeoAdmin SearchServer endpoint. */
interface SearchServerResponse {
  /** Candidate locations; absent results are treated as an empty response. */
  results?: SearchServerItem[];
}

/** Untrusted provider item validated before it enters the typed UI contract. */
interface SearchServerItem {
  /** Provider identifier, normalized to a string when retained. */
  id?: string | number;
  /** Search attributes may be missing or have unexpected runtime types. */
  attrs?: {
    /** Provider label, potentially containing simple emphasis markup. */
    label?: unknown;
    /** WGS84 latitude supplied by SearchServer. */
    lat?: unknown;
    /** WGS84 longitude supplied by SearchServer. */
    lon?: unknown;
    /** Language-neutral search-origin identifier. */
    origin?: unknown;
  };
}

/** Normalized location result returned to the React component. */
export interface LocationSearchResult {
  /** Stable identifier built from provider or normalized coordinate data. */
  id: string;
  /** Plain-text display label safe to render directly through React. */
  label: string;
  /** Language-neutral place or coordinate category translated by the UI. */
  origin: LocationSearchOrigin;
  /** Validated WGS84 latitude in decimal degrees. */
  latitude: number;
  /** Validated WGS84 longitude in decimal degrees. */
  longitude: number;
}

const locationSearchCache = new Map<string, LocationSearchResult[]>();

function isSearchOrigin(value: string): value is SearchOrigin {
  return SEARCH_ORIGINS.includes(value as SearchOrigin);
}

/**
 * Reads an untrusted provider coordinate without accepting JavaScript's
 * surprising empty-string, null, or boolean coercions as numeric zero.
 * @param value - Runtime value returned by SearchServer.
 * @returns A finite number, or null when the value is absent or invalid.
 */
function readFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Removes provider-only italic classification while preserving visible text,
 * emphasis content, and decoded HTML entities as safe plain text.
 * @param value - SearchServer label with optional simple HTML markup.
 * @param parser - Parser reused for every item in the same provider response.
 * @returns Normalized plain text, or an empty string for an invalid label.
 */
function normalizeLabel(value: unknown, parser: DOMParser): string {
  if (typeof value !== 'string') {
    return '';
  }

  const document = parser.parseFromString(value, 'text/html');

  document.querySelectorAll('i').forEach((element) => {
    element.remove();
  });

  return (document.body.textContent ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Builds the exact session-cache key. Unicode normalization makes visually
 * identical composed and decomposed accents share an entry, while the language
 * remains part of the key because SearchServer localizes returned labels.
 */
function createLocationSearchCacheKey(
  searchText: string,
  language: Language,
): string {
  const normalizedText = searchText
    .trim()
    .normalize('NFC')
    .toLocaleLowerCase(language);

  return `${language}:${normalizedText}`;
}

function cloneLocationSearchResults(
  results: LocationSearchResult[],
): LocationSearchResult[] {
  return results.map((result) => ({ ...result }));
}

/**
 * Returns an exact successful search cached for the current browser session.
 * Reading an entry promotes it so the bounded cache keeps recently reused
 * queries rather than merely the most recently created ones.
 * @param searchText - User-entered place text.
 * @param language - Language used for localized provider labels.
 * @returns A defensive result copy, or null when no exact entry is cached.
 */
export function getCachedLocationSearch(
  searchText: string,
  language: Language,
): LocationSearchResult[] | null {
  const cacheKey = createLocationSearchCacheKey(searchText, language);
  const cachedResults = locationSearchCache.get(cacheKey);

  if (cachedResults === undefined) {
    return null;
  }

  locationSearchCache.delete(cacheKey);
  locationSearchCache.set(cacheKey, cachedResults);

  return cloneLocationSearchResults(cachedResults);
}

function cacheLocationSearchResults(
  searchText: string,
  language: Language,
  results: LocationSearchResult[],
): void {
  const cacheKey = createLocationSearchCacheKey(searchText, language);

  locationSearchCache.delete(cacheKey);
  locationSearchCache.set(
    cacheKey,
    cloneLocationSearchResults(results),
  );

  while (locationSearchCache.size > SEARCH_CACHE_LIMIT) {
    const oldestKey = locationSearchCache.keys().next().value;

    if (oldestKey === undefined) {
      break;
    }

    locationSearchCache.delete(oldestKey);
  }
}

/** Clears the session cache, primarily for deterministic regression tests. */
export function clearLocationSearchCache(): void {
  locationSearchCache.clear();
}

/**
 * Searches official Swiss place indexes in the selected interface language.
 * Exact successful responses, including empty result lists, are retained in a
 * bounded session cache. Errors and in-flight promises are deliberately not
 * cached so each request keeps its own cancellation lifecycle.
 * @param searchText - User-entered place text.
 * @param language - Language passed to GeoAdmin for returned labels.
 * @param signal - Abort signal owned by the debounced React effect.
 * @returns Valid, deduplicated locations in provider order.
 * @throws {Error} If SearchServer returns a non-successful HTTP response.
 */
export async function searchLocations(
  searchText: string,
  language: Language,
  signal: AbortSignal,
): Promise<LocationSearchResult[]> {
  const cachedResults = getCachedLocationSearch(searchText, language);

  if (cachedResults !== null) {
    return cachedResults;
  }

  const parameters = new URLSearchParams({
    searchText,
    type: 'locations',
    origins: SEARCH_ORIGINS.join(','),
    lang: language,
    limit: String(RESULT_LIMIT),
  });

  const response = await fetch(`${SEARCH_ENDPOINT}?${parameters}`, {
    signal,
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(
      `SearchServer returned HTTP ${response.status}.`,
    );
  }

  const payload = (await response.json()) as SearchServerResponse;
  const uniqueResults = new Map<string, LocationSearchResult>();
  const labelParser = new DOMParser();

  for (const item of payload.results ?? []) {
    const attrs = item.attrs;
    const latitude = readFiniteNumber(attrs?.lat);
    const longitude = readFiniteNumber(attrs?.lon);
    const label = normalizeLabel(attrs?.label, labelParser);
    const origin =
      typeof attrs?.origin === 'string' ? attrs.origin : '';

    if (
      latitude === null ||
      longitude === null ||
      !label ||
      !isSearchOrigin(origin)
    ) {
      continue;
    }

    const duplicateKey =
      `${label.toLocaleLowerCase(language)}:${latitude}:${longitude}`;

    if (uniqueResults.has(duplicateKey)) {
      continue;
    }

    uniqueResults.set(duplicateKey, {
      id: `${origin}:${String(item.id ?? duplicateKey)}`,
      label,
      origin,
      latitude,
      longitude,
    });
  }

  const results = Array.from(uniqueResults.values()).slice(
    0,
    RESULT_LIMIT,
  );

  cacheLocationSearchResults(searchText, language, results);

  return cloneLocationSearchResults(results);
}
