/**
 * Business context: protects the bounded LV95 cell footprints used by the
 * routing worker. A regression here can silently over-fetch GeoAdmin data or
 * omit cells required for snapping and corridor routing.
 */
import { describe, expect, it } from 'vitest';
import {
  cellKeyForCoordinate,
  combinedExtent,
  createCorridorCellKeys,
  createLocalCellKeys,
  createSegmentEnvelopeCellKeys,
  extentForCellKey,
} from './routingGrid';

/** Returns deterministic sorted keys for readable grid assertions. */
function sortedKeys(keys: Set<string>): string[] {
  return [...keys].sort();
}

describe('routingGrid', () => {
  it('keeps the first-waypoint footprint to one, two, or four intersecting cells', () => {
    expect(sortedKeys(createLocalCellKeys([1_200, 1_200]))).toEqual(['0:0']);
    expect(sortedKeys(createLocalCellKeys([2_300, 1_200]))).toEqual([
      '0:0',
      '1:0',
    ]);
    expect(sortedKeys(createLocalCellKeys([2_300, 2_300]))).toEqual([
      '0:0',
      '0:1',
      '1:0',
      '1:1',
    ]);
  });

  it('maps coordinates to stable cell keys on both sides of the LV95 origin', () => {
    expect(cellKeyForCoordinate([2_399, 2_399])).toBe('0:0');
    expect(cellKeyForCoordinate([2_400, 2_400])).toBe('1:1');
    expect(cellKeyForCoordinate([-1, -1])).toBe('-1:-1');
  });

  it('keeps a short metric envelope inside its containing cell', () => {
    expect(
      sortedKeys(
        createSegmentEnvelopeCellKeys([1_200, 1_200], [1_300, 1_200], 400),
      ),
    ).toEqual(['0:0']);
  });

  it('includes neighbouring cells touched by a closed metric envelope', () => {
    expect(
      sortedKeys(
        createSegmentEnvelopeCellKeys([1_200, 1_200], [1_200, 1_200], 1_200),
      ),
    ).toEqual(['-1:0', '0:-1', '0:0', '0:1', '1:0']);
  });

  it('includes all four cells when a point envelope reaches a shared corner', () => {
    expect(
      sortedKeys(
        createSegmentEnvelopeCellKeys([2_300, 2_300], [2_300, 2_300], 150),
      ),
    ).toEqual(['0:0', '0:1', '1:0', '1:1']);
  });

  it('keeps diagonal envelopes out of distant bounding-box corners', () => {
    const keys = createSegmentEnvelopeCellKeys(
      [1_200, 1_200],
      [6_000, 6_000],
      100,
    );

    expect(keys).toContain('0:0');
    expect(keys).toContain('1:1');
    expect(keys).toContain('2:2');
    expect(keys).not.toContain('0:2');
    expect(keys).not.toContain('2:0');
  });

  it('rejects invalid metric-envelope margins', () => {
    expect(() =>
      createSegmentEnvelopeCellKeys([0, 0], [1, 1], -1),
    ).toThrow(RangeError);
    expect(() =>
      createSegmentEnvelopeCellKeys([0, 0], [1, 1], Number.NaN),
    ).toThrow(RangeError);
  });

  it('walks every cell crossed by a horizontal segment before expansion', () => {
    expect(
      sortedKeys(createCorridorCellKeys([1_200, 1_200], [6_000, 1_200], 0)),
    ).toEqual(['0:0', '1:0', '2:0']);
  });

  it('expands a three-cell corridor by one cell without filling a large bounding box', () => {
    const keys = createCorridorCellKeys([1_200, 1_200], [6_000, 1_200], 1);

    expect(keys.size).toBe(15);
    expect(keys).toContain('-1:-1');
    expect(keys).toContain('3:1');
    expect(keys).not.toContain('4:0');
  });

  it('handles negative cell indices and combines exact cell extents', () => {
    expect(extentForCellKey('-1:2')).toEqual([-2_400, 4_800, 0, 7_200]);
    expect(combinedExtent(new Set(['-1:0', '1:2']))).toEqual([
      -2_400,
      0,
      4_800,
      7_200,
    ]);
  });
});
