/**
 * Business context: recognizes coordinates pasted into the compact map search
 * without contacting GeoAdmin. Via Helvetica accepts the two coordinate forms
 * commonly exchanged by Swiss hiking tools: decimal WGS 84 and Swiss LV95.
 * It also recognizes strong markers in unfinished coordinate input so the UI
 * can avoid futile place-provider requests while the user is still typing.
 * Valid results are normalized to the existing WGS 84 search-result contract,
 * while map-extent validation happens locally before the result reaches React.
 */
import { containsCoordinate } from 'ol/extent.js';
import {
  isWgs84CoordinateInsideMapBounds,
  MAP_EXTENT,
} from '../map/config';
import { toWgs84 } from '../map/projection';
import type {
  CoordinateSearchOrigin,
  LocationSearchResult,
} from './locationSearch';

/** Maximum absolute WGS 84 latitude in decimal degrees. */
const MAXIMUM_WGS84_LATITUDE = 90;
/** Maximum absolute WGS 84 longitude in decimal degrees. */
const MAXIMUM_WGS84_LONGITUDE = 180;
/**
 * Maximum absolute longitude in decimal degrees used by the fallback for
 * longitude-first input outside the map extent. Raising it makes ambiguous
 * pairs more likely to be reversed; lowering it rejects more valid European
 * longitude-first coordinates.
 */
const LONGITUDE_FIRST_MAXIMUM_LONGITUDE = 20;
/**
 * Minimum absolute latitude in decimal degrees used by the same fallback.
 * Lowering it broadens longitude-first detection beyond the Swiss context;
 * raising it rejects more valid coordinates from nearby European regions.
 */
const LONGITUDE_FIRST_MINIMUM_LATITUDE = 35;
/**
 * Broad LV95 easting range in metres used only to recognize the Swiss CRS.
 * The navigable map extent remains the stricter final acceptance boundary.
 */
const LV95_EASTING_RANGE = [2_000_000, 3_000_000] as const;
/** Broad LV95 northing range in metres used to distinguish axis order. */
const LV95_NORTHING_RANGE = [900_000, 1_500_000] as const;
/** Maximum decimal places retained when displaying WGS 84 input. */
const WGS84_DISPLAY_DECIMALS = 6;
/** Maximum sub-metre decimal places retained when displaying LV95 input. */
const LV95_DISPLAY_DECIMALS = 3;

/**
 * Characters accepted while a supported coordinate pair is still being typed.
 * Letters deliberately fall through to GeoAdmin so postal addresses and place
 * names containing numbers keep their normal search behaviour.
 */
