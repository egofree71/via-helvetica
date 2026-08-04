/**
 * Business context: turns recorded GPX geometry into deterministic synthetic
 * waypoint clicks for comparing Via Helvetica routing policies. The simulator
 * must reproduce the same input sequence for both engines so cell loading,
 * fallback behaviour, and routed geometry can be compared fairly.
 */
import type { Coordinate } from 'ol/coordinate.js';

/** Supported waypoint-spacing strategies for one simulator scenario. */
export type WaypointSamplingConfiguration =
  | {
      /** Uses a fixed LV95 distance between successive synthetic clicks. */
      mode: 'regular-distance';
      /** Fixed spacing in metres. */
      intervalMetres: number;
    }
  | {
      /** Divides the complete GPX distance into equal percentage steps. */
      mode: 'regular-percentage';
      /** Percentage of total GPX distance between successive clicks. */
      intervalPercent: number;
    }
  | {
      /** Uses deterministic pseudo-random spacing around one mean distance. */
      mode: 'irregular-distance';
      /** Mean spacing in metres before seeded variation is applied. */
      meanIntervalMetres: number;
      /** Symmetric variation ratio from 0 to 0.95. */
      variationRatio: number;
      /** Integer seed that makes the generated sequence reproducible. */
      seed: number;
    };

/** One projected GPX segment prepared for simulator sampling. */
export interface SimulatorSourceSegment {
  /** Display label derived from the GPX name and segment index. */
  name: string;
  /** Ordered EPSG:2056 coordinates from the uploaded GPX segment. */
  coordinates: Coordinate[];
}

/** Synthetic waypoint sequence generated from one projected GPX segment. */
export interface SimulatorWaypointSequence {
  /** Source segment label shown in result tables and exports. */
  name: string;
  /** Total length of the source GPX segment in metres. */
  sourceDistanceMetres: number;
  /** Ordered synthetic clicks, always including source start and end. */
  waypoints: Coordinate[];
  /** Human-readable deterministic scenario label. */
  scenarioLabel: string;
}

/** Euclidean distance between two LV95 coordinates in metres. */
export function coordinateDistance(
  start: Coordinate,
  end: Coordinate,
): number {
  return Math.hypot(end[0] - start[0], end[1] - start[1]);
}

/** Returns the total horizontal length of an ordered LV95 polyline. */
export function polylineDistance(coordinates: readonly Coordinate[]): number {
  let distance = 0;

  for (let index = 1; index < coordinates.length; index += 1) {
    distance += coordinateDistance(coordinates[index - 1], coordinates[index]);
  }

  return distance;
}

/**
 * Mulberry32 provides a small deterministic generator for repeatable waypoint
 * spacing. Cryptographic randomness would make performance regressions hard to
 * reproduce and provides no benefit for this developer-only workload.
 */
function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Maximum floating-point gap treated as the exact final waypoint. */
const ENDPOINT_DISTANCE_TOLERANCE_METRES = 0.01;

/** Builds monotonically increasing target distances ending exactly at total. */
function waypointDistances(
  totalDistanceMetres: number,
  configuration: WaypointSamplingConfiguration,
): number[] {
  if (!Number.isFinite(totalDistanceMetres) || totalDistanceMetres <= 0) {
    return [0];
  }

  const distances = [0];
  let currentDistance = 0;

  if (configuration.mode === 'regular-percentage') {
    if (
      !Number.isFinite(configuration.intervalPercent) ||
      configuration.intervalPercent <= 0 ||
      configuration.intervalPercent > 100
    ) {
      throw new Error('Percentage interval must be greater than 0 and at most 100.');
    }

    const intervalMetres =
      totalDistanceMetres * (configuration.intervalPercent / 100);

    while (currentDistance + intervalMetres < totalDistanceMetres) {
      currentDistance += intervalMetres;
      distances.push(currentDistance);
    }
  } else if (configuration.mode === 'regular-distance') {
    if (
      !Number.isFinite(configuration.intervalMetres) ||
      configuration.intervalMetres <= 0
    ) {
      throw new Error('Distance interval must be greater than 0 metres.');
    }

    while (
      currentDistance + configuration.intervalMetres <
      totalDistanceMetres
    ) {
      currentDistance += configuration.intervalMetres;
      distances.push(currentDistance);
    }
  } else {
    if (
      !Number.isFinite(configuration.meanIntervalMetres) ||
      configuration.meanIntervalMetres <= 0
    ) {
      throw new Error('Irregular mean interval must be greater than 0 metres.');
    }
    if (
      !Number.isFinite(configuration.variationRatio) ||
      configuration.variationRatio < 0 ||
      configuration.variationRatio > 0.95
    ) {
      throw new Error('Irregular variation must be between 0% and 95%.');
    }

    const random = createSeededRandom(configuration.seed);
    const minimumStep = Math.max(
      10,
      configuration.meanIntervalMetres *
        (1 - configuration.variationRatio),
    );

    while (currentDistance + minimumStep < totalDistanceMetres) {
      const centeredRandom = random() * 2 - 1;
      const intervalMetres = Math.max(
        10,
        configuration.meanIntervalMetres *
          (1 + centeredRandom * configuration.variationRatio),
      );

      if (currentDistance + intervalMetres >= totalDistanceMetres) {
        break;
      }

      currentDistance += intervalMetres;
      distances.push(currentDistance);
    }
  }

  const lastDistance = distances.at(-1)!;
  if (
    distances.length > 1 &&
    totalDistanceMetres - lastDistance <= ENDPOINT_DISTANCE_TOLERANCE_METRES
  ) {
    distances[distances.length - 1] = totalDistanceMetres;
  } else {
    distances.push(totalDistanceMetres);
  }

  return distances;
}

