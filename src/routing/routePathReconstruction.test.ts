/**
 * Business context: verifies that A* predecessor reconstruction remains safe
 * when reusable routing state is stale or corrupted.
 */
import { describe, expect, it } from 'vitest';
import { reconstructRouteNodePath } from './routePathReconstruction';

describe('reconstructRouteNodePath', () => {
  it('returns the graph-node chain in root-to-goal order', () => {
    const predecessors = new Map<number, number>([
      [3, 2],
      [2, 1],
      [1, 0],
    ]);

    expect(
      reconstructRouteNodePath(3, 4, (nodeId) => predecessors.get(nodeId)),
    ).toEqual([0, 1, 2, 3]);
  });

  it('rejects a cyclic predecessor chain instead of looping indefinitely', () => {
    const predecessors = new Map<number, number>([
      [2, 1],
      [1, 2],
    ]);

    expect(() =>
      reconstructRouteNodePath(2, 3, (nodeId) => predecessors.get(nodeId)),
    ).toThrow('cyclic or exceeds the graph size');
  });

  it('rejects a predecessor outside the assembled graph', () => {
    expect(() =>
      reconstructRouteNodePath(1, 2, (nodeId) =>
        nodeId === 1 ? 99 : undefined,
      ),
    ).toThrow('invalid graph node');
  });
});
