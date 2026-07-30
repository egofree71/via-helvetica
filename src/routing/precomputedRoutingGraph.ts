/**
 * Business context: compiles normalized swissTLM3D roads into a portable
 * pedestrian graph before browser routing begins. The same pure compiler is
 * used by `RoutingNetwork.fromSwissTlm()` and by the offline Geneva generator,
 * so walkability, hiking preference, 3D node identity, and duplicate-edge
 * policy cannot drift between live and precomputed data sources.
 */

/** Plain 2D or 3D coordinate in the routing projection (EPSG:2056). */
export type RoutingCoordinate = number[];

/** Road attributes consumed by the pedestrian cost model. */
export interface PrecomputedSourceRoadAttributes {
  /** swissTLM3D object-type code describing road/path width and role. */
  objectType?: number;
  /** Traffic-restriction code used for pedestrian access and prohibitions. */
  restriction?: number;
  /** Surface code used only as a small route-preference adjustment. */
  surface?: number;
  /** Network-importance code used to penalize major roads. */
  importance?: number;
}

/** Normalized source line accepted by the shared graph compiler. */
export interface PrecomputedSourceLineFeature {
  /** Stable source identifier retained for source-level deduplication upstream. */
  id: string;
  /** One or more validated line strings, preserving elevation when supplied. */
  lines: RoutingCoordinate[][];
  /** Normalized attributes used by the pedestrian cost model. */
  attributes: PrecomputedSourceRoadAttributes;
  /** Direct hiking classification when already known from the source package. */
  isHikingTrail?: boolean;
}

/** Source data required to compile one graph fragment. */
export interface PrecomputedSourceNetworkData {
  /** Road and path features that may become graph segments. */
  roads: PrecomputedSourceLineFeature[];
  /** Optional hiking geometries used when roads are not preclassified. */
  hikingTrails: PrecomputedSourceLineFeature[];
}

/** Globally mergeable node emitted by the shared compiler. */
export interface PrecomputedRoutingNode {
  /** Quantized 3D identity shared by neighbouring routing cells. */
  key: string;
  /** Original source coordinate retained for snapping and route geometry. */
  coordinate: RoutingCoordinate;
}

/** Globally mergeable bidirectional segment emitted by the shared compiler. */
export interface PrecomputedRoutingSegment {
  /** Global key of the first endpoint. */
  startNodeKey: string;
  /** Global key of the second endpoint. */
  endNodeKey: string;
  /** Weighted traversal cost in metre-equivalent units. */
  cost: number;
  /** Whether the official hiking designation influenced this segment. */
  isHikingTrail: boolean;
}

/** Portable graph fragment stored in one precomputed routing cell. */
export interface PrecomputedRoutingGraphData {
  /** Globally keyed nodes referenced by the fragment's segments. */
  nodes: PrecomputedRoutingNode[];
  /** Walkable bidirectional segments with final routing cost already applied. */
  segments: PrecomputedRoutingSegment[];
  /** Number of source road features compiled before segment expansion. */
  sourceRoadFeatures: number;
  /** Number of separate hiking-overlay features used during compilation. */
  sourceHikingFeatures: number;
}

/**
 * Horizontal precision in metres used to merge near-identical vertices.
 * Lowering it preserves more source detail but increases graph size.
 */
const NODE_HORIZONTAL_PRECISION_METRES = 0.5;
/**
 * Vertical precision in metres included in node identity. It keeps a bridge or
 * tunnel disconnected from a road that only crosses it in plan view.
 */
const NODE_VERTICAL_PRECISION_METRES = 2;
/**
 * Maximum road-to-hiking distance in metres for geometric enrichment when the
 * road source does not already carry a hiking classification.
 */
const HIKING_MATCH_DISTANCE_METRES = 8;
/**
 * Dimensionless lower bound for every finite routing factor. A* uses the same
 * value so its straight-line heuristic remains admissible.
 */
export const MIN_ROUTING_COST_FACTOR = 0.45;
/**
 * Defensive upper bound for every finite routing factor emitted by the current
 * pedestrian cost model. Binary-cell validation uses this value to reject
 * corrupted or stale costs before they enter A*.
 */
export const MAX_ROUTING_COST_FACTOR = 4.5;
/**
 * Spatial-index bucket width in metres. Larger buckets reduce index overhead
 * but increase exact candidate comparisons during hiking matching.
 */
const COMPILER_SPATIAL_GRID_SIZE_METRES = 250;
/**
 * Minimum retained segment length in metres. Smaller source pieces are treated
 * as geometric noise and do not become graph edges.
 */
