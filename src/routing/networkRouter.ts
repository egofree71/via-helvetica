/**
 * Business context: builds an in-browser walking graph from swissTLM3D road
 * geometries and the official hiking-trail overlay. The graph preserves the
 * third coordinate so bridges and tunnels are not connected to roads that only
 * cross them in plan view. It provides snapping and A* routing for route
 * creation without relying on OpenStreetMap or an external routing engine.
 */
import type { Coordinate } from 'ol/coordinate.js';
import type { Extent } from 'ol/extent.js';
import { containsCoordinate } from 'ol/extent.js';
import {
  compilePrecomputedRoutingGraph,
  MIN_ROUTING_COST_FACTOR,
  type PrecomputedRoutingGraphData,
  type PrecomputedRoutingSegment,
} from './precomputedRoutingGraph';
import {
  DUPLICATE_COORDINATE_DISTANCE_SQUARED,
  MAX_SNAP_DISTANCE,
  ROUTING_SPATIAL_GRID_SIZE_METRES,
  shouldReplaceSnapCandidate,
} from './routingConstants';
import { reconstructRouteNodePath } from './routePathReconstruction';
import type { SwissTlmNetworkData } from './swissTlmApi';

export { MAX_SNAP_DISTANCE } from './routingConstants';

/**
 * Approximate retained bytes per graph node, including its coordinate, adjacency
 * array, map entries, and spatial-index references. The value is deliberately
 * conservative because JavaScript object overhead varies by browser.
 */
const ESTIMATED_GRAPH_NODE_BYTES = 416;
/**
 * Approximate retained bytes per graph segment, including two adjacency edges
 * and spatial-index membership. It is used only for cache eviction decisions.
 */
const ESTIMATED_GRAPH_SEGMENT_BYTES = 384;
/** Node in the immutable routing graph. */
interface GraphNode {
  /** Stable array index used by graph edges and A*. */
  id: number;
  /** swissTLM3D coordinate in the map projection, including elevation when available. */
  coordinate: Coordinate;
  /** Outgoing traversable edges; the current pedestrian graph adds both directions. */
  edges: GraphEdge[];
}

/** Lightweight adjacency-list edge used during path search. */
interface GraphEdge {
  /** Destination node identifier. */
  to: number;
  /** Weighted traversal cost in metre-equivalent units. */
  cost: number;
}

/** Geometric road segment retained for snapping and route reconstruction. */
interface NetworkSegment {
  /** Stable segment identifier inside one RoutingNetwork instance. */
  id: number;
  /** Identifier of the segment's first graph node. */
  startNodeId: number;
  /** Identifier of the segment's second graph node. */
  endNodeId: number;
  /** First segment coordinate in map units, optionally including elevation. */
  start: Coordinate;
  /** Second segment coordinate in map units, optionally including elevation. */
  end: Coordinate;
  /** Horizontal segment length in metres. */
  distance: number;
  /** Weighted bidirectional traversal cost in metre-equivalent units. */
  cost: number;
  /** Whether the road segment matches the official hiking-trail portrayal. */
  isHikingTrail: boolean;
}

/** Result of projecting a user coordinate onto the nearest network segment. */
interface SnapResult {
  /** Projected point on the segment, with interpolated elevation when available. */
  coordinate: Coordinate;
  /** Horizontal distance in metres from the original point to the projection. */
  distance: number;
  /** Network segment that receives the projected point. */
  segment: NetworkSegment;
  /** Relative position on the segment: 0 at the start and 1 at the end. */
  fraction: number;
}

/** Entry stored in the A* priority queue. */
interface QueueEntry {
  /** Graph node being considered. */
  nodeId: number;
  /** Best known cost from the snapped start to this node. */
  distance: number;
  /** A* score: known cost plus the admissible remaining-distance estimate. */
  priority: number;
}

/**
 * Routed geometry returned to the route editor.
 *
 * Keep this contract structured-clone-safe and independent from OpenLayers
 * classes because it crosses the dedicated Worker boundary.
 */
export interface RoutedNetworkPath {
  /** Ordered coordinates from the snapped start to the snapped destination. */
  coordinates: Coordinate[];
  /** Distance in metres between the requested start and its snapped position. */
  snapDistanceStart: number;
  /** Distance in metres between the requested end and its snapped position. */
  snapDistanceEnd: number;
}

