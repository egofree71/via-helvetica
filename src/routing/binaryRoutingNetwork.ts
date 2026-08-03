/**
 * Business context: assembles compact precomputed swissTLM3D graph cells into
 * a corridor-specific routing network. Global integer node IDs and typed arrays
 * avoid string-key reconstruction, per-node objects, and runtime edge
 * deduplication while preserving the same snapping and A* semantics as the
 * reference `RoutingNetwork` implementation.
 */
import type { Coordinate } from 'ol/coordinate.js';
import type { Extent } from 'ol/extent.js';
import { MIN_ROUTING_COST_FACTOR } from './precomputedRoutingGraph';
import {
  PRECOMPUTED_BINARY_COST_SCALE,
  PRECOMPUTED_BINARY_NO_ELEVATION,
  PRECOMPUTED_BINARY_XY_SCALE,
  PRECOMPUTED_BINARY_Z_SCALE,
  type PrecomputedBinaryRoutingCell,
} from './precomputedBinaryRoutingFormat';
import {
  NoWalkableNetworkError,
  type RouteAttempt,
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
import { reconstructRouteNodePath } from './routePathReconstruction';
import {
  cellKeyForCoordinate,
  type CellKey,
} from './routingGrid';

/**
 * Maximum 250 m buckets one edge may actually cross before data is rejected.
 * This still permits unusually long swissTLM3D segments while preventing a
 * corrupt endpoint from growing the snapping index across a national extent.
 */
const MAX_SPATIAL_BUCKETS_PER_EDGE = 512;
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

/** Adds one edge to one mutable spatial-index bucket. */
function addEdgeToSpatialBucket(
  buckets: Map<number, number[]>,
  column: number,
  row: number,
  edgeId: number,
): void {
  const key = spatialBucketKey(column, row);
  const bucket = buckets.get(key);

  if (bucket) {
    bucket.push(edgeId);
  } else {
    buckets.set(key, [edgeId]);
  }
}

/**
 * Indexes an edge only in grid buckets touched by its line segment.
 *
 * A bounding-box fill grows with width multiplied by height and can therefore
 * reject a valid long diagonal or retain many buckets the edge never reaches.
 * Grid traversal keeps both validation and memory proportional to edge length.
 * Corner crossings include both adjacent buckets so future snap-distance
 * changes cannot create a gap exactly on a grid boundary.
 */
function indexEdgeAlongSpatialGrid(
  buckets: Map<number, number[]>,
  edgeId: number,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): void {
  const deltaX = endX - startX;
  const deltaY = endY - startY;
  const stepColumn = Math.sign(deltaX);
  const stepRow = Math.sign(deltaY);
  let column = Math.floor(startX / ROUTING_SPATIAL_GRID_SIZE_METRES);
  let row = Math.floor(startY / ROUTING_SPATIAL_GRID_SIZE_METRES);
  const endColumn = Math.floor(endX / ROUTING_SPATIAL_GRID_SIZE_METRES);
  const endRow = Math.floor(endY / ROUTING_SPATIAL_GRID_SIZE_METRES);
  const columnDistance =
    stepColumn === 0
      ? Number.POSITIVE_INFINITY
      : ROUTING_SPATIAL_GRID_SIZE_METRES / Math.abs(deltaX);
  const rowDistance =
    stepRow === 0
      ? Number.POSITIVE_INFINITY
      : ROUTING_SPATIAL_GRID_SIZE_METRES / Math.abs(deltaY);
  const firstColumnBoundary =
    (stepColumn > 0 ? column + 1 : column) *
    ROUTING_SPATIAL_GRID_SIZE_METRES;
  const firstRowBoundary =
    (stepRow > 0 ? row + 1 : row) * ROUTING_SPATIAL_GRID_SIZE_METRES;
  let nextColumnCrossing =
    stepColumn === 0
      ? Number.POSITIVE_INFINITY
      : (firstColumnBoundary - startX) / deltaX;
  let nextRowCrossing =
    stepRow === 0
      ? Number.POSITIVE_INFINITY
      : (firstRowBoundary - startY) / deltaY;
  let indexedBucketCount = 0;

  const indexBucket = (bucketColumn: number, bucketRow: number): void => {
    indexedBucketCount += 1;

    // A corrupt endpoint can otherwise expand one edge across thousands of
    // buckets and exhaust the Worker heap before routing even starts.
    if (indexedBucketCount > MAX_SPATIAL_BUCKETS_PER_EDGE) {
      throw new Error(
        'Precomputed binary graph edge spans an implausible spatial extent.',
      );
    }

    addEdgeToSpatialBucket(buckets, bucketColumn, bucketRow, edgeId);
  };

  indexBucket(column, row);

  while (column !== endColumn || row !== endRow) {
    if (nextColumnCrossing < nextRowCrossing) {
      column += stepColumn;
      nextColumnCrossing += columnDistance;
      indexBucket(column, row);
      continue;
    }

    if (nextRowCrossing < nextColumnCrossing) {
      row += stepRow;
      nextRowCrossing += rowDistance;
      indexBucket(column, row);
      continue;
    }

    const nextColumn = column + stepColumn;
    const nextRow = row + stepRow;

    // A line passing exactly through a corner touches both side buckets before
    // entering the diagonal bucket. Retaining them makes the index a supercover.
    indexBucket(nextColumn, row);
    indexBucket(column, nextRow);
    column = nextColumn;
    row = nextRow;
    nextColumnCrossing += columnDistance;
    nextRowCrossing += rowDistance;
    indexBucket(column, row);
  }
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
 * K-way merge cursor for cell columns already sorted by global ID. The heap
 * stores only cell indexes, so national corridor assembly avoids one
 * JavaScript Map entry or short-lived object per node and edge reference.
 */
class SortedCellIdCursorHeap {
  private readonly entries: number[] = [];
  private readonly positions: Uint32Array;

  constructor(private readonly columns: Uint32Array[]) {
    this.positions = new Uint32Array(columns.length);
    for (let cellIndex = 0; cellIndex < columns.length; cellIndex += 1) {
      if (columns[cellIndex].length > 0) {
        this.push(cellIndex);
      }
    }
  }

  get size(): number {
    return this.entries.length;
  }

  /** Returns the current record index before the caller advances this cell. */
  currentRecordIndex(cellIndex: number): number {
    return this.positions[cellIndex];
  }

  /** Removes the cell whose current record has the lowest global ID. */
  pop(): number | undefined {
    if (this.entries.length === 0) {
      return undefined;
    }

    const first = this.entries[0];
    const last = this.entries.pop();
    if (last === undefined || this.entries.length === 0) {
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
        this.precedes(this.entries[rightIndex], this.entries[leftIndex])
      ) {
        childIndex = rightIndex;
      }

      if (!this.precedes(this.entries[childIndex], last)) {
        break;
      }

      this.entries[index] = this.entries[childIndex];
      index = childIndex;
    }

    this.entries[index] = last;
    return first;
  }

  /** Advances one cell and re-adds it while records remain. */
  advance(cellIndex: number): void {
    this.positions[cellIndex] += 1;
    if (this.positions[cellIndex] < this.columns[cellIndex].length) {
      this.push(cellIndex);
    }
  }

  private push(cellIndex: number): void {
    let index = this.entries.length;
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      const parent = this.entries[parentIndex];
      if (!this.precedes(cellIndex, parent)) {
        break;
      }
      this.entries[index] = parent;
      index = parentIndex;
    }
    this.entries[index] = cellIndex;
  }

  private precedes(leftCellIndex: number, rightCellIndex: number): boolean {
    const leftId =
      this.columns[leftCellIndex][this.positions[leftCellIndex]];
    const rightId =
      this.columns[rightCellIndex][this.positions[rightCellIndex]];
    return leftId < rightId ||
      (leftId === rightId && leftCellIndex < rightCellIndex);
  }
}