const MIN_SOURCE_SEGMENT_LENGTH_METRES = 0.1;
/** Minimum absolute cosine similarity for two segments to count as parallel. */
const MIN_DIRECTION_COSINE = 0.7;
/** Interior fractions sampled when matching roads with hiking geometry. */
const HIKING_SAMPLE_FRACTIONS = [0.25, 0.5, 0.75] as const;

/** swissTLM3D object-type codes that must never enter the pedestrian graph. */
const NON_WALKABLE_OBJECT_TYPES = new Set([
  0, // motorway exit
  1, // motorway entrance
  2, // motorway
  3, // motorway service area
  5, // motorway access connection
  6, // service access
  13, // car shuttle
  14, // ferry
  21, // expressway
  22, // via ferrata
]);

/** Pair of coordinates representing one indexed source segment. */
type LineSegment = readonly [RoutingCoordinate, RoutingCoordinate];

/** Segment candidate retained before duplicate endpoint pairs are resolved. */
interface SegmentCandidate extends PrecomputedRoutingSegment {
  /** Stable insertion order used only while compiling the current fragment. */
  insertionIndex: number;
}

/**
 * Small uniform spatial index used only by geometric hiking enrichment.
 * Items spanning bucket boundaries are deduplicated when queried.
 */
class CompilerSpatialGrid<T> {
  private readonly buckets = new Map<string, T[]>();

  /** Adds an item to every bucket touched by its bounding box. */
  insert(
    item: T,
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
  ): void {
    const minColumn = Math.floor(minX / COMPILER_SPATIAL_GRID_SIZE_METRES);
    const maxColumn = Math.floor(maxX / COMPILER_SPATIAL_GRID_SIZE_METRES);
    const minRow = Math.floor(minY / COMPILER_SPATIAL_GRID_SIZE_METRES);
    const maxRow = Math.floor(maxY / COMPILER_SPATIAL_GRID_SIZE_METRES);

    for (let column = minColumn; column <= maxColumn; column += 1) {
      for (let row = minRow; row <= maxRow; row += 1) {
        const key = `${column}:${row}`;
        const bucket = this.buckets.get(key);

        if (bucket) {
          bucket.push(item);
        } else {
          this.buckets.set(key, [item]);
        }
      }
    }
  }

  /** Returns unique items whose buckets intersect the requested extent. */
  query(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
  ): Set<T> {
    const items = new Set<T>();
    const minColumn = Math.floor(minX / COMPILER_SPATIAL_GRID_SIZE_METRES);
    const maxColumn = Math.floor(maxX / COMPILER_SPATIAL_GRID_SIZE_METRES);
    const minRow = Math.floor(minY / COMPILER_SPATIAL_GRID_SIZE_METRES);
    const maxRow = Math.floor(maxY / COMPILER_SPATIAL_GRID_SIZE_METRES);

    for (let column = minColumn; column <= maxColumn; column += 1) {
      for (let row = minRow; row <= maxRow; row += 1) {
        for (const item of this.buckets.get(`${column}:${row}`) ?? []) {
          items.add(item);
        }
      }
    }

    return items;
  }
}

function coordinateDistanceSquared(
  first: RoutingCoordinate,
  second: RoutingCoordinate,
): number {
  const deltaX = first[0] - second[0];
  const deltaY = first[1] - second[1];
  return deltaX * deltaX + deltaY * deltaY;
}

function coordinateDistance(
  first: RoutingCoordinate,
  second: RoutingCoordinate,
): number {
  return Math.sqrt(coordinateDistanceSquared(first, second));
}

/**
 * Creates the globally stable 3D identity used to join neighbouring cells.
 * @param coordinate - EPSG:2056 coordinate with optional elevation in metres.
 * @returns Quantized horizontal and vertical node key.
 */
export function precomputedNodeKey(coordinate: RoutingCoordinate): string {
  const horizontalKey = `${Math.round(
    coordinate[0] / NODE_HORIZONTAL_PRECISION_METRES,
  )}:${Math.round(coordinate[1] / NODE_HORIZONTAL_PRECISION_METRES)}`;
  const elevation = coordinate[2];

  // Elevation belongs to identity rather than only presentation; otherwise a
  // bridge and the road below it would become one connected graph node.
  return Number.isFinite(elevation)
    ? `${horizontalKey}:${Math.round(
        elevation / NODE_VERTICAL_PRECISION_METRES,
      )}`
    : `${horizontalKey}:2d`;
}

function undirectedSegmentKey(
  startNodeKey: string,
  endNodeKey: string,
): string {
  return startNodeKey < endNodeKey
    ? `${startNodeKey}|${endNodeKey}`
    : `${endNodeKey}|${startNodeKey}`;
}

