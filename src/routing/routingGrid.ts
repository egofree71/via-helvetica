/**
 * Business context: converts LV95 coordinates into bounded swissTLM3D routing
 * cells. These pure helpers define the exact first-waypoint footprint and the
 * narrow or widened corridors used by the routing worker.
 */
import type { Coordinate } from 'ol/coordinate.js';
import type { Extent } from 'ol/extent.js';
import { MAX_SNAP_DISTANCE } from './routingConstants';

/** Grid-cell width and height in LV95 metres. */
const CELL_SIZE = 2_400;

/** Stable string key for one EPSG:2056 routing grid cell. */
export type CellKey = `${number}:${number}`;

/** Integer address of a routing grid cell. */
interface CellIndex {
  /** East-west grid column. */
  column: number;
  /** North-south grid row. */
  row: number;
}

/** Serializes a grid address for map and cache keys. */
function cellKey({ column, row }: CellIndex): CellKey {
  return `${column}:${row}`;
}

/** Restores a numeric grid address from its stable cache key. */
function parseCellKey(key: CellKey): CellIndex {
  const [column, row] = key.split(':').map(Number);
  return { column, row };
}

/** Maps an EPSG:2056 coordinate to its containing routing cell. */
function cellForCoordinate(coordinate: Coordinate): CellIndex {
  return {
    column: Math.floor(coordinate[0] / CELL_SIZE),
    row: Math.floor(coordinate[1] / CELL_SIZE),
  };
}

/** Returns the exact EPSG:2056 extent covered by one routing cell. */
function extentForCell(cell: CellIndex): Extent {
  const minX = cell.column * CELL_SIZE;
  const minY = cell.row * CELL_SIZE;
  return [minX, minY, minX + CELL_SIZE, minY + CELL_SIZE];
}

/** Maps an EPSG:2056 coordinate to its stable routing-cell key. */
export function cellKeyForCoordinate(coordinate: Coordinate): CellKey {
  return cellKey(cellForCoordinate(coordinate));
}

/** Returns whether a coordinate lies inside one closed axis-aligned extent. */
function coordinateIntersectsExtent(
  coordinate: Coordinate,
  extent: Extent,
): boolean {
  return (
    coordinate[0] >= extent[0] &&
    coordinate[0] <= extent[2] &&
    coordinate[1] >= extent[1] &&
    coordinate[1] <= extent[3]
  );
}

/**
 * Tests a segment against a closed rectangle with the Liang-Barsky algorithm.
 * @param startCoordinate - Segment start in EPSG:2056.
 * @param endCoordinate - Segment end in EPSG:2056.
 * @param extent - Closed axis-aligned rectangle in EPSG:2056.
 * @returns Whether the segment touches or crosses the rectangle.
 */
function segmentIntersectsExtent(
  startCoordinate: Coordinate,
  endCoordinate: Coordinate,
  extent: Extent,
): boolean {
  if (
    coordinateIntersectsExtent(startCoordinate, extent) ||
    coordinateIntersectsExtent(endCoordinate, extent)
  ) {
    return true;
  }

  const deltaX = endCoordinate[0] - startCoordinate[0];
  const deltaY = endCoordinate[1] - startCoordinate[1];
  const boundaries = [
    [-deltaX, startCoordinate[0] - extent[0]],
    [deltaX, extent[2] - startCoordinate[0]],
    [-deltaY, startCoordinate[1] - extent[1]],
    [deltaY, extent[3] - startCoordinate[1]],
  ] as const;
  let minimumFraction = 0;
  let maximumFraction = 1;

  for (const [direction, distance] of boundaries) {
    if (direction === 0) {
      if (distance < 0) {
        return false;
      }
      continue;
    }

    const fraction = distance / direction;
    if (direction < 0) {
      minimumFraction = Math.max(minimumFraction, fraction);
    } else {
      maximumFraction = Math.min(maximumFraction, fraction);
    }

    if (minimumFraction > maximumFraction) {
      return false;
    }
  }

  return true;
}

/** Returns the squared distance from one point to a closed rectangle. */
function squaredDistanceToExtent(
  coordinate: Coordinate,
  extent: Extent,
): number {
  const deltaX = Math.max(
    extent[0] - coordinate[0],
    0,
    coordinate[0] - extent[2],
  );
  const deltaY = Math.max(
    extent[1] - coordinate[1],
    0,
    coordinate[1] - extent[3],
  );
  return deltaX * deltaX + deltaY * deltaY;
}

