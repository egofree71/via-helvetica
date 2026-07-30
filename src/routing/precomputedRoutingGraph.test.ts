/**
 * Business context: protects the pure compiler shared by live geometry routing
 * and offline graph generation, so the two provider modes cannot silently use
 * different walkability, cost, hiking, or 3D-node rules.
 */
import { describe, expect, it } from 'vitest';
import {
  compilePrecomputedRoutingGraph,
  MIN_ROUTING_COST_FACTOR,
} from './precomputedRoutingGraph';

describe('compilePrecomputedRoutingGraph', () => {
  it('precomputes final hiking cost and globally keyed nodes', () => {
    const graph = compilePrecomputedRoutingGraph({
      roads: [
        {
          id: 'hiking-road',
          lines: [
            [
              [2_500_000, 1_118_000, 410],
              [2_500_100, 1_118_000, 412],
            ],
          ],
          attributes: { objectType: 16 },
          isHikingTrail: true,
        },
      ],
      hikingTrails: [],
    });

    expect(graph.nodes).toHaveLength(2);
    expect(graph.nodes[0].key).toContain(':');
    expect(graph.segments).toEqual([
      expect.objectContaining({
        cost: 64.8,
        isHikingTrail: true,
      }),
    ]);
  });

  it('keeps equal horizontal endpoints separate at different elevations', () => {
    const graph = compilePrecomputedRoutingGraph({
      roads: [
        {
          id: 'lower-road',
          lines: [
            [
              [0, 0, 400],
              [100, 0, 400],
            ],
          ],
          attributes: { objectType: 16 },
        },
        {
          id: 'bridge',
          lines: [
            [
              [0, 0, 410],
              [0, 100, 410],
            ],
          ],
          attributes: { objectType: 16 },
        },
      ],
      hikingTrails: [],
    });

    expect(graph.nodes).toHaveLength(4);
    expect(new Set(graph.nodes.map((node) => node.key)).size).toBe(4);
  });

  it('removes roads that are never walkable', () => {
    const graph = compilePrecomputedRoutingGraph({
      roads: [
        {
          id: 'motorway',
          lines: [
            [
              [0, 0],
              [100, 0],
            ],
          ],
          attributes: { objectType: 2 },
        },
      ],
      hikingTrails: [],
    });

    expect(graph.segments).toEqual([]);
  });

  it('does not emit orphan nodes for excluded roads', () => {
    const graph = compilePrecomputedRoutingGraph({
      roads: [
        {
          id: 'motorway',
          lines: [[[0, 0, 400], [100, 0, 401]]],
          attributes: { objectType: 2 },
        },
      ],
      hikingTrails: [],
    });

    expect(graph.nodes).toEqual([]);
    expect(graph.segments).toEqual([]);
  });

  it('keeps 2D and 3D identities separate until live Z coverage is verified', () => {
    const graph = compilePrecomputedRoutingGraph({
      roads: [
        {
          id: '2d-road',
          lines: [[[0, 0], [100, 0]]],
          attributes: { objectType: 16 },
        },
        {
          id: '3d-road',
          lines: [[[0, 0, 400], [0, 100, 400]]],
          attributes: { objectType: 16 },
        },
      ],
      hikingTrails: [],
    });

    expect(graph.nodes).toHaveLength(4);
  });

  it('keeps every observed finite cost factor above the A-star lower bound', () => {
    const objectTypes = [4, 8, 9, 10, 11, 12, 15, 16, 17, 18, 19, 20, 23];
    const restrictions = [undefined, 300, 400, 1_000, 1_200];
    const surfaces = [undefined, 100, 200];
    const importances = [undefined, 200, 300];
    let minimumFactor = Number.POSITIVE_INFINITY;

    for (const objectType of objectTypes) {
      for (const restriction of restrictions) {
        for (const surface of surfaces) {
          for (const importance of importances) {
            for (const isHikingTrail of [false, true]) {
              const graph = compilePrecomputedRoutingGraph({
                roads: [
                  {
                    id: 'factor-probe',
                    lines: [[[0, 0], [100, 0]]],
                    attributes: {
                      objectType,
                      restriction,
                      surface,
                      importance,
                    },
                    isHikingTrail,
                  },
                ],
                hikingTrails: [],
              });
              const segment = graph.segments[0];
              if (segment) {
                minimumFactor = Math.min(minimumFactor, segment.cost / 100);
              }
            }
          }
        }
      }
    }

    expect(minimumFactor).toBeGreaterThanOrEqual(MIN_ROUTING_COST_FACTOR);
  });
});