/** Projects one point onto a finite segment in the horizontal plane. */
function pointToSegmentDistanceSquared(
  coordinate: RoutingCoordinate,
  start: RoutingCoordinate,
  end: RoutingCoordinate,
): number {
  const deltaX = end[0] - start[0];
  const deltaY = end[1] - start[1];
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;

  if (lengthSquared === 0) {
    return coordinateDistanceSquared(coordinate, start);
  }

  const fraction = Math.max(
    0,
    Math.min(
      1,
      ((coordinate[0] - start[0]) * deltaX +
        (coordinate[1] - start[1]) * deltaY) /
        lengthSquared,
    ),
  );
  const projectedCoordinate: RoutingCoordinate = [
    start[0] + fraction * deltaX,
    start[1] + fraction * deltaY,
  ];

  return coordinateDistanceSquared(coordinate, projectedCoordinate);
}

/**
 * Converts swissTLM3D attributes into the final pedestrian routing factor.
 * @param attributes - Normalized road type, access, surface, and importance.
 * @param isHikingTrail - Whether the segment carries the official hiking status.
 * @returns A positive factor, or `Infinity` when pedestrians must not use it.
 */
function roadCostFactor(
  attributes: PrecomputedSourceRoadAttributes,
  isHikingTrail: boolean,
): number {
  const objectType = attributes.objectType;
  const restriction = attributes.restriction;
  const importance = attributes.importance;

  // Hard exclusions take precedence over every preference so a shorter route
  // can never make an illegal or unsafe segment traversable.
  if (
    (objectType !== undefined && NON_WALKABLE_OBJECT_TYPES.has(objectType)) ||
    restriction === 2_000 ||
    importance === 100
  ) {
    return Number.POSITIVE_INFINITY;
  }

  // Unknown ordinary roads stay connected with a slight penalty rather than
  // fragmenting the graph because one optional attribute is absent.
  let factor = 1.25;

  switch (objectType) {
    case 16: // 1 m path
    case 17: // isolated 1 m path fragment
    case 19: // marked trace
      factor = 0.9;
      break;
    case 15: // 2 m path
    case 18: // isolated 2 m path fragment
      factor = 0.96;
      break;
    case 11: // 3 m road
      factor = 1.05;
      break;
    case 10: // 4 m road
      factor = 1.18;
      break;
    case 12: // traffic area axis
      factor = 1.15;
      break;
    case 9: // 6 m road
      factor = 1.65;
      break;
    case 8: // 10 m road
    case 20: // 8 m road
      factor = 2.5;
      break;
    case 4: // virtual network connection
      factor = 1.4;
      break;
    case 23: // provisional slow-traffic axis
      factor = 1;
      break;
  }

  if ([300, 400, 1_000, 1_200].includes(restriction ?? -1)) {
    factor *= 0.82;
  }

  if (importance === 200) {
    factor *= 1.7;
  } else if (importance === 300) {
    factor *= 1.25;
  }

  if (attributes.surface === 200) {
    factor *= 0.94;
  } else if (attributes.surface === 100) {
    factor *= 1.04;
  }

  if (isHikingTrail) {
    factor *= 0.72;
  }

  return factor;
}

/** Builds the spatial index used only when hiking status is not preclassified. */
function createHikingSegmentIndex(
  features: PrecomputedSourceLineFeature[],
): CompilerSpatialGrid<LineSegment> {
  const index = new CompilerSpatialGrid<LineSegment>();

  for (const feature of features) {
    for (const line of feature.lines) {
      for (let vertexIndex = 1; vertexIndex < line.length; vertexIndex += 1) {
        const segment: LineSegment = [
          line[vertexIndex - 1],
          line[vertexIndex],
        ];
        const [start, end] = segment;

        index.insert(
          segment,
          Math.min(start[0], end[0]) - HIKING_MATCH_DISTANCE_METRES,
          Math.min(start[1], end[1]) - HIKING_MATCH_DISTANCE_METRES,
          Math.max(start[0], end[0]) + HIKING_MATCH_DISTANCE_METRES,
          Math.max(start[1], end[1]) + HIKING_MATCH_DISTANCE_METRES,
        );
      }
    }
  }

  return index;
}

/** Returns whether two segments are parallel enough for hiking enrichment. */
function segmentsHaveSimilarDirection(
  firstStart: RoutingCoordinate,
  firstEnd: RoutingCoordinate,
  secondStart: RoutingCoordinate,
  secondEnd: RoutingCoordinate,
): boolean {
  const firstX = firstEnd[0] - firstStart[0];
  const firstY = firstEnd[1] - firstStart[1];
  const secondX = secondEnd[0] - secondStart[0];
  const secondY = secondEnd[1] - secondStart[1];
  const denominator =
    Math.hypot(firstX, firstY) * Math.hypot(secondX, secondY);

  if (denominator === 0) {
    return false;
  }

  return (
    Math.abs(firstX * secondX + firstY * secondY) / denominator >=
    MIN_DIRECTION_COSINE
  );
}