/** Interpolates ordered coordinates at precomputed cumulative distances. */
function interpolatePolyline(
  coordinates: readonly Coordinate[],
  targetDistances: readonly number[],
): Coordinate[] {
  const result: Coordinate[] = [];
  let segmentIndex = 1;
  let traversedDistance = 0;

  for (const targetDistance of targetDistances) {
    while (segmentIndex < coordinates.length) {
      const start = coordinates[segmentIndex - 1];
      const end = coordinates[segmentIndex];
      const segmentDistance = coordinateDistance(start, end);

      if (
        targetDistance <= traversedDistance + segmentDistance ||
        segmentIndex === coordinates.length - 1
      ) {
        const fraction =
          segmentDistance > 0
            ? Math.min(
                1,
                Math.max(
                  0,
                  (targetDistance - traversedDistance) / segmentDistance,
                ),
              )
            : 0;
        result.push([
          start[0] + (end[0] - start[0]) * fraction,
          start[1] + (end[1] - start[1]) * fraction,
        ]);
        break;
      }

      traversedDistance += segmentDistance;
      segmentIndex += 1;
    }
  }

  return result;
}

/** Returns a concise stable description for one sampling configuration. */
export function samplingConfigurationLabel(
  configuration: WaypointSamplingConfiguration,
): string {
  if (configuration.mode === 'regular-distance') {
    return `regular ${configuration.intervalMetres.toFixed(0)} m`;
  }

  if (configuration.mode === 'regular-percentage') {
    return `regular ${configuration.intervalPercent.toFixed(2)}%`;
  }

  return (
    `irregular ${configuration.meanIntervalMetres.toFixed(0)} m ` +
    `±${(configuration.variationRatio * 100).toFixed(0)}% seed ${configuration.seed}`
  );
}

/** Creates a stable download basename from the GPX files represented in a run. */
export function routingSimulationExportBaseName(
  sourceFilenames: readonly string[],
): string {
  const uniqueFilenames = [...new Set(sourceFilenames)];
  const firstFilename = uniqueFilenames[0] ?? 'gpx';
  const firstStem = firstFilename.replace(/\.gpx$/i, '');
  const safeStem =
    firstStem
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'gpx';
  const additionalFileCount = uniqueFilenames.length - 1;
  const sourceSuffix =
    additionalFileCount > 0
      ? `${safeStem}-plus-${additionalFileCount}-gpx`
      : safeStem;

  return `via-helvetica-routing-simulation-${sourceSuffix}`;
}

/**
 * Samples one complete GPX segment into synthetic waypoint clicks.
 * @param source - Projected source segment with at least two coordinates.
 * @param configuration - Deterministic spacing strategy.
 * @returns Sequence including the exact source start and end.
 */
export function createSimulatorWaypointSequence(
  source: SimulatorSourceSegment,
  configuration: WaypointSamplingConfiguration,
): SimulatorWaypointSequence {
  if (source.coordinates.length < 2) {
    throw new Error('Simulator source segment requires at least two coordinates.');
  }

  const sourceDistanceMetres = polylineDistance(source.coordinates);
  const distances = waypointDistances(sourceDistanceMetres, configuration);
  const waypoints = interpolatePolyline(source.coordinates, distances);

  // Preserve the exact endpoints rather than their floating-point interpolation
  // so repeated runs compare the same first and final click byte for byte.
  waypoints[0] = [...source.coordinates[0]];
  waypoints[waypoints.length - 1] = [
    ...source.coordinates[source.coordinates.length - 1],
  ];

  return {
    name: source.name,
    sourceDistanceMetres,
    waypoints,
    scenarioLabel: samplingConfigurationLabel(configuration),
  };
}
