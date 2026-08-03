/**
 * Business context: protects the plain-data route contract returned across the
 * dedicated Worker boundary without contacting live GeoAdmin services.
 */
import { describe, expect, it } from 'vitest';
import { RoutingNetwork } from './networkRouter';
import { compilePrecomputedRoutingGraph } from './precomputedRoutingGraph';
import type { SwissTlmNetworkData } from './swissTlmApi';

/** Creates a small connected path whose endpoints require graph traversal. */
function createTestNetwork(): RoutingNetwork {
  const data: SwissTlmNetworkData = {
    roads: [
      {
        id: 'test-road',
        lines: [
          [
            [0, 0],
            [100, 0],
            [200, 0],
          ],
        ],
        attributes: { objectType: 16 },
      },
    ],
    hikingTrails: [],
  };

  return RoutingNetwork.fromSwissTlm([-100, -100, 300, 100], data);
}

describe('RoutingNetwork route result', () => {
  it('returns a structured-clone-safe plain-data route result', () => {
    const route = createTestNetwork().route([10, 2], [190, -2]);

    expect(route).not.toBeNull();
    expect(structuredClone(route)).toEqual(route);
  });

  it('uses a precomputed road hiking flag without separate overlay geometry', () => {
    const network = RoutingNetwork.fromSwissTlm([-100, -100, 300, 100], {
      roads: [
        {
          id: 'preclassified-hiking-road',
          lines: [
            [
              [0, 0],
              [100, 0],
            ],
          ],
          attributes: { objectType: 16 },
          isHikingTrail: true,
        },
      ],
      hikingTrails: [],
    });

    expect(network.stats.hikingSegments).toBe(1);
  });

  it('uses geometry to break equidistant snapping ties deterministically', () => {
    const lower = {
      id: 'lower',
      lines: [[[0, -1], [100, -1]]],
      attributes: { objectType: 16 },
    };
    const upper = {
      id: 'upper',
      lines: [[[0, 1], [100, 1]]],
      attributes: { objectType: 16 },
    };
    const first = RoutingNetwork.fromSwissTlm([-10, -10, 110, 10], {
      roads: [upper, lower],
      hikingTrails: [],
    });
    const second = RoutingNetwork.fromSwissTlm([-10, -10, 110, 10], {
      roads: [lower, upper],
      hikingTrails: [],
    });

    expect(first.snap([50, 0])?.slice(0, 2)).toEqual([50, -1]);
    expect(second.snap([50, 0])?.slice(0, 2)).toEqual([50, -1]);
  });

  it('returns the same route from live and offline-compiled graph data', () => {
    const data: SwissTlmNetworkData = {
      roads: [
        {
          id: 'shared-compiler-road',
          lines: [
            [
              [0, 0, 400],
              [100, 0, 401],
              [200, 0, 402],
            ],
          ],
          attributes: { objectType: 16 },
          isHikingTrail: true,
        },
      ],
      hikingTrails: [],
    };
    const extent = [-100, -100, 300, 100];
    const liveRoute = RoutingNetwork.fromSwissTlm(extent, data).route(
      [10, 2],
      [190, -2],
    );
    const precomputedRoute = RoutingNetwork.fromPrecomputed(extent, [
      compilePrecomputedRoutingGraph(data),
    ]).route([10, 2], [190, -2]);

    expect(precomputedRoute).toEqual(liveRoute);
  });


  it('joins a route through a node shared by neighbouring graph fragments', () => {
    const firstFragment = compilePrecomputedRoutingGraph({
      roads: [
        {
          id: 'west',
          lines: [[[0, 0, 400], [100, 0, 401]]],
          attributes: { objectType: 16 },
        },
      ],
      hikingTrails: [],
    });
    const secondFragment = compilePrecomputedRoutingGraph({
      roads: [
        {
          id: 'east',
          lines: [[[100, 0, 401], [200, 0, 402]]],
          attributes: { objectType: 16 },
        },
      ],
      hikingTrails: [],
    });
    const network = RoutingNetwork.fromPrecomputed(
      [-100, -100, 300, 100],
      [firstFragment, secondFragment],
    );

    expect(network.stats.nodes).toBe(3);
    const route = network.route([10, 1], [190, -1]);
    expect(route).not.toBeNull();
    expect(route?.coordinates).toContainEqual([100, 0, 401]);
  });

  it('matches one-corridor compilation when overlapping cells duplicate features', () => {
    const data: SwissTlmNetworkData = {
      roads: [
        {
          id: 'cross-cell-road',
          lines: [[[0, 0, 400], [100, 0, 401], [200, 0, 402]]],
          attributes: { objectType: 16, restriction: 300 },
          isHikingTrail: true,
        },
        {
          id: 'branch',
          lines: [[[100, 0, 401], [100, 100, 410]]],
          attributes: { objectType: 15 },
        },
      ],
      hikingTrails: [],
    };
    const oneFragment = compilePrecomputedRoutingGraph(data);
    const duplicatedFragments = [
      compilePrecomputedRoutingGraph({
        roads: [data.roads[0], data.roads[1]],
        hikingTrails: [],
      }),
      compilePrecomputedRoutingGraph({
        roads: [data.roads[0]],
        hikingTrails: [],
      }),
    ];
    const extent = [-100, -100, 300, 200];
    const reference = RoutingNetwork.fromPrecomputed(extent, [oneFragment]);
    const tiled = RoutingNetwork.fromPrecomputed(extent, duplicatedFragments);

    expect(tiled.stats.nodes).toBe(reference.stats.nodes);
    expect(tiled.stats.segments).toBe(reference.stats.segments);
    expect(tiled.route([10, 2], [98, 90])).toEqual(
      reference.route([10, 2], [98, 90]),
    );
  });
});