/**
 * Matches a road against the optional hiking overlay at three interior points.
 * Requiring two aligned samples avoids false positives at simple crossings.
 */
function isHikingSegment(
  start: RoutingCoordinate,
  end: RoutingCoordinate,
  hikingSegmentIndex: CompilerSpatialGrid<LineSegment>,
): boolean {
  const thresholdSquared =
    HIKING_MATCH_DISTANCE_METRES * HIKING_MATCH_DISTANCE_METRES;
  const samples = HIKING_SAMPLE_FRACTIONS.map(
    (fraction): RoutingCoordinate => [
      start[0] + (end[0] - start[0]) * fraction,
      start[1] + (end[1] - start[1]) * fraction,
    ],
  );
  let matchingSamples = 0;

  for (const sample of samples) {
    const candidates = hikingSegmentIndex.query(
      sample[0] - HIKING_MATCH_DISTANCE_METRES,
      sample[1] - HIKING_MATCH_DISTANCE_METRES,
      sample[0] + HIKING_MATCH_DISTANCE_METRES,
      sample[1] + HIKING_MATCH_DISTANCE_METRES,
    );

    for (const [hikingStart, hikingEnd] of candidates) {
      if (
        segmentsHaveSimilarDirection(start, end, hikingStart, hikingEnd) &&
        pointToSegmentDistanceSquared(sample, hikingStart, hikingEnd) <=
          thresholdSquared
      ) {
        matchingSamples += 1;
        break;
      }
    }
  }

  return matchingSamples >= 2;
}

/**
 * Compiles normalized swissTLM3D features into globally mergeable graph data.
 *
 * Consecutive source vertices become edges, but arbitrary 2D crossings are not
 * split. The source Z coordinate therefore continues to protect bridge and
 * tunnel topology. Duplicate endpoint pairs retain the cheapest walkable
 * interpretation.
 *
 * @param data - Normalized road geometry and optional hiking enrichment.
 * @returns Portable graph nodes and final-cost segments; an empty result is valid.
 */
export function compilePrecomputedRoutingGraph(
  data: PrecomputedSourceNetworkData,
): PrecomputedRoutingGraphData {
  const nodesByKey = new Map<string, PrecomputedRoutingNode>();
  const segmentCandidates = new Map<string, SegmentCandidate>();
  const hikingSegmentIndex = createHikingSegmentIndex(data.hikingTrails);
  let nextInsertionIndex = 0;

  for (const feature of data.roads) {
    for (const line of feature.lines) {
      for (let vertexIndex = 1; vertexIndex < line.length; vertexIndex += 1) {
        const start = line[vertexIndex - 1];
        const end = line[vertexIndex];
        const distance = coordinateDistance(start, end);

        if (distance < MIN_SOURCE_SEGMENT_LENGTH_METRES) {
          continue;
        }

        const startNodeKey = precomputedNodeKey(start);
        const endNodeKey = precomputedNodeKey(end);

        if (startNodeKey === endNodeKey) {
          continue;
        }

        const hikingTrail =
          feature.isHikingTrail ??
          isHikingSegment(start, end, hikingSegmentIndex);
        const factor = roadCostFactor(feature.attributes, hikingTrail);

        if (!Number.isFinite(factor)) {
          // Excluded roads must not leave orphan node records in precomputed
          // cells; they cannot participate in snapping, adjacency, or A*.
          continue;
        }

        if (!nodesByKey.has(startNodeKey)) {
          nodesByKey.set(startNodeKey, {
            key: startNodeKey,
            coordinate: [...start],
          });
        }

        if (!nodesByKey.has(endNodeKey)) {
          nodesByKey.set(endNodeKey, {
            key: endNodeKey,
            coordinate: [...end],
          });
        }

        const candidate: SegmentCandidate = {
          startNodeKey,
          endNodeKey,
          cost: distance * factor,
          isHikingTrail: hikingTrail,
          insertionIndex: nextInsertionIndex,
        };
        nextInsertionIndex += 1;
        const key = undirectedSegmentKey(startNodeKey, endNodeKey);
        const existingCandidate = segmentCandidates.get(key);

        if (!existingCandidate || candidate.cost < existingCandidate.cost) {
          segmentCandidates.set(key, candidate);
        }
      }
    }
  }

  return {
    nodes: [...nodesByKey.values()],
    segments: [...segmentCandidates.values()]
      .sort((first, second) => first.insertionIndex - second.insertionIndex)
      .map(({ insertionIndex: _insertionIndex, ...segment }) => segment),
    sourceRoadFeatures: data.roads.length,
    sourceHikingFeatures: data.hikingTrails.length,
  };
}