/** Finds one global ID in the compact sorted node-ID prefix. */
function findSortedGlobalId(
  ids: Uint32Array,
  count: number,
  globalId: number,
): number {
  let low = 0;
  let high = count - 1;

  while (low <= high) {
    const middle = (low + high) >>> 1;
    const candidate = ids[middle];
    if (candidate === globalId) {
      return middle;
    }
    if (candidate < globalId) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return -1;
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
  /** One when the node lies inside a cell whose complete data was loaded. */
  private readonly nodeInsideLoadedCell: Uint8Array;
  /** Whether the provider contract makes loaded-cell frontier checks meaningful. */
  private readonly supportsFrontierCertification: boolean;
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
    nodeInsideLoadedCell: Uint8Array,
    supportsFrontierCertification: boolean,
    segmentBuckets: Map<number, Uint32Array>,
    stats: RoutingNetworkStats,
  ) {
    this.segmentBuckets = segmentBuckets;
    this.visitedSegments = new Uint32Array(segmentStartNodes.length);
    this.routeDistances = new Float64Array(nodeX.length);
    this.routePreviousNodes = new Int32Array(nodeX.length);
    this.routeVisitedGeneration = new Uint32Array(nodeX.length);
    this.nodeInsideLoadedCell = nodeInsideLoadedCell;
    this.supportsFrontierCertification = supportsFrontierCertification;
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
      this.nodeInsideLoadedCell.byteLength +
      bucketBytes;
  }

  /**
   * Joins independently loaded cells through their global integer node IDs.
   * @param extent - Combined extent of covered corridor cells.
   * @param cells - Overlapping binary cells deduplicated through global IDs.
   * @param loadedCellKeys - Cells whose complete graph data was available.
   * @returns A fully indexed typed-array routing network.
   * @throws {NoWalkableNetworkError} When no edge is available.
   * @throws {Error} When global node coordinates conflict or an edge is invalid.
   */
  static fromCells(
    extent: Extent,
    cells: PrecomputedBinaryRoutingCell[],
    loadedCellKeys: Iterable<CellKey> = cells.map((cell) => cell.key),
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
    const temporaryGlobalNodeIds = new Uint32Array(maximumNodeReferences);
    const temporaryNodeX = new Int32Array(maximumNodeReferences);
    const temporaryNodeY = new Int32Array(maximumNodeReferences);
    const temporaryNodeZ = new Int32Array(maximumNodeReferences);
    const nodeHeap = new SortedCellIdCursorHeap(
      cells.map((cell) => cell.nodeIds),
    );
    let nodeCount = 0;
    let previousGlobalNodeId = -1;
    let sourceRoadFeatures = 0;

    for (const cell of cells) {
      sourceRoadFeatures += cell.sourceRoadFeatures;
    }

    while (nodeHeap.size > 0) {
      const cellIndex = nodeHeap.pop();
      if (cellIndex === undefined) {
        break;
      }
      const cell = cells[cellIndex];
      const recordIndex = nodeHeap.currentRecordIndex(cellIndex);
      const globalId = cell.nodeIds[recordIndex];

      if (globalId >= globalNodeCount || globalId < previousGlobalNodeId) {
        throw new Error(
          'Precomputed binary graph contains invalid or unsorted node IDs.',
        );
      }

      if (globalId === previousGlobalNodeId) {
        const existingLocalId = nodeCount - 1;
        if (
          temporaryNodeX[existingLocalId] !== cell.nodeX[recordIndex] ||
          temporaryNodeY[existingLocalId] !== cell.nodeY[recordIndex] ||
          temporaryNodeZ[existingLocalId] !== cell.nodeZ[recordIndex]
        ) {
          throw new Error(
            'Precomputed binary cells disagree on a global node coordinate.',
          );
        }
      } else {
        temporaryGlobalNodeIds[nodeCount] = globalId;
        temporaryNodeX[nodeCount] = cell.nodeX[recordIndex];
        temporaryNodeY[nodeCount] = cell.nodeY[recordIndex];
        temporaryNodeZ[nodeCount] = cell.nodeZ[recordIndex];
        previousGlobalNodeId = globalId;
        nodeCount += 1;
      }

      nodeHeap.advance(cellIndex);
    }

    const maximumEdgeReferences = cells.reduce(
      (total, cell) => total + cell.edgeIds.length,
      0,
    );
    const temporarySegmentStartNodes = new Uint32Array(maximumEdgeReferences);
    const temporarySegmentEndNodes = new Uint32Array(maximumEdgeReferences);
    const temporarySegmentCosts = new Uint32Array(maximumEdgeReferences);
    const temporarySegmentFlags = new Uint8Array(maximumEdgeReferences);
    const edgeHeap = new SortedCellIdCursorHeap(
      cells.map((cell) => cell.edgeIds),
    );
    let edgeCount = 0;
    let previousGlobalEdgeId = -1;

    while (edgeHeap.size > 0) {
      const cellIndex = edgeHeap.pop();
      if (cellIndex === undefined) {
        break;
      }
      const cell = cells[cellIndex];
      const recordIndex = edgeHeap.currentRecordIndex(cellIndex);
      const globalEdgeId = cell.edgeIds[recordIndex];
      const startNodeId = findSortedGlobalId(
        temporaryGlobalNodeIds,
        nodeCount,
        cell.edgeStartNodeIds[recordIndex],
      );
      const endNodeId = findSortedGlobalId(
        temporaryGlobalNodeIds,
        nodeCount,
        cell.edgeEndNodeIds[recordIndex],
      );
      const cost = cell.edgeCosts[recordIndex];
      const flags = cell.edgeFlags[recordIndex];

      if (
        globalEdgeId >= globalEdgeCount ||
        globalEdgeId < previousGlobalEdgeId ||
        startNodeId < 0 ||
        endNodeId < 0 ||
        startNodeId === endNodeId ||
        cost === 0 ||
        flags > 1
      ) {
        throw new Error('Precomputed binary graph contains an invalid edge.');
      }

      if (globalEdgeId === previousGlobalEdgeId) {
        const existingLocalEdge = edgeCount - 1;
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
      } else {
        temporarySegmentStartNodes[edgeCount] = startNodeId;
        temporarySegmentEndNodes[edgeCount] = endNodeId;
        temporarySegmentCosts[edgeCount] = cost;
        temporarySegmentFlags[edgeCount] = flags;
        previousGlobalEdgeId = globalEdgeId;
        edgeCount += 1;
      }

      edgeHeap.advance(cellIndex);
    }

    if (edgeCount === 0) {
      throw new NoWalkableNetworkError();
    }

    const nodeX = temporaryNodeX.slice(0, nodeCount);
    const nodeY = temporaryNodeY.slice(0, nodeCount);
    const nodeZ = temporaryNodeZ.slice(0, nodeCount);
    const supportsFrontierCertification = cells.every(
      (cell) => cell.supportsFrontierCertification === true,
    );
    const loadedCellKeySet = new Set(loadedCellKeys);
    const nodeInsideLoadedCell = new Uint8Array(nodeCount);

    if (supportsFrontierCertification) {
      for (let nodeId = 0; nodeId < nodeCount; nodeId += 1) {
        const coordinate: Coordinate = [
          nodeX[nodeId] / PRECOMPUTED_BINARY_XY_SCALE,
          nodeY[nodeId] / PRECOMPUTED_BINARY_XY_SCALE,
        ];
        nodeInsideLoadedCell[nodeId] = loadedCellKeySet.has(
          cellKeyForCoordinate(coordinate),
        )
          ? 1
          : 0;
      }
    }

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

      indexEdgeAlongSpatialGrid(
        mutableBuckets,
        edgeId,
        startX,
        startY,
        endX,
        endY,
      );
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
      nodeInsideLoadedCell,
      supportsFrontierCertification,
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
   * Calculates the least-cost route while preserving the existing public API.
   * @param startCoordinate - Requested route start in EPSG:2056.
   * @param endCoordinate - Requested route destination in EPSG:2056.
   * @returns Routed geometry and snap distances, or `null` for a normal miss.
   */
  route(
    startCoordinate: Coordinate,
    endCoordinate: Coordinate,
  ): RoutedNetworkPath | null {
    return this.routeAttempt(startCoordinate, endCoordinate).path;
  }

  /**
   * Calculates one least-cost route and records whether A* reached an incomplete
   * loaded-cell frontier while a better result was still possible.
   * @param startCoordinate - Requested route start in EPSG:2056.
   * @param endCoordinate - Requested route destination in EPSG:2056.
   * @returns The route result plus the conservative frontier diagnostic.
   */
  routeAttempt(
    startCoordinate: Coordinate,
    endCoordinate: Coordinate,
  ): RouteAttempt {
    const startSnap = this.findSnap(startCoordinate);
    const endSnap = this.findSnap(endCoordinate);

    if (!startSnap || !endSnap) {
      // A missing snap cannot be certified here because this graph does not know
      // whether every cell inside the 260 m endpoint footprint was requested.
      return { path: null, frontierReached: true };
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
    let frontierReached = !this.supportsFrontierCertification;

    while (queue.size > 0) {
      const current = queue.pop();

      if (!current) {
        break;
      }

      if (current.distance !== getDistance(current.nodeId)) {
        continue;
      }

      // Once the cheapest remaining A* priority cannot beat `bestCost`, neither
      // this node nor any queued node can invalidate the bounded-graph result.
      if (current.priority >= bestCost) {
        break;
      }

      // Complete, unclipped source features give loaded cells every edge
      // incident to their contained nodes. Expanding any other node means the
      // search may depend on neighbours omitted from the assembled graph.
      if (this.nodeInsideLoadedCell[current.nodeId] === 0) {
        frontierReached = true;
      }

      let endCost: number | undefined;
      if (current.nodeId === endSnap.startNodeId) {
        endCost = endSnap.cost * endSnap.fraction;
      }
      if (current.nodeId === endSnap.endNodeId) {
        const candidate = endSnap.cost * (1 - endSnap.fraction);
        endCost =
          endCost === undefined ? candidate : Math.min(endCost, candidate);
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
        path: {
          coordinates: directPath.coordinates,
          snapDistanceStart: startSnap.distance,
          snapDistanceEnd: endSnap.distance,
        },
        frontierReached,
      };
    }

    if (bestGoalNodeId < 0) {
      return { path: null, frontierReached };
    }

    const nodePath = reconstructRouteNodePath(
      bestGoalNodeId,
      this.nodeX.length,
      (nodeId) => {
        const previousNodeId = this.routePreviousNodes[nodeId];
        return previousNodeId >= 0 ? previousNodeId : undefined;
      },
    );
    const coordinates: Coordinate[] = [];
    appendCoordinate(coordinates, startSnap.coordinate);

    for (const pathNodeId of nodePath) {
      appendCoordinate(coordinates, this.nodeCoordinate(pathNodeId));
    }

    appendCoordinate(coordinates, endSnap.coordinate);

    return {
      path: {
        coordinates,
        snapDistanceStart: startSnap.distance,
        snapDistanceEnd: endSnap.distance,
      },
      frontierReached,
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