const COORDINATE_DRAFT_CHARACTERS =
  /^[0-9+\-.,; '\u2019\u02bc\u00a0\u202f]*$/;
/**
 * Largest unsigned integer that can still plausibly be a Swiss postal code.
 * Larger standalone values are treated as unfinished projected coordinates and
 * kept away from the place provider until a complete pair can be parsed.
 */
const MAXIMUM_POSTAL_CODE_VALUE = 9_999;

/** Result returned when the complete input is or is not a coordinate pair. */
export type CoordinateSearchParseResult =
  | {
      /** The text is not a supported complete coordinate pair. */
      kind: 'not-coordinate';
    }
  | {
      /** The text is a valid coordinate pair outside the map's Swiss extent. */
      kind: 'outside-map';
    }
  | {
      /** The locally normalized result can be selected like a place result. */
      kind: 'result';
      /** Search option containing a canonical label and WGS 84 coordinate. */
      result: LocationSearchResult;
    };

/** Two finite values extracted from one complete numeric input. */
interface NumericPair {
  /** First value as entered, before coordinate-order interpretation. */
  first: number;
  /** Second value as entered, before coordinate-order interpretation. */
  second: number;
}

/** Resolved WGS 84 latitude and longitude in decimal degrees. */
interface Wgs84Coordinate {
  /** Latitude in decimal degrees. */
  latitude: number;
  /** Longitude in decimal degrees. */
  longitude: number;
}

/** Resolved LV95 easting and northing in metres. */
interface Lv95Coordinate {
  /** Easting in metres. */
  easting: number;
  /** Northing in metres. */
  northing: number;
}

function isWithin(value: number, range: readonly [number, number]): boolean {
  return value >= range[0] && value <= range[1];
}

function isValidLatitude(value: number): boolean {
  return Math.abs(value) <= MAXIMUM_WGS84_LATITUDE;
}

function isValidLongitude(value: number): boolean {
  return Math.abs(value) <= MAXIMUM_WGS84_LONGITUDE;
}

/**
 * Parses one number token while accepting Swiss thousands apostrophes and,
 * only for semicolon-separated input, a European decimal comma.
 * @param token - One side of the candidate coordinate pair.
 * @param allowDecimalComma - Whether a comma may represent the decimal mark.
 * @returns A finite number, or null when the complete token is not numeric.
 */
function parseNumberToken(
  token: string,
  allowDecimalComma: boolean,
): number | null {
  const normalizedWhitespace = token
    .trim()
    .replace(/[\u00a0\u202f]/g, ' ');

  if (!normalizedWhitespace) {
    return null;
  }

  const groupedNumberPattern =
    /^[+-]?\d{1,3}(?:[ '\u2019\u02bc]\d{3})+(?:[.,]\d+)?$/;
  const plainNumberPattern = allowDecimalComma
    ? /^[+-]?\d+(?:[.,]\d+)?$/
    : /^[+-]?\d+(?:\.\d+)?$/;

  if (
    !groupedNumberPattern.test(normalizedWhitespace) &&
    !plainNumberPattern.test(normalizedWhitespace)
  ) {
    return null;
  }

  const withoutGrouping = normalizedWhitespace.replace(
    /[ '\u2019\u02bc]/g,
    '',
  );
  const decimalNormalized = allowDecimalComma
    ? withoutGrouping.replace(',', '.')
    : withoutGrouping;
  const value = Number(decimalNormalized);

  return Number.isFinite(value) ? value : null;
}

function createPair(
  firstToken: string,
  secondToken: string,
  allowDecimalComma: boolean,
): NumericPair | null {
  const first = parseNumberToken(firstToken, allowDecimalComma);
  const second = parseNumberToken(secondToken, allowDecimalComma);

  if (first === null || second === null) {
    return null;
  }

  return { first, second };
}

/**
 * Extracts exactly two numeric values from the supported separators. Strict
 * whole-string matching prevents postal-code searches such as "1204 Genève"
 * from being mistaken for coordinates.
 * @param searchText - Complete trimmed text from the search field.
 * @returns Two numbers, or null when the text contains anything else.
 */
function extractNumericPair(searchText: string): NumericPair | null {
  const normalizedText = searchText
    .trim()
    .replace(/[\u00a0\u202f]/g, ' ');

  const semicolonParts = normalizedText.split(';');

  if (semicolonParts.length === 2) {
    return createPair(semicolonParts[0], semicolonParts[1], true);
  }

  const commaParts = normalizedText.split(',');

  if (commaParts.length === 2) {
    return createPair(commaParts[0], commaParts[1], false);
  }

  const whitespaceParts = normalizedText.split(/\s+/);

  if (whitespaceParts.length === 2) {
    return createPair(whitespaceParts[0], whitespaceParts[1], false);
  }

  // Six integer groups unambiguously represent two Swiss seven-digit values,
  // for example "2 671 804 1 204 459" copied without a comma separator.
  if (
    whitespaceParts.length === 6 &&
    whitespaceParts.every((part) => /^\d{1,3}$/.test(part)) &&
    whitespaceParts[1].length === 3 &&
    whitespaceParts[2].length === 3 &&
    whitespaceParts[4].length === 3 &&
    whitespaceParts[5].length === 3
  ) {
    return createPair(
      whitespaceParts.slice(0, 3).join(''),
      whitespaceParts.slice(3).join(''),
      false,
    );
  }

  return null;
}

function isWgs84InsideMap(coordinate: Wgs84Coordinate): boolean {
  return isWgs84CoordinateInsideMapBounds([
    coordinate.longitude,
    coordinate.latitude,
  ]);
}

/**
 * Resolves the latitude/longitude order. A coordinate inside the Swiss map
 * extent wins first; for outside coordinates, the conventional latitude-first
 * order is retained unless broad European bounds strongly indicate
 * longitude-first input.
 * @param pair - Two finite values whose axis order is not yet known.
 * @returns The resolved latitude and longitude, or null when neither order is
 * valid WGS 84.
 */
function resolveWgs84Coordinate(pair: NumericPair): Wgs84Coordinate | null {
  const direct =
    isValidLatitude(pair.first) && isValidLongitude(pair.second)
      ? { latitude: pair.first, longitude: pair.second }
      : null;
  const reversed =
    isValidLatitude(pair.second) && isValidLongitude(pair.first)
      ? { latitude: pair.second, longitude: pair.first }
      : null;

  if (!direct && !reversed) {
    return null;
  }

  const directInsideMap = direct ? isWgs84InsideMap(direct) : false;
  const reversedInsideMap = reversed ? isWgs84InsideMap(reversed) : false;

  if (directInsideMap !== reversedInsideMap) {
    return directInsideMap ? direct : reversed;
  }

  // When neither order is inside the map extent, these broad European
  // bounds preserve common longitude-latitude input without reversing ordinary
  // latitude-longitude pairs by default.
  if (
    reversed &&
    Math.abs(pair.first) <= LONGITUDE_FIRST_MAXIMUM_LONGITUDE &&
    Math.abs(pair.second) >= LONGITUDE_FIRST_MINIMUM_LATITUDE
  ) {
    return reversed;
  }

  return direct ?? reversed;
}

function isLv95InsideMap(coordinate: Lv95Coordinate): boolean {
  return containsCoordinate(MAP_EXTENT, [
    coordinate.easting,
    coordinate.northing,
  ]);
}

/**
 * Resolves official LV95 easting/northing order. Their non-overlapping Swiss
 * numeric ranges make a reversed pair safely detectable without guessing.
 * @param pair - Two finite values whose LV95 axis order is not yet known.
 * @returns The resolved easting and northing, or null when neither order fits
 * the broad LV95 recognition ranges.
 */
function resolveLv95Coordinate(pair: NumericPair): Lv95Coordinate | null {
  const direct =
    isWithin(pair.first, LV95_EASTING_RANGE) &&
    isWithin(pair.second, LV95_NORTHING_RANGE)
      ? { easting: pair.first, northing: pair.second }
      : null;
  const reversed =
    isWithin(pair.second, LV95_EASTING_RANGE) &&
    isWithin(pair.first, LV95_NORTHING_RANGE)
      ? { easting: pair.second, northing: pair.first }
      : null;

  if (!direct && !reversed) {
    return null;
  }

  const directInsideMap = direct ? isLv95InsideMap(direct) : false;
  const reversedInsideMap = reversed ? isLv95InsideMap(reversed) : false;

  if (directInsideMap !== reversedInsideMap) {
    return directInsideMap ? direct : reversed;
  }

  return direct ?? reversed;
}

function formatDecimal(value: number, maximumDecimals: number): string {
  return value
    .toFixed(maximumDecimals)
    .replace(/\.0+$/, '')
    .replace(/(\.\d*?)0+$/, '$1');
}

function formatLv95Value(value: number): string {
  const decimalText = formatDecimal(value, LV95_DISPLAY_DECIMALS);
  const [integerPart, fractionalPart] = decimalText.split('.');
  const groupedInteger = integerPart.replace(
    /\B(?=(\d{3})+(?!\d))/g,
    "'",
  );

  return fractionalPart
    ? `${groupedInteger}.${fractionalPart}`
    : groupedInteger;
}

function createCoordinateResult(
  origin: CoordinateSearchOrigin,
  label: string,
  coordinate: Wgs84Coordinate,
): LocationSearchResult {
  return {
    id: `coordinate:${origin}:${coordinate.latitude}:${coordinate.longitude}`,
    label,
    origin,
    latitude: coordinate.latitude,
    longitude: coordinate.longitude,
  };
}

/**
 * Recognizes decimal WGS 84 or LV95 input without issuing a provider request.
 * Supported separators are comma, semicolon, or whitespace. Semicolons also
 * allow European decimal commas, and LV95 values may contain Swiss thousands
 * apostrophes or spaces.
 * @param searchText - Complete user-entered search value.
 * @returns A local result, an outside-map outcome, or not-coordinate.
 */
export function parseCoordinateSearch(
  searchText: string,
): CoordinateSearchParseResult {
  const pair = extractNumericPair(searchText);

  if (!pair) {
    return { kind: 'not-coordinate' };
  }

  const lv95Coordinate = resolveLv95Coordinate(pair);

  if (lv95Coordinate) {
    if (!isLv95InsideMap(lv95Coordinate)) {
      return { kind: 'outside-map' };
    }

    const [longitude, latitude] = toWgs84([
      lv95Coordinate.easting,
      lv95Coordinate.northing,
    ]);

    return {
      kind: 'result',
      result: createCoordinateResult(
        'lv95',
        `${formatLv95Value(lv95Coordinate.easting)}, ${formatLv95Value(
          lv95Coordinate.northing,
        )}`,
        { latitude, longitude },
      ),
    };
  }

  const wgs84Coordinate = resolveWgs84Coordinate(pair);

  if (!wgs84Coordinate) {
    return { kind: 'not-coordinate' };
  }

  if (!isWgs84InsideMap(wgs84Coordinate)) {
    return { kind: 'outside-map' };
  }

  return {
    kind: 'result',
    result: createCoordinateResult(
      'wgs84',
      `${formatDecimal(
        wgs84Coordinate.latitude,
        WGS84_DISPLAY_DECIMALS,
      )}, ${formatDecimal(
        wgs84Coordinate.longitude,
        WGS84_DISPLAY_DECIMALS,
      )}`,
      wgs84Coordinate,
    ),
  };
}

/**
 * Detects an unfinished coordinate-like value before it becomes a complete
 * supported pair. Strong numeric markers suppress futile GeoAdmin requests,
 * while ordinary four-digit postal codes and text remain provider searches.
 *
 * @param searchText - Current, possibly incomplete value from the search field.
 * @returns True when the input should remain local until coordinate parsing can
 * either produce a complete result or the user changes it into a place query.
 */
export function isCoordinateSearchDraft(searchText: string): boolean {
  const normalizedText = searchText
    .trim()
    .replace(/[\u00a0\u202f]/g, ' ');

  if (
    !normalizedText ||
    !COORDINATE_DRAFT_CHARACTERS.test(normalizedText)
  ) {
    return false;
  }

  if (parseCoordinateSearch(normalizedText).kind !== 'not-coordinate') {
    return false;
  }

  // Swiss grouping apostrophes and semicolons are coordinate-specific enough
  // to avoid sending every intermediate mobile keystroke to SearchServer.
  if (/[;'\u2019\u02bc]/.test(normalizedText)) {
    return true;
  }

  // A decimal point or explicit sign strongly indicates a geographic number;
  // plain unsigned four-digit input must remain available for postal codes.
  if (/[.+-]/.test(normalizedText)) {
    return true;
  }

  const tokens = normalizedText
    .split(/[,\s]+/)
    .filter(Boolean);

  if (normalizedText.includes(',')) {
    return true;
  }

  const numericValues = tokens.map((token) => Number(token));

  if (
    numericValues.some((value) => !Number.isFinite(value))
  ) {
    return false;
  }

  if (
    numericValues.some(
      (value) => Math.abs(value) > MAXIMUM_POSTAL_CODE_VALUE,
    )
  ) {
    return true;
  }

  // Space-grouped Swiss coordinates often pass through partial states such as
  // "2 671 804 1 20". Repeated three-digit groups are distinctive, whereas
  // two independent four-digit values may still be ordinary place searches.
  const whitespaceTokens = normalizedText.split(/\s+/);

  return (
    whitespaceTokens.length >= 2 &&
    /^\d{1,3}$/.test(whitespaceTokens[0]) &&
    whitespaceTokens
      .slice(1)
      .every((token) => /^\d{1,3}$/.test(token)) &&
    whitespaceTokens.some((token) => token.length === 3)
  );
}

