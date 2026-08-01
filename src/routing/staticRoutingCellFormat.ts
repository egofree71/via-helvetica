/**
 * Business context: defines and validates the compact geometry-cell contract
 * shared by the offline binary generator and validation tests. Keeping this
 * module free of browser and OpenLayers dependencies prevents preprocessing and
 * parity checks from accepting different coordinates, attributes, or hiking flags.
 */
import type {
  PrecomputedSourceLineFeature,
  RoutingCoordinate,
} from './precomputedRoutingGraph.js';

/** Current compact geometry-cell format generated from swissTLM3D. */
export const STATIC_ROUTING_FORMAT_VERSION = 2;
/** Stable format identifier written in the corresponding manifest. */
export const STATIC_ROUTING_FORMAT = 'via-helvetica-static-routing-cells';

/** Compact road object stored in one generated JSON cell. */
export interface StaticRoadPayload {
  /** Stable swissTLM3D UUID. */
  i?: unknown;
  /** One or more 2D/3D line strings. */
  l?: unknown;
  /** Numeric road attributes in object type, restriction, surface, importance order. */
  a?: unknown;
  /** Value `1` when the source road carries the official hiking designation. */
  h?: unknown;
}

/** Compact top-level static-cell payload. */
export interface StaticCellPayload {
  /** File-format version. */
  v?: unknown;
  /** Routing-grid key represented by this file. */
  k?: unknown;
  /** Exact cell extent in LV95. */
  e?: unknown;
  /** Road features intersecting the cell. */
  r?: unknown;
}

/** Validated compact geometry-cell contents. */
export interface StaticRoutingCellData {
  /** Exact LV95 extent declared by the cell. */
  extent: [number, number, number, number];
  /** Normalized source roads accepted by the shared graph compiler. */
  roads: PrecomputedSourceLineFeature[];
}

/** Validates a finite four-number extent. */
export function readStaticRoutingExtent(
  value: unknown,
): [number, number, number, number] | null {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    value.some((member) => typeof member !== 'number' || !Number.isFinite(member))
  ) {
    return null;
  }

  return [value[0], value[1], value[2], value[3]];
}

/** Validates one source coordinate and preserves an optional finite elevation. */
function readCoordinate(value: unknown): RoutingCoordinate | null {
  if (!Array.isArray(value) || value.length < 2) {
    return null;
  }

  const [x, y, z] = value;

  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    !Number.isFinite(x) ||
    !Number.isFinite(y)
  ) {
    return null;
  }

  return typeof z === 'number' && Number.isFinite(z) ? [x, y, z] : [x, y];
}

/**
 * Splits a source line at invalid coordinates instead of joining the vertices
 * on either side into a synthetic shortcut that does not exist in swissTLM3D.
 */
function splitValidLine(value: unknown): RoutingCoordinate[][] {
  if (!Array.isArray(value)) {
    return [];
  }

  const lines: RoutingCoordinate[][] = [];
  let currentLine: RoutingCoordinate[] = [];

  const flush = () => {
    if (currentLine.length >= 2) {
      lines.push(currentLine);
    }
    currentLine = [];
  };

  for (const member of value) {
    const coordinate = readCoordinate(member);

    if (!coordinate) {
      flush();
      continue;
    }

    currentLine.push(coordinate);
  }

  flush();
  return lines;
}

/** Validates nested line geometry and preserves deliberate source gaps. */
function readLines(value: unknown): RoutingCoordinate[][] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap(splitValidLine);
}

/** Reads one optional finite numeric attribute from the compact attribute array. */
function readAttribute(values: unknown[], index: number): number | undefined {
  const value = values[index];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Converts one compact road payload into the shared compiler contract. */
export function readStaticRoutingRoad(
  value: unknown,
): PrecomputedSourceLineFeature | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const payload = value as StaticRoadPayload;
  const id = typeof payload.i === 'string' && payload.i.length > 0 ? payload.i : null;
  const lines = readLines(payload.l);

  if (!id || lines.length === 0) {
    return null;
  }

  const values = Array.isArray(payload.a) ? payload.a : [];

  return {
    id,
    lines,
    attributes: {
      objectType: readAttribute(values, 0),
      restriction: readAttribute(values, 1),
      surface: readAttribute(values, 2),
      importance: readAttribute(values, 3),
    },
    // The 2026 national GeoPackage's Wanderweg field matched the separate
    // hiking package exactly in the validated geometry extraction.
    isHikingTrail: payload.h === 1,
  };
}

/**
 * Validates one compact geometry cell.
 * @param payload - Untrusted parsed JSON payload.
 * @param expectedKey - Routing-grid key requested by the Worker or generator.
 * @returns Validated extent and normalized roads.
 * @throws {Error} When the cell contract is malformed or belongs to another key.
 */
export function readStaticRoutingCell(
  payload: StaticCellPayload,
  expectedKey: string,
): StaticRoutingCellData {
  const extent = readStaticRoutingExtent(payload.e);

  if (
    payload.v !== STATIC_ROUTING_FORMAT_VERSION ||
    payload.k !== expectedKey ||
    !extent ||
    !Array.isArray(payload.r)
  ) {
    throw new Error(`Static routing cell ${expectedKey} is invalid.`);
  }

  const roads = payload.r
    .map(readStaticRoutingRoad)
    .filter((road): road is PrecomputedSourceLineFeature => road !== null);

  if (roads.length !== payload.r.length) {
    throw new Error(`Static routing cell ${expectedKey} has invalid roads.`);
  }

  return { extent, roads };
}
