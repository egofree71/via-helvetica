/**
 * Business context: assembles compact precomputed swissTLM3D graph cells into
 * a corridor-specific routing network. Global integer node IDs and typed arrays
 * avoid string-key reconstruction, per-node objects, and runtime edge
 * deduplication while preserving the same snapping and A* semantics as the
 * reference `RoutingNetwork` implementation.
 */
import type { Coordinate } from 'ol/coordinate.js';
import type { Extent } from 'ol/extent.js';
import {
  MIN_ROUTING_COST_FACTOR,
} from './precomputedRoutingGraph';
import {
  PRECOMPUTED_BINARY_COST_SCALE,
  PRECOMPUTED_BINARY_NO_ELEVATION,
  PRECOMPUTED_BINARY_XY_SCALE,
  PRECOMPUTED_BINARY_Z_SCALE,
  type PrecomputedBinaryRoutingCell,
} from './precomputedBinaryRoutingFormat';
import {
  NoWalkableNetworkError,
  type RoutedNetworkPath,
  type RoutableNetwork,
  type RoutingNetworkStats,
} from './networkRouter';
import {
  DUPLICATE_COORDINATE_DISTANCE_SQUARED,
  MAX_SNAP_DISTANCE,
  ROUTING_SPATIAL_GRID_SIZE_METRES,
  SNAP_DISTANCE_TIE_TOLERANCE_METRES,
  shouldReplaceSnapCandidate,
} from './routingConstants';

/** Maximum spatial buckets one source edge may occupy before data is rejected. */
const MAX_SPATIAL_BUCKETS_PER_EDGE = 64;
/** Approximate retained overhead per spatial-index bucket in bytes. */
const ESTIMATED_SPATIAL_BUCKET_OVERHEAD_BYTES = 64;

/** Detailed result of snapping one point to a typed-array segment. */
interface BinarySnapResult {
  coordinate: Coordinate;
  distance: number;
  segmentId: number;
  startNodeId: number;
  endNodeId: number;
  cost: number;
  fraction: number;
}

/** One entry stored by the A* binary min-heap. */
interface QueueEntry {
  nodeId: number;
  distance: number;
  priority: number;
}

/**
 * Minimal A* priority queue. The graph itself is object-free; short-lived queue
 * entries remain ordinary objects because they are released after one route.
 */
class MinHeap {
  private readonly entries: QueueEntry[] = [];

  get size(): number {
    return this.entries.length;
  }

