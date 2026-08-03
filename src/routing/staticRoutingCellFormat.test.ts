/**
 * Business context: protects the geometry-cell parser shared by the browser and
 * offline graph generator, including the safeguard against synthetic shortcuts.
 */
import { describe, expect, it } from 'vitest';
import { readStaticRoutingCell } from './staticRoutingCellFormat';

describe('static routing cell contract', () => {
  it('normalizes finite attributes and hiking classification', () => {
    const cell = readStaticRoutingCell(
      {
        v: 2,
        k: '1:2',
        e: [2_400, 4_800, 4_800, 7_200],
        r: [
          {
            i: 'road-1',
            l: [[[0, 0, 400], [100, 0, 401]]],
            a: [16, 300, 200, 300],
            h: 1,
          },
        ],
      },
      '1:2',
    );

    expect(cell.roads).toEqual([
      {
        id: 'road-1',
        lines: [[[0, 0, 400], [100, 0, 401]]],
        attributes: {
          objectType: 16,
          restriction: 300,
          surface: 200,
          importance: 300,
        },
        isHikingTrail: true,
      },
    ]);
  });

  it('splits a line at an invalid midpoint instead of creating a shortcut', () => {
    const cell = readStaticRoutingCell(
      {
        v: 2,
        k: '1:2',
        e: [2_400, 4_800, 4_800, 7_200],
        r: [
          {
            i: 'road-1',
            l: [
              [
                [0, 0],
                [100, 0],
                [Number.NaN, 0],
                [300, 0],
                [400, 0],
              ],
            ],
            a: [],
          },
        ],
      },
      '1:2',
    );

    expect(cell.roads[0].lines).toEqual([
      [[0, 0], [100, 0]],
      [[300, 0], [400, 0]],
    ]);
  });

  it('rejects malformed roads rather than silently changing generator input', () => {
    expect(() =>
      readStaticRoutingCell(
        {
          v: 2,
          k: '1:2',
          e: [2_400, 4_800, 4_800, 7_200],
          r: [{ i: 'road-1', l: [[[0, 0]]], a: [] }],
        },
        '1:2',
      ),
    ).toThrow('invalid roads');
  });
});