/** Returns the squared distance from one point to a finite segment. */
function squaredDistanceToSegment(
  coordinate: Coordinate,
  startCoordinate: Coordinate,
  endCoordinate: Coordinate,
): number {
  const deltaX = endCoordinate[0] - startCoordinate[0];
  const deltaY = endCoordinate[1] - startCoordinate[1];
  const squaredLength = deltaX * deltaX + deltaY * deltaY;

  if (squaredLength === 0) {
    const pointDeltaX = coordinate[0] - startCoordinate[0];
    const pointDeltaY = coordinate[1] - startCoordinate[1];
    return pointDeltaX * pointDeltaX + pointDeltaY * pointDeltaY;
  }

  const fraction = Math.max(
    0,
    Math.min(
      1,
      ((coordinate[0] - startCoordinate[0]) * deltaX +
        (coordinate[1] - startCoordinate[1]) * deltaY) /
        squaredLength,
    ),
  );
  const projectedX = startCoordinate[0] + fraction * deltaX;
  const projectedY = startCoordinate[1] + fraction * deltaY;
  const pointDeltaX = coordinate[0] - projectedX;
  const pointDeltaY = coordinate[1] - projectedY;
  return pointDeltaX * pointDeltaX + pointDeltaY * pointDeltaY;
}

/**
 * Calculates the exact squared distance between a segment and one cell extent.
 * Intersections return zero; otherwise the nearest pair must involve either a
 * segment endpoint or one rectangle corner because both shapes are convex.
 */
function squaredSegmentToExtentDistance(
  startCoordinate: Coordinate,
  endCoordinate: Coordinate,
  extent: Extent,
): number {
  if (segmentIntersectsExtent(startCoordinate, endCoordinate, extent)) {
    return 0;
  }

  const corners: Coordinate[] = [
    [extent[0], extent[1]],
    [extent[0], extent[3]],
    [extent[2], extent[1]],
    [extent[2], extent[3]],
  ];
  let minimumSquaredDistance = Math.min(
    squaredDistanceToExtent(startCoordinate, extent),
    squaredDistanceToExtent(endCoordinate, extent),
  );

  for (const corner of corners) {
    minimumSquaredDistance = Math.min(
      minimumSquaredDistance,
      squaredDistanceToSegment(corner, startCoordinate, endCoordinate),
    );
  }

  return minimumSquaredDistance;
}

/** Returns the exact LV95 extent represented by a serialized cell key. */
export function extentForCellKey(key: CellKey): Extent {
  return extentForCell(parseCellKey(key));
}

/** Adds a square neighbourhood around one cell to a set of required cells. */
function addExpandedCell(
  cells: Set<CellKey>,
  cell: CellIndex,
  radius: number,
): void {
  for (let columnOffset = -radius; columnOffset <= radius; columnOffset += 1) {
    for (let rowOffset = -radius; rowOffset <= radius; rowOffset += 1) {
      cells.add(
        cellKey({
          column: cell.column + columnOffset,
          row: cell.row + rowOffset,
        }),
      );
    }
  }
}

/**
 * Returns each grid cell crossed by a segment using an integer line walk.
 * Expanding those cells creates a corridor without downloading the complete
 * bounding rectangle between distant waypoints.
 * @param startCoordinate - Segment start in EPSG:2056.
 * @param endCoordinate - Segment end in EPSG:2056.
 * @returns Ordered grid cells crossed from start to end, both included.
 */
function cellsAlongSegment(
  startCoordinate: Coordinate,
  endCoordinate: Coordinate,
): CellIndex[] {
  const start = cellForCoordinate(startCoordinate);
  const end = cellForCoordinate(endCoordinate);
  const cells: CellIndex[] = [];
  let column = start.column;
  let row = start.row;
  const deltaColumn = Math.abs(end.column - start.column);
  const deltaRow = Math.abs(end.row - start.row);
  const stepColumn = start.column < end.column ? 1 : -1;
  const stepRow = start.row < end.row ? 1 : -1;
  let error = deltaColumn - deltaRow;

  while (true) {
    cells.push({ column, row });

    if (column === end.column && row === end.row) {
      break;
    }

    const doubledError = error * 2;

    if (doubledError > -deltaRow) {
      error -= deltaRow;
      column += stepColumn;
    }

    if (doubledError < deltaColumn) {
      error += deltaColumn;
      row += stepRow;
    }
  }

  return cells;
}

/**
 * Returns only cells whose closed extent intersects the maximum snapping box
 * around a first waypoint. This normally yields one cell, two near an edge, or
 * four near a corner.
 * @param coordinate - First route click in EPSG:2056.
 * @returns Cells intersecting the complete closed snapping box.
 */