/** Diagnostics describing one assembled corridor routing graph. */
export interface RoutingNetworkStats {
  /** Number of source-road references reported by the selected provider. */
  roadFeatures: number;
  /**
   * Number of separate hiking-overlay references reported by the provider.
   * This is zero for binary cells, where hiking classification is encoded on
   * retained segments rather than delivered as a separate overlay.
   */
  hikingFeatures: number;
  /** Number of unique 3D graph nodes. */
  nodes: number;
  /** Number of retained walkable segments. */
  segments: number;
  /** Number of retained segments classified as official hiking trails. */
  hikingSegments: number;
}


/** Result of one bounded route search plus its frontier diagnostic. */
export interface RouteAttempt {
  /** Least-cost path found in the assembled graph, or `null` for a normal miss. */
  path: RoutedNetworkPath | null;
  /**
   * Whether A* expanded a node whose containing routing cell was not fully
   * loaded while that node could still improve the best known path.
   */
  frontierReached: boolean;
}

/** Shared contract implemented by object-based and typed-array routing graphs. */
export interface RoutableNetwork {
  /** Diagnostics for the exact corridor graph. */
  readonly stats: RoutingNetworkStats;
  /** Conservative retained-size estimate used by the Worker cache. */
  readonly estimatedMemoryBytes: number;
  /** Returns whether the graph extent contains the coordinate. */
  contains(coordinate: Coordinate): boolean;
  /** Projects a coordinate onto the nearest walkable segment. */
  snap(coordinate: Coordinate): Coordinate | null;
  /** Calculates a least-cost route between two requested coordinates. */
  route(
    startCoordinate: Coordinate,
    endCoordinate: Coordinate,
  ): RoutedNetworkPath | null;
  /**
   * Runs one route search and reports whether missing neighbouring cells could
   * still hide a better result. Only providers with a validated data-assignment
   * contract expose this diagnostic.
   */
  routeAttempt?(
    startCoordinate: Coordinate,
    endCoordinate: Coordinate,
  ): RouteAttempt;
}

/**
 * Minimal binary min-heap used by A*.
 *
 * Queue entries are ordered by their `priority`, not by travelled distance,
 * because A* must expand the most promising node first.
 */
class MinHeap {
  private readonly entries: QueueEntry[] = [];

  get size(): number {
    return this.entries.length;
  }

  /** Inserts an A* queue entry while preserving the heap invariant. */
  push(entry: QueueEntry): void {
    let index = this.entries.length;

    // Bubble the new entry upward so the cheapest estimated route stays at the root.

    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      const parent = this.entries[parentIndex];

      if (parent.priority <= entry.priority) {
        break;
      }

      this.entries[index] = parent;
      index = parentIndex;
    }

    this.entries[index] = entry;
  }

  /** Removes the entry with the lowest A* priority. */
  pop(): QueueEntry | undefined {
    if (this.entries.length === 0) {
      return undefined;
    }

    const first = this.entries[0];
    const last = this.entries.pop();

    if (!last || this.entries.length === 0) {
      return first;
    }

    let index = 0;

    // Move the former last entry downward to restore the heap after removing the root.
    while (true) {
      const leftIndex = index * 2 + 1;

      if (leftIndex >= this.entries.length) {
        break;
      }

      const rightIndex = leftIndex + 1;
      let childIndex = leftIndex;

      if (
        rightIndex < this.entries.length &&
        this.entries[rightIndex].priority <
          this.entries[leftIndex].priority
      ) {
        childIndex = rightIndex;
      }

      if (this.entries[childIndex].priority >= last.priority) {
        break;
      }

      this.entries[index] = this.entries[childIndex];
      index = childIndex;
    }

    this.entries[index] = last;
    return first;
  }
}

/**
 * Uniform spatial index for coarse candidate filtering.
 *
 * Items may appear in several buckets when their bounding box spans cell
 * boundaries; `query()` deduplicates them before returning candidates.
 */
class SpatialGrid<T> {
  private readonly buckets = new Map<string, T[]>();