  /** Inserts one entry while keeping the smallest admissible priority at the root. */
  push(entry: QueueEntry): void {
    let index = this.entries.length;

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

  /** Removes the lowest-priority entry. */
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

/** Encodes one 250 m spatial bucket as an exact JavaScript integer. */
function spatialBucketKey(column: number, row: number): number {
  // LV95 bucket rows remain well below 100,000, so this decimal packing is
  // collision-free across the configured Swiss map extent without strings.
  return column * 100_000 + row;
}

/** Horizontal squared distance in square metres. */
function coordinateDistanceSquared(
  firstX: number,
  firstY: number,
  secondX: number,
  secondY: number,
): number {
  const deltaX = firstX - secondX;
  const deltaY = firstY - secondY;
  return deltaX * deltaX + deltaY * deltaY;
}

/** Appends a coordinate unless it would create a sub-decimetre duplicate. */
function appendCoordinate(
  coordinates: Coordinate[],
  coordinate: Coordinate,
): void {
  const previous = coordinates[coordinates.length - 1];

  if (
    !previous ||
    coordinateDistanceSquared(
      previous[0],
      previous[1],
      coordinate[0],
      coordinate[1],
    ) > DUPLICATE_COORDINATE_DISTANCE_SQUARED
  ) {
    coordinates.push(coordinate);
  }
}

/**
 * Immutable typed-array routing network assembled from binary cells.
 *
 * Use `BinaryRoutingNetwork.fromCells()` so global IDs, CSR adjacency, and the
 * snapping index are fully constructed before route operations begin.
 */
export class BinaryRoutingNetwork implements RoutableNetwork {
  readonly stats: RoutingNetworkStats;
  readonly estimatedMemoryBytes: number;

  /** Segment IDs grouped by 250 m bucket for bounded snapping scans. */
  private readonly segmentBuckets: Map<number, Uint32Array>;
  /** Generation marks avoid allocating a Set while deduplicating bucket hits. */
  private readonly visitedSegments: Uint32Array;
  /** Reused A* distances; generation marks distinguish untouched entries. */
  private readonly routeDistances: Float64Array;
  /** Reused A* predecessor links for nodes reached in the current generation. */
  private readonly routePreviousNodes: Int32Array;
  /** Per-node generation marks avoid clearing route arrays for every short path. */
  private readonly routeVisitedGeneration: Uint32Array;
  private snapQueryGeneration = 0;
  private routeQueryGeneration = 0;

  private constructor(
    private readonly extent: Extent,
    private readonly nodeX: Int32Array,
    private readonly nodeY: Int32Array,
    private readonly nodeZ: Int32Array,
    private readonly segmentStartNodes: Uint32Array,
    private readonly segmentEndNodes: Uint32Array,
    private readonly segmentCosts: Uint32Array,
    private readonly segmentFlags: Uint8Array,
    private readonly adjacencyOffsets: Uint32Array,
    private readonly adjacencySegmentIds: Uint32Array,
    segmentBuckets: Map<number, Uint32Array>,
    stats: RoutingNetworkStats,
  ) {
    this.segmentBuckets = segmentBuckets;
    this.visitedSegments = new Uint32Array(segmentStartNodes.length);
    this.routeDistances = new Float64Array(nodeX.length);
    this.routePreviousNodes = new Int32Array(nodeX.length);
    this.routeVisitedGeneration = new Uint32Array(nodeX.length);
    this.stats = stats;

    let bucketBytes = 0;
    for (const segmentIds of segmentBuckets.values()) {
      bucketBytes +=
        segmentIds.byteLength + ESTIMATED_SPATIAL_BUCKET_OVERHEAD_BYTES;
    }

    this.estimatedMemoryBytes =
      nodeX.byteLength +
      nodeY.byteLength +
      nodeZ.byteLength +
      segmentStartNodes.byteLength +
      segmentEndNodes.byteLength +
      segmentCosts.byteLength +
      segmentFlags.byteLength +
      adjacencyOffsets.byteLength +
      adjacencySegmentIds.byteLength +
      this.visitedSegments.byteLength +
      this.routeDistances.byteLength +
      this.routePreviousNodes.byteLength +
      this.routeVisitedGeneration.byteLength +
      bucketBytes;
  }

  /**
   * Joins independently loaded cells through their global integer node IDs.
   * @param extent - Combined extent of covered corridor cells.
   * @param cells - Overlapping binary cells deduplicated through global IDs.
   * @returns A fully indexed typed-array routing network.
   * @throws {NoWalkableNetworkError} When no edge is available.
   * @throws {Error} When global node coordinates conflict or an edge is invalid.
   */
  static fromCells(
    extent: Extent,
    cells: PrecomputedBinaryRoutingCell[],
  ): BinaryRoutingNetwork {
    const metadataCell = cells.find(
      (cell) => cell.globalNodeCount > 0 && cell.globalEdgeCount > 0,
    );

    if (!metadataCell) {
      throw new NoWalkableNetworkError();
    }

    const globalNodeCount = metadataCell.globalNodeCount;
    const globalEdgeCount = metadataCell.globalEdgeCount;

    for (const cell of cells) {
      if (
        (cell.globalNodeCount !== 0 &&
          cell.globalNodeCount !== globalNodeCount) ||
        (cell.globalEdgeCount !== 0 && cell.globalEdgeCount !== globalEdgeCount)
      ) {
        throw new Error(
          'Precomputed binary cells disagree on global ID ranges.',
        );
      }
    }

    const maximumNodeReferences = cells.reduce(
      (total, cell) => total + cell.nodeIds.length,
      0,
    );
    // A Geneva corridor covers a meaningful fraction of the experimental ID
    // range, so a dense lookup is faster. A national dataset would make that
    // range sparse for one corridor; the Map fallback avoids allocating tens
    // of millions of unused entries on memory-constrained devices.
    const useDenseNodeIndex = globalNodeCount <= maximumNodeReferences * 4;
    const denseNodeIndex = useDenseNodeIndex
      ? new Int32Array(globalNodeCount)
      : null;
    denseNodeIndex?.fill(-1);
    const sparseNodeIndex = useDenseNodeIndex
      ? null
      : new Map<number, number>();
    const getLocalNodeId = (globalId: number): number =>
      denseNodeIndex
        ? denseNodeIndex[globalId]
        : (sparseNodeIndex?.get(globalId) ?? -1);
    const setLocalNodeId = (globalId: number, localId: number): void => {
      if (denseNodeIndex) {
        denseNodeIndex[globalId] = localId;
      } else {
        sparseNodeIndex?.set(globalId, localId);
      }
    };
    const temporaryNodeX = new Int32Array(maximumNodeReferences);
    const temporaryNodeY = new Int32Array(maximumNodeReferences);
    const temporaryNodeZ = new Int32Array(maximumNodeReferences);
    let nodeCount = 0;
    let sourceRoadFeatures = 0;

    for (const cell of cells) {
      sourceRoadFeatures += cell.sourceRoadFeatures;

      for (let index = 0; index < cell.nodeIds.length; index += 1) {
        const globalId = cell.nodeIds[index];
        const existingLocalId = getLocalNodeId(globalId);

        if (existingLocalId >= 0) {
          if (
            temporaryNodeX[existingLocalId] !== cell.nodeX[index] ||
            temporaryNodeY[existingLocalId] !== cell.nodeY[index] ||
            temporaryNodeZ[existingLocalId] !== cell.nodeZ[index]
          ) {
            throw new Error(
              'Precomputed binary cells disagree on a global node coordinate.',
            );
          }
          continue;
        }

        setLocalNodeId(globalId, nodeCount);
        temporaryNodeX[nodeCount] = cell.nodeX[index];
        temporaryNodeY[nodeCount] = cell.nodeY[index];
        temporaryNodeZ[nodeCount] = cell.nodeZ[index];
        nodeCount += 1;
      }
    }

    const maximumEdgeReferences = cells.reduce(
      (total, cell) => total + cell.edgeIds.length,
      0,
    );
    const useDenseEdgeIndex = globalEdgeCount <= maximumEdgeReferences * 4;
    const denseEdgeIndex = useDenseEdgeIndex
      ? new Int32Array(globalEdgeCount)
      : null;
    denseEdgeIndex?.fill(-1);
    const sparseEdgeIndex = useDenseEdgeIndex
      ? null
      : new Map<number, number>();
    const getLocalEdgeId = (globalId: number): number =>
      denseEdgeIndex
        ? denseEdgeIndex[globalId]
        : (sparseEdgeIndex?.get(globalId) ?? -1);
    const setLocalEdgeId = (globalId: number, localId: number): void => {
      if (denseEdgeIndex) {
        denseEdgeIndex[globalId] = localId;
      } else {
        sparseEdgeIndex?.set(globalId, localId);
      }
    };
    const temporarySegmentStartNodes = new Uint32Array(maximumEdgeReferences);
    const temporarySegmentEndNodes = new Uint32Array(maximumEdgeReferences);
    const temporarySegmentCosts = new Uint32Array(maximumEdgeReferences);
    const temporarySegmentFlags = new Uint8Array(maximumEdgeReferences);
    let edgeCount = 0;

    for (const cell of cells) {
      for (let index = 0; index < cell.edgeIds.length; index += 1) {
        const globalEdgeId = cell.edgeIds[index];
        const startNodeId = getLocalNodeId(cell.edgeStartNodeIds[index]);
        const endNodeId = getLocalNodeId(cell.edgeEndNodeIds[index]);
        const cost = cell.edgeCosts[index];
        const flags = cell.edgeFlags[index];

        if (
          startNodeId < 0 ||
          endNodeId < 0 ||
          startNodeId === endNodeId ||
          cost === 0 ||
          flags > 1
        ) {
          throw new Error('Precomputed binary graph contains an invalid edge.');
        }

        const existingLocalEdge = getLocalEdgeId(globalEdgeId);

        if (existingLocalEdge >= 0) {
          const existingStart = temporarySegmentStartNodes[existingLocalEdge];
          const existingEnd = temporarySegmentEndNodes[existingLocalEdge];
          const sameEndpoints =
            (existingStart === startNodeId && existingEnd === endNodeId) ||
            (existingStart === endNodeId && existingEnd === startNodeId);

          if (
            !sameEndpoints ||
            temporarySegmentCosts[existingLocalEdge] !== cost ||
            temporarySegmentFlags[existingLocalEdge] !== flags
          ) {
            throw new Error(
              'Precomputed binary cells disagree on a global edge.',
            );
          }
          continue;
        }

        setLocalEdgeId(globalEdgeId, edgeCount);
        temporarySegmentStartNodes[edgeCount] = startNodeId;
        temporarySegmentEndNodes[edgeCount] = endNodeId;
        temporarySegmentCosts[edgeCount] = cost;
        temporarySegmentFlags[edgeCount] = flags;
        edgeCount += 1;
      }
    }

    if (edgeCount === 0) {
      throw new NoWalkableNetworkError();
    }

    const nodeX = temporaryNodeX.slice(0, nodeCount);
    const nodeY = temporaryNodeY.slice(0, nodeCount);
    const nodeZ = temporaryNodeZ.slice(0, nodeCount);
    const segmentStartNodes = temporarySegmentStartNodes.slice(0, edgeCount);
    const segmentEndNodes = temporarySegmentEndNodes.slice(0, edgeCount);
    const segmentCosts = temporarySegmentCosts.slice(0, edgeCount);
    const segmentFlags = temporarySegmentFlags.slice(0, edgeCount);
    const degrees = new Uint32Array(nodeCount);
    let hikingSegments = 0;

    for (let edgeId = 0; edgeId < edgeCount; edgeId += 1) {
      degrees[segmentStartNodes[edgeId]] += 1;
      degrees[segmentEndNodes[edgeId]] += 1;
      hikingSegments += segmentFlags[edgeId] & 1;
    }

    const adjacencyOffsets = new Uint32Array(nodeCount + 1);
    for (let nodeId = 0; nodeId < nodeCount; nodeId += 1) {
      adjacencyOffsets[nodeId + 1] =
        adjacencyOffsets[nodeId] + degrees[nodeId];
    }

    const adjacencySegmentIds = new Uint32Array(edgeCount * 2);
    const writeOffsets = adjacencyOffsets.slice(0, nodeCount);

    for (let edgeId = 0; edgeId < edgeCount; edgeId += 1) {
      const startNodeId = segmentStartNodes[edgeId];
      const endNodeId = segmentEndNodes[edgeId];
      adjacencySegmentIds[writeOffsets[startNodeId]] = edgeId;
      writeOffsets[startNodeId] += 1;
      adjacencySegmentIds[writeOffsets[endNodeId]] = edgeId;
      writeOffsets[endNodeId] += 1;
    }

    const mutableBuckets = new Map<number, number[]>();

    for (let edgeId = 0; edgeId < edgeCount; edgeId += 1) {
      const startNodeId = segmentStartNodes[edgeId];
      const endNodeId = segmentEndNodes[edgeId];
      const startX = nodeX[startNodeId] / PRECOMPUTED_BINARY_XY_SCALE;
      const startY = nodeY[startNodeId] / PRECOMPUTED_BINARY_XY_SCALE;
      const endX = nodeX[endNodeId] / PRECOMPUTED_BINARY_XY_SCALE;
      const endY = nodeY[endNodeId] / PRECOMPUTED_BINARY_XY_SCALE;
      const minColumn = Math.floor(
        Math.min(startX, endX) / ROUTING_SPATIAL_GRID_SIZE_METRES,
      );
      const maxColumn = Math.floor(
        Math.max(startX, endX) / ROUTING_SPATIAL_GRID_SIZE_METRES,
      );
      const minRow = Math.floor(
        Math.min(startY, endY) / ROUTING_SPATIAL_GRID_SIZE_METRES,
      );
      const maxRow = Math.floor(
        Math.max(startY, endY) / ROUTING_SPATIAL_GRID_SIZE_METRES,
      );
      const bucketCount =
        (maxColumn - minColumn + 1) * (maxRow - minRow + 1);

      // A corrupt endpoint can otherwise expand one edge across millions of
      // buckets and exhaust the Worker heap before routing even starts.
      if (bucketCount > MAX_SPATIAL_BUCKETS_PER_EDGE) {
        throw new Error(
          'Precomputed binary graph edge spans an implausible spatial extent.',
        );
      }

      for (let column = minColumn; column <= maxColumn; column += 1) {
        for (let row = minRow; row <= maxRow; row += 1) {
          const key = spatialBucketKey(column, row);
          const bucket = mutableBuckets.get(key);

          if (bucket) {
            bucket.push(edgeId);
          } else {
            mutableBuckets.set(key, [edgeId]);
          }
        }
      }
    }

    const segmentBuckets = new Map<number, Uint32Array>();
    for (const [key, segmentIds] of mutableBuckets) {
      segmentBuckets.set(key, Uint32Array.from(segmentIds));
    }

    return new BinaryRoutingNetwork(
      extent,
      nodeX,
      nodeY,
      nodeZ,
      segmentStartNodes,
      segmentEndNodes,
      segmentCosts,
      segmentFlags,
      adjacencyOffsets,
      adjacencySegmentIds,
      segmentBuckets,
      {
        roadFeatures: sourceRoadFeatures,
        hikingFeatures: 0,
        nodes: nodeCount,
        segments: edgeCount,
        hikingSegments,
      },
    );
  }

  /** Returns whether a coordinate lies inside the corridor data extent. */
  contains(coordinate: Coordinate): boolean {
    return (
      coordinate[0] >= this.extent[0] &&
      coordinate[1] >= this.extent[1] &&
      coordinate[0] <= this.extent[2] &&
      coordinate[1] <= this.extent[3]
    );
  }

  /** Projects a coordinate onto the closest segment within the snap tolerance. */
  snap(coordinate: Coordinate): Coordinate | null {
    return this.findSnap(coordinate)?.coordinate ?? null;
  }

  /**
   * Calculates the least-cost route using CSR adjacency and A*.
   * @param startCoordinate - Requested route start in EPSG:2056.
   * @param endCoordinate - Requested route destination in EPSG:2056.
   * @returns Routed geometry and snap distances, or `null` for a normal miss.
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

    const directPath =
      startSnap.segmentId === endSnap.segmentId
        ? {
            coordinates: [startSnap.coordinate, endSnap.coordinate],
            cost:
              Math.abs(startSnap.fraction - endSnap.fraction) *
              startSnap.cost,
          }
        : null;
    this.routeQueryGeneration += 1;
    if (this.routeQueryGeneration === 0xffffffff) {
      this.routeVisitedGeneration.fill(0);
      this.routeQueryGeneration = 1;
    }

    const generation = this.routeQueryGeneration;
    const queue = new MinHeap();
    const getDistance = (nodeId: number): number =>
      this.routeVisitedGeneration[nodeId] === generation
        ? this.routeDistances[nodeId]
        : Number.POSITIVE_INFINITY;
    const setDistance = (
      nodeId: number,
      distance: number,
      previousNodeId: number,
    ): void => {
      this.routeVisitedGeneration[nodeId] = generation;
      this.routeDistances[nodeId] = distance;
      this.routePreviousNodes[nodeId] = previousNodeId;
    };

    const seed = (nodeId: number, distance: number): void => {
      if (distance >= getDistance(nodeId)) {
        return;
      }

      setDistance(nodeId, distance, -1);
      queue.push({
        nodeId,
        distance,
        priority:
          distance +
          this.distanceFromNodeToCoordinate(nodeId, endSnap.coordinate) *
            MIN_ROUTING_COST_FACTOR,
      });
    };

    seed(startSnap.startNodeId, startSnap.cost * startSnap.fraction);
    seed(startSnap.endNodeId, startSnap.cost * (1 - startSnap.fraction));

    let bestCost = directPath?.cost ?? Number.POSITIVE_INFINITY;
    let bestGoalNodeId = -1;

    while (queue.size > 0) {
      const current = queue.pop();

      if (!current) {
        break;
      }

      if (current.distance !== getDistance(current.nodeId)) {
        continue;
      }

      if (current.priority >= bestCost) {
        break;
      }

      let endCost: number | undefined;
      if (current.nodeId === endSnap.startNodeId) {
        endCost = endSnap.cost * endSnap.fraction;
      }
      if (current.nodeId === endSnap.endNodeId) {
        const candidate = endSnap.cost * (1 - endSnap.fraction);
        endCost = endCost === undefined ? candidate : Math.min(endCost, candidate);
      }

      if (endCost !== undefined && current.distance + endCost < bestCost) {
        bestCost = current.distance + endCost;
        bestGoalNodeId = current.nodeId;
      }

      const adjacencyStart = this.adjacencyOffsets[current.nodeId];
      const adjacencyEnd = this.adjacencyOffsets[current.nodeId + 1];

      for (
        let adjacencyIndex = adjacencyStart;
        adjacencyIndex < adjacencyEnd;
        adjacencyIndex += 1
      ) {
        const edgeId = this.adjacencySegmentIds[adjacencyIndex];
        const startNodeId = this.segmentStartNodes[edgeId];
        const endNodeId = this.segmentEndNodes[edgeId];
        const neighbourId =
          startNodeId === current.nodeId ? endNodeId : startNodeId;
        const distance =
          current.distance +
          this.segmentCosts[edgeId] / PRECOMPUTED_BINARY_COST_SCALE;

        if (distance >= getDistance(neighbourId)) {
          continue;
        }

        setDistance(neighbourId, distance, current.nodeId);
        queue.push({
          nodeId: neighbourId,
          distance,
          priority:
            distance +
            this.distanceFromNodeToCoordinate(
              neighbourId,
              endSnap.coordinate,
            ) *
              MIN_ROUTING_COST_FACTOR,
        });
      }
    }

    if (directPath && bestGoalNodeId < 0) {
      return {
        coordinates: directPath.coordinates,
        snapDistanceStart: startSnap.distance,
        snapDistanceEnd: endSnap.distance,
      };
    }

    if (bestGoalNodeId < 0) {
      return null;
    }

    const nodePath: number[] = [];
    let nodeId = bestGoalNodeId;

    while (nodeId >= 0) {
      nodePath.push(nodeId);
      nodeId = this.routePreviousNodes[nodeId];
    }

    nodePath.reverse();
    const coordinates: Coordinate[] = [];
    appendCoordinate(coordinates, startSnap.coordinate);

    for (const pathNodeId of nodePath) {
      appendCoordinate(coordinates, this.nodeCoordinate(pathNodeId));
    }

    appendCoordinate(coordinates, endSnap.coordinate);

    return {
      coordinates,
      snapDistanceStart: startSnap.distance,
      snapDistanceEnd: endSnap.distance,
    };
  }

  /** Returns one node coordinate converted from fixed-point integer storage. */
  private nodeCoordinate(nodeId: number): Coordinate {
    const coordinate: Coordinate = [
      this.nodeX[nodeId] / PRECOMPUTED_BINARY_XY_SCALE,
      this.nodeY[nodeId] / PRECOMPUTED_BINARY_XY_SCALE,
    ];
    const elevation = this.nodeZ[nodeId];

    if (elevation !== PRECOMPUTED_BINARY_NO_ELEVATION) {
      coordinate.push(elevation / PRECOMPUTED_BINARY_Z_SCALE);
    }

    return coordinate;
  }

  /** Horizontal distance from one stored node to an arbitrary coordinate. */
  private distanceFromNodeToCoordinate(
    nodeId: number,
    coordinate: Coordinate,
  ): number {
    return Math.sqrt(
      coordinateDistanceSquared(
        this.nodeX[nodeId] / PRECOMPUTED_BINARY_XY_SCALE,
        this.nodeY[nodeId] / PRECOMPUTED_BINARY_XY_SCALE,
        coordinate[0],
        coordinate[1],
      ),
    );
  }

  /** Finds the nearest segment projection through the compact spatial index. */
  private findSnap(coordinate: Coordinate): BinarySnapResult | null {
    if (!this.contains(coordinate)) {
      return null;
    }

    this.snapQueryGeneration += 1;
    if (this.snapQueryGeneration === 0xffffffff) {
      this.visitedSegments.fill(0);
      this.snapQueryGeneration = 1;
    }

    const generation = this.snapQueryGeneration;
    const minColumn = Math.floor(
      (coordinate[0] - MAX_SNAP_DISTANCE) / ROUTING_SPATIAL_GRID_SIZE_METRES,
    );
    const maxColumn = Math.floor(
      (coordinate[0] + MAX_SNAP_DISTANCE) / ROUTING_SPATIAL_GRID_SIZE_METRES,
    );
    const minRow = Math.floor(
      (coordinate[1] - MAX_SNAP_DISTANCE) / ROUTING_SPATIAL_GRID_SIZE_METRES,
    );
    const maxRow = Math.floor(
      (coordinate[1] + MAX_SNAP_DISTANCE) / ROUTING_SPATIAL_GRID_SIZE_METRES,
    );
    let closestSegmentId = -1;
    let closestFraction = 0;
    let closestX = 0;
    let closestY = 0;
    let closestDistanceSquared = Number.POSITIVE_INFINITY;

    for (let column = minColumn; column <= maxColumn; column += 1) {
      for (let row = minRow; row <= maxRow; row += 1) {
        const segmentIds = this.segmentBuckets.get(
          spatialBucketKey(column, row),
        );

        if (!segmentIds) {
          continue;
        }

        for (const edgeId of segmentIds) {
          if (this.visitedSegments[edgeId] === generation) {
            continue;
          }
          this.visitedSegments[edgeId] = generation;

          const startNodeId = this.segmentStartNodes[edgeId];
          const endNodeId = this.segmentEndNodes[edgeId];
          const startX =
            this.nodeX[startNodeId] / PRECOMPUTED_BINARY_XY_SCALE;
          const startY =
            this.nodeY[startNodeId] / PRECOMPUTED_BINARY_XY_SCALE;
          const endX = this.nodeX[endNodeId] / PRECOMPUTED_BINARY_XY_SCALE;
          const endY = this.nodeY[endNodeId] / PRECOMPUTED_BINARY_XY_SCALE;
          const deltaX = endX - startX;
          const deltaY = endY - startY;
          const lengthSquared = deltaX * deltaX + deltaY * deltaY;
          const fraction =
            lengthSquared === 0
              ? 0
              : Math.max(
                  0,
                  Math.min(
                    1,
                    ((coordinate[0] - startX) * deltaX +
                      (coordinate[1] - startY) * deltaY) /
                      lengthSquared,
                  ),
                );
          const projectedX = startX + fraction * deltaX;
          const projectedY = startY + fraction * deltaY;
          const distanceSquared = coordinateDistanceSquared(
            coordinate[0],
            coordinate[1],
            projectedX,
            projectedY,
          );

          let shouldReplace = closestSegmentId < 0;

          if (!shouldReplace) {
            const distanceDifference =
              Math.sqrt(distanceSquared) - Math.sqrt(closestDistanceSquared);

            if (distanceDifference < -SNAP_DISTANCE_TIE_TOLERANCE_METRES) {
              shouldReplace = true;
            } else if (
              Math.abs(distanceDifference) <=
              SNAP_DISTANCE_TIE_TOLERANCE_METRES
            ) {
              const currentStartNodeId =
                this.segmentStartNodes[closestSegmentId];
              const currentEndNodeId = this.segmentEndNodes[closestSegmentId];
              shouldReplace = shouldReplaceSnapCandidate(
                distanceSquared,
                this.nodeCoordinate(startNodeId),
                this.nodeCoordinate(endNodeId),
                closestDistanceSquared,
                this.nodeCoordinate(currentStartNodeId),
                this.nodeCoordinate(currentEndNodeId),
              );
            }
          }

          if (shouldReplace) {
            closestSegmentId = edgeId;
            closestFraction = fraction;
            closestX = projectedX;
            closestY = projectedY;
            closestDistanceSquared = distanceSquared;
          }
        }
      }
    }

    if (
      closestSegmentId < 0 ||
      closestDistanceSquared > MAX_SNAP_DISTANCE * MAX_SNAP_DISTANCE
    ) {
      return null;
    }

    const startNodeId = this.segmentStartNodes[closestSegmentId];
    const endNodeId = this.segmentEndNodes[closestSegmentId];
    const snappedCoordinate: Coordinate = [closestX, closestY];
    const startZ = this.nodeZ[startNodeId];
    const endZ = this.nodeZ[endNodeId];

    if (
      startZ !== PRECOMPUTED_BINARY_NO_ELEVATION &&
      endZ !== PRECOMPUTED_BINARY_NO_ELEVATION
    ) {
      snappedCoordinate.push(
        (startZ + closestFraction * (endZ - startZ)) /
          PRECOMPUTED_BINARY_Z_SCALE,
      );
    }

    return {
      coordinate: snappedCoordinate,
      distance: Math.sqrt(closestDistanceSquared),
      segmentId: closestSegmentId,
      startNodeId,
      endNodeId,
      cost:
        this.segmentCosts[closestSegmentId] /
        PRECOMPUTED_BINARY_COST_SCALE,
      fraction: closestFraction,
    };
  }
}