export function createLocalCellKeys(coordinate: Coordinate): Set<CellKey> {
  const minX = coordinate[0] - MAX_SNAP_DISTANCE;
  const minY = coordinate[1] - MAX_SNAP_DISTANCE;
  const maxX = coordinate[0] + MAX_SNAP_DISTANCE;
  const maxY = coordinate[1] + MAX_SNAP_DISTANCE;

  // The closed box must include both cells when one edge lands exactly on a
  // shared boundary.
  const minColumn = Math.ceil(minX / CELL_SIZE) - 1;
  const minRow = Math.ceil(minY / CELL_SIZE) - 1;
  const maxColumn = Math.floor(maxX / CELL_SIZE);
  const maxRow = Math.floor(maxY / CELL_SIZE);
  const cells = new Set<CellKey>();

  for (let column = minColumn; column <= maxColumn; column += 1) {
    for (let row = minRow; row <= maxRow; row += 1) {
      cells.add(cellKey({ column, row }));
    }
  }

  return cells;
}

/**
 * Creates an expanded routing corridor around cells crossed by a segment.
 * @param startCoordinate - Corridor start in EPSG:2056.
 * @param endCoordinate - Corridor end in EPSG:2056.
 * @param radius - Number of neighbouring cells added on every side.
 * @returns Stable set of required routing-cell keys.
 */
export function createCorridorCellKeys(
  startCoordinate: Coordinate,
  endCoordinate: Coordinate,
  radius: number,
): Set<CellKey> {
  const cells = new Set<CellKey>();

  for (const cell of cellsAlongSegment(startCoordinate, endCoordinate)) {
    addExpandedCell(cells, cell, radius);
  }

  return cells;
}

/**
 * Returns cells whose closed extent lies within a metric halo around a segment.
 * The capsule test avoids loading the distant corners of the segment's expanded
 * bounding rectangle, especially for long diagonal route sections.
 * @param startCoordinate - Segment start in EPSG:2056.
 * @param endCoordinate - Segment end in EPSG:2056.
 * @param marginMetres - Required perpendicular halo in LV95 metres.
 * @returns Stable set of routing-cell keys intersecting the buffered segment.
 * @throws {RangeError} When the margin is negative or not finite.
 */
export function createSegmentEnvelopeCellKeys(
  startCoordinate: Coordinate,
  endCoordinate: Coordinate,
  marginMetres: number,
): Set<CellKey> {
  if (!Number.isFinite(marginMetres) || marginMetres < 0) {
    throw new RangeError(
      'Routing envelope margin must be a non-negative number.',
    );
  }

  const minX = Math.min(startCoordinate[0], endCoordinate[0]) - marginMetres;
  const minY = Math.min(startCoordinate[1], endCoordinate[1]) - marginMetres;
  const maxX = Math.max(startCoordinate[0], endCoordinate[0]) + marginMetres;
  const maxY = Math.max(startCoordinate[1], endCoordinate[1]) + marginMetres;

  // Closed extents intentionally retain both neighbours when the capsule only
  // touches a shared cell boundary. This matches first-waypoint snap coverage.
  const minColumn = Math.ceil(minX / CELL_SIZE) - 1;
  const minRow = Math.ceil(minY / CELL_SIZE) - 1;
  const maxColumn = Math.floor(maxX / CELL_SIZE);
  const maxRow = Math.floor(maxY / CELL_SIZE);
  const marginSquared = marginMetres * marginMetres;
  const cells = new Set<CellKey>();

  for (let column = minColumn; column <= maxColumn; column += 1) {
    for (let row = minRow; row <= maxRow; row += 1) {
      const cell = { column, row };

      if (
        squaredSegmentToExtentDistance(
          startCoordinate,
          endCoordinate,
          extentForCell(cell),
        ) <= marginSquared
      ) {
        cells.add(cellKey(cell));
      }
    }
  }

  return cells;
}

/**
 * Calculates the outer extent of a non-empty cell set.
 * @param cellKeys - Routing cells whose full bounds must be covered.
 * @returns Combined EPSG:2056 extent.
 */
export function combinedExtent(cellKeys: Set<CellKey>): Extent {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const key of cellKeys) {
    const [cellMinX, cellMinY, cellMaxX, cellMaxY] = extentForCell(
      parseCellKey(key),
    );
    minX = Math.min(minX, cellMinX);
    minY = Math.min(minY, cellMinY);
    maxX = Math.max(maxX, cellMaxX);
    maxY = Math.max(maxY, cellMaxY);
  }

  return [minX, minY, maxX, maxY];
}