  /** Adds an item to every grid bucket touched by its bounding box. */
  insert(
    item: T,
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
  ): void {
    const minColumn = Math.floor(minX / ROUTING_SPATIAL_GRID_SIZE_METRES);
    const maxColumn = Math.floor(maxX / ROUTING_SPATIAL_GRID_SIZE_METRES);
    const minRow = Math.floor(minY / ROUTING_SPATIAL_GRID_SIZE_METRES);
    const maxRow = Math.floor(maxY / ROUTING_SPATIAL_GRID_SIZE_METRES);

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
    const minColumn = Math.floor(minX / ROUTING_SPATIAL_GRID_SIZE_METRES);
    const maxColumn = Math.floor(maxX / ROUTING_SPATIAL_GRID_SIZE_METRES);
    const minRow = Math.floor(minY / ROUTING_SPATIAL_GRID_SIZE_METRES);
    const maxRow = Math.floor(maxY / ROUTING_SPATIAL_GRID_SIZE_METRES);

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
  first: Coordinate,
  second: Coordinate,
): number {
  const deltaX = first[0] - second[0];
  const deltaY = first[1] - second[1];
  return deltaX * deltaX + deltaY * deltaY;
}

function coordinateDistance(
  first: Coordinate,
  second: Coordinate,
): number {
  return Math.sqrt(coordinateDistanceSquared(first, second));
}

/**
 * Projects a point onto a finite segment in the horizontal plane and
 * interpolates elevation when both endpoints provide it.
 * @param coordinate - Point to project, in map coordinates.
 * @param start - First segment coordinate.
 * @param end - Second segment coordinate.
 * @returns The projected coordinate, its 0..1 segment fraction, and squared
 * horizontal distance in square metres.
 */
function projectOnSegment(
  coordinate: Coordinate,
  start: Coordinate,
  end: Coordinate,
): { coordinate: Coordinate; fraction: number; distanceSquared: number } {
  const deltaX = end[0] - start[0];
  const deltaY = end[1] - start[1];
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;

  if (lengthSquared === 0) {
    return {
      coordinate: [...start],
      fraction: 0,
      distanceSquared: coordinateDistanceSquared(coordinate, start),
    };
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
  const projectedCoordinate: Coordinate = [
    start[0] + fraction * deltaX,
    start[1] + fraction * deltaY,
  ];

  if (Number.isFinite(start[2]) && Number.isFinite(end[2])) {
    projectedCoordinate.push(start[2] + fraction * (end[2] - start[2]));
  }

  return {
    coordinate: projectedCoordinate,
    fraction,
    distanceSquared: coordinateDistanceSquared(
      coordinate,
      projectedCoordinate,
    ),
  };
}

/** Appends a coordinate unless it would create a sub-decimetre duplicate vertex. */
function appendCoordinate(
  coordinates: Coordinate[],
  coordinate: Coordinate,
): void {
  const previousCoordinate = coordinates[coordinates.length - 1];

  if (
    !previousCoordinate ||
    coordinateDistanceSquared(previousCoordinate, coordinate) >
      DUPLICATE_COORDINATE_DISTANCE_SQUARED
  ) {
    coordinates.push([...coordinate]);
  }
}

/**
 * Signals that the loaded cells contain no swissTLM3D segment usable by the
 * pedestrian graph. Callers may treat this as missing coverage rather than a
 * transport or parsing failure.
 */
export class NoWalkableNetworkError extends Error {
  constructor() {
    super('No walkable swissTLM3D segments could be built.');
    this.name = 'NoWalkableNetworkError';
  }
}

/**
 * Immutable pedestrian routing graph built from swissTLM3D data.
 *
 * Instances must be created with `RoutingNetwork.fromSwissTlm()` or
 * `RoutingNetwork.fromPrecomputed()` so compilation, adjacency construction,
 * and segment indexing finish before `snap()` or `route()` can be called.
 */
export class RoutingNetwork {
  readonly stats: RoutingNetworkStats;
  /** Conservative retained-size estimate used by the Worker graph LRU. */
  readonly estimatedMemoryBytes: number;
  private readonly segmentIndex = new SpatialGrid<NetworkSegment>();

  private constructor(
    private readonly extent: Extent,
    private readonly nodes: GraphNode[],
    private readonly segments: NetworkSegment[],
    stats: RoutingNetworkStats,
  ) {
    this.stats = stats;
    this.estimatedMemoryBytes =
      nodes.length * ESTIMATED_GRAPH_NODE_BYTES +
      segments.length * ESTIMATED_GRAPH_SEGMENT_BYTES;

    for (const segment of segments) {
      this.segmentIndex.insert(
        segment,
        Math.min(segment.start[0], segment.end[0]),
        Math.min(segment.start[1], segment.end[1]),
        Math.max(segment.start[0], segment.end[0]),
        Math.max(segment.start[1], segment.end[1]),
      );
    }
  }

  /**
   * Builds a routable graph from road geometries and the hiking overlay.
   * @param extent - Loaded network extent in EPSG:2056 map coordinates.
   * @param data - Normalized swissTLM3D road and hiking features.
   * @returns A fully indexed immutable routing network.
   * @throws {NoWalkableNetworkError} When no walkable segment can be produced from the supplied data.
   */
  static fromSwissTlm(
    extent: Extent,
    data: SwissTlmNetworkData,
  ): RoutingNetwork {
    return RoutingNetwork.fromPrecomputed(extent, [
      compilePrecomputedRoutingGraph(data),
    ]);
  }

  /**
   * Builds a routable network from one or more offline-compiled graph fragments.
   *
   * Global node keys join neighbouring cells, while duplicate endpoint pairs
   * retain the lowest precomputed cost. Only adjacency construction and the
   * snapping index remain session-local because they depend on the exact set of
   * cells requested for the current corridor.
   *
   * @param extent - Combined routing-cell extent in EPSG:2056.
   * @param fragments - Precomputed cells contributing nodes and segments.
   * @returns A fully indexed immutable routing network.
   * @throws {NoWalkableNetworkError} When no walkable segment is available.
   * @throws {Error} When a segment references a missing node or invalid cost.
   */
  static fromPrecomputed(
    extent: Extent,
    fragments: PrecomputedRoutingGraphData[],
  ): RoutingNetwork {
    const nodeCoordinates = new Map<string, Coordinate>();
    const segmentCandidates = new Map<string, PrecomputedRoutingSegment>();
    let sourceRoadFeatures = 0;
    let sourceHikingFeatures = 0;

    for (const fragment of fragments) {
      sourceRoadFeatures += fragment.sourceRoadFeatures;
      sourceHikingFeatures += fragment.sourceHikingFeatures;

      for (const node of fragment.nodes) {
        if (!nodeCoordinates.has(node.key)) {
          nodeCoordinates.set(node.key, [...node.coordinate]);
        }
      }

      for (const segment of fragment.segments) {
        if (!Number.isFinite(segment.cost) || segment.cost <= 0) {
          throw new Error('Precomputed routing segment has an invalid cost.');
        }

        const key =
          segment.startNodeKey < segment.endNodeKey
            ? `${segment.startNodeKey}|${segment.endNodeKey}`
            : `${segment.endNodeKey}|${segment.startNodeKey}`;
        const existingSegment = segmentCandidates.get(key);

        // Neighbouring files intentionally duplicate boundary geometry. The
        // same lowest-cost policy as live graph compilation makes that overlap
        // harmless and keeps the final graph deterministic.
        if (!existingSegment || segment.cost < existingSegment.cost) {
          segmentCandidates.set(key, segment);
        }
      }
    }

    const nodeIds = new Map<string, number>();
    const nodes: GraphNode[] = [];

    for (const [key, coordinate] of nodeCoordinates) {
      const id = nodes.length;
      nodeIds.set(key, id);
      nodes.push({ id, coordinate, edges: [] });
    }

    const segments: NetworkSegment[] = [];

    for (const segment of segmentCandidates.values()) {
      const startNodeId = nodeIds.get(segment.startNodeKey);
      const endNodeId = nodeIds.get(segment.endNodeKey);

      if (startNodeId === undefined || endNodeId === undefined) {
        throw new Error('Precomputed routing segment references a missing node.');
      }

      if (startNodeId === endNodeId) {
        continue;
      }

      const startCoordinate = nodes[startNodeId].coordinate;
      const endCoordinate = nodes[endNodeId].coordinate;
      segments.push({
        id: segments.length,
        startNodeId,
        endNodeId,
        start: startCoordinate,
        end: endCoordinate,
        distance: coordinateDistance(startCoordinate, endCoordinate),
        cost: segment.cost,
        isHikingTrail: segment.isHikingTrail,
      });
    }

    for (const segment of segments) {
      nodes[segment.startNodeId].edges.push({
        to: segment.endNodeId,
        cost: segment.cost,
      });
      nodes[segment.endNodeId].edges.push({
        to: segment.startNodeId,
        cost: segment.cost,
      });
    }

    if (segments.length === 0) {
      throw new NoWalkableNetworkError();
    }

    return new RoutingNetwork(extent, nodes, segments, {
      roadFeatures: sourceRoadFeatures,
      hikingFeatures: sourceHikingFeatures,
      nodes: nodes.length,
      segments: segments.length,
      hikingSegments: segments.filter((segment) => segment.isHikingTrail)
        .length,
    });
  }

  /** Returns whether a coordinate lies inside the data extent used to build this graph. */
  contains(coordinate: Coordinate): boolean {
    return containsCoordinate(this.extent, coordinate);
  }

  /**
   * Snaps a coordinate to the closest walkable segment.
   * @param coordinate - User-selected point in EPSG:2056.
   * @returns The projected network coordinate, or `null` outside the extent or snap tolerance.
   */
  snap(coordinate: Coordinate): Coordinate | null {
    return this.findSnap(coordinate)?.coordinate ?? null;
  }

  /**
   * Calculates the least-cost route between two coordinates with A*.
   * Both endpoints are first snapped to nearby segments, and partial-segment
   * costs are included so the search remains accurate between graph nodes.
   * @param startCoordinate - Requested route start in EPSG:2056.
   * @param endCoordinate - Requested route destination in EPSG:2056.
   * @returns Routed geometry and snap distances, or `null` when snapping or connectivity fails.
   */
  route(
    startCoordinate: Coordinate,
    endCoordinate: Coordinate,
  ): RoutedNetworkPath | null {
    const startSnap = this.findSnap(startCoordinate);

    const endSnap = this.findSnap(endCoordinate);

    if (!startSnap || !endSnap) {
      return null;
    }

    // A same-segment route is both a valid result and an upper bound for pruning A*.
    const directPath = this.routeOnSameSegment(startSnap, endSnap);

    // A snapped point can reach either endpoint of its host segment at a proportional partial cost.
    const startCandidates = new Map<number, number>([
      [
        startSnap.segment.startNodeId,
        startSnap.segment.cost * startSnap.fraction,
      ],
      [
        startSnap.segment.endNodeId,
        startSnap.segment.cost * (1 - startSnap.fraction),
      ],
    ]);
    // Destination endpoint costs are evaluated when A* reaches either end of the target segment.
    const endCandidates = new Map<number, number>([
      [
        endSnap.segment.startNodeId,
        endSnap.segment.cost * endSnap.fraction,
      ],
      [
        endSnap.segment.endNodeId,
        endSnap.segment.cost * (1 - endSnap.fraction),
      ],
    ]);
    const queue = new MinHeap();
    const distances = new Map<number, number>();
    const previousNodes = new Map<number, number>();

    // Seed both exits from the start segment. The heuristic is straight-line
    // distance multiplied by a proven lower bound for all routing costs.
    for (const [nodeId, distance] of startCandidates) {
      const existingDistance = distances.get(nodeId);

      if (existingDistance === undefined || distance < existingDistance) {
        distances.set(nodeId, distance);
        queue.push({
          nodeId,
          distance,
          priority:
            distance +
            coordinateDistance(
              this.nodes[nodeId].coordinate,
              endSnap.coordinate,
            ) *
              MIN_ROUTING_COST_FACTOR,
        });
      }
    }

    // bestCost lets the search stop once every queued estimate is no better
    // than a complete route already found.
    let bestCost = directPath?.cost ?? Number.POSITIVE_INFINITY;
    let bestGoalNodeId: number | null = null;

    while (queue.size > 0) {
      const current = queue.pop();

      if (!current) {
        break;
      }

      // Multiple heap entries can exist for one node; ignore entries superseded by a cheaper route.
      if (current.distance !== distances.get(current.nodeId)) {
        continue;
      }

      // The heap is ordered by admissible priority, so no later entry can
      // improve the best complete route.
      if (current.priority >= bestCost) {
        break;
      }

      // Reaching a destination-segment endpoint completes the route after
      // paying its remaining partial cost.
      const endCost = endCandidates.get(current.nodeId);

      if (endCost !== undefined && current.distance + endCost < bestCost) {
        bestCost = current.distance + endCost;
        bestGoalNodeId = current.nodeId;
      }

      for (const edge of this.nodes[current.nodeId].edges) {
        const distance = current.distance + edge.cost;

        if (distance >= (distances.get(edge.to) ?? Number.POSITIVE_INFINITY)) {
          continue;
        }

        distances.set(edge.to, distance);
        previousNodes.set(edge.to, current.nodeId);
        // Priority combines known cost with the optimistic remaining cost used by A*.
        queue.push({
          nodeId: edge.to,
          distance,
          priority:
            distance +
            coordinateDistance(
              this.nodes[edge.to].coordinate,
              endSnap.coordinate,
            ) *
              MIN_ROUTING_COST_FACTOR,
        });
      }
    }

    if (directPath && bestGoalNodeId === null) {
      const result = {
        coordinates: directPath.coordinates,
        snapDistanceStart: startSnap.distance,
        snapDistanceEnd: endSnap.distance,
      };

      return result;
    }

    if (bestGoalNodeId === null) {
      return null;
    }

    const nodePath = reconstructRouteNodePath(
      bestGoalNodeId,
      this.nodes.length,
      (nodeId) => previousNodes.get(nodeId),
    );

    const coordinates: Coordinate[] = [];
    appendCoordinate(coordinates, startSnap.coordinate);

    for (const pathNodeId of nodePath) {
      appendCoordinate(coordinates, this.nodes[pathNodeId].coordinate);
    }

    appendCoordinate(coordinates, endSnap.coordinate);

    const result = {
      coordinates,
      snapDistanceStart: startSnap.distance,
      snapDistanceEnd: endSnap.distance,
    };

    return result;
  }

  /**
   * Finds the closest segment projection using the spatial grid before exact distance tests.
   * @returns Detailed snap metadata, or `null` when no segment is close enough.
   */
  private findSnap(coordinate: Coordinate): SnapResult | null {
    if (!this.contains(coordinate)) {
      return null;
    }

    const candidates = this.segmentIndex.query(
      coordinate[0] - MAX_SNAP_DISTANCE,
      coordinate[1] - MAX_SNAP_DISTANCE,
      coordinate[0] + MAX_SNAP_DISTANCE,
      coordinate[1] + MAX_SNAP_DISTANCE,
    );
    let closest:
      | {
          segment: NetworkSegment;
          coordinate: Coordinate;
          fraction: number;
          distanceSquared: number;
        }
      | undefined;

    for (const segment of candidates) {
      const projection = projectOnSegment(
        coordinate,
        segment.start,
        segment.end,
      );

      if (
        !closest ||
        shouldReplaceSnapCandidate(
          projection.distanceSquared,
          segment.start,
          segment.end,
          closest.distanceSquared,
          closest.segment.start,
          closest.segment.end,
        )
      ) {
        closest = {
          segment,
          coordinate: projection.coordinate,
          fraction: projection.fraction,
          distanceSquared: projection.distanceSquared,
        };
      }
    }

    if (
      !closest ||
      closest.distanceSquared > MAX_SNAP_DISTANCE * MAX_SNAP_DISTANCE
    ) {
      return null;
    }

    return {
      coordinate: closest.coordinate,
      distance: Math.sqrt(closest.distanceSquared),
      segment: closest.segment,
      fraction: closest.fraction,
    };
  }

  /** Returns the direct partial-segment route when both snapped points share one segment. */
  private routeOnSameSegment(
    start: SnapResult,
    end: SnapResult,
  ): { coordinates: Coordinate[]; cost: number } | null {
    if (start.segment.id !== end.segment.id) {
      return null;
    }

    return {
      coordinates: [start.coordinate, end.coordinate],
      cost: Math.abs(start.fraction - end.fraction) * start.segment.cost,
    };
  }
}
