/**
 * Business context: protects local route reshaping around moved, inserted, and
 * deleted waypoints. The editor must rebuild only affected sections, preserve
 * exact waypoints, and fall back to straight geometry when swissTLM3D routing
 * has no usable path.
 */
import type { Coordinate } from 'ol/coordinate.js';
import { describe, expect, it, vi } from 'vitest';
import type { DynamicRoutingNetworkLoader } from './dynamicRoutingNetwork';
import {
  connectRoutedSegmentEndpoint,
  createStraightRouteClosure,
  createStraightRouteStep,
  rebuildFixedRouteSection,
  rebuildRouteAfterWaypointDeletion,
  rebuildRouteAfterWaypointInsertion,
  rebuildRouteAfterWaypointMove,
  requestNetworkRouteSection,
} from './routeEditing';
import { RouteSectionTooLongError } from './routeSectionLimit';
import type { RouteSection, RouteState } from '../map/routeState';

/** Creates a test loader with independently controlled snap and route results. */
function createRoutingLoader(options?: {
  snapCoordinate?: Coordinate | null;
  routedCoordinates?: Coordinate[] | null;
}): {
  loader: DynamicRoutingNetworkLoader;
  snap: ReturnType<typeof vi.fn>;
  route: ReturnType<typeof vi.fn>;
} {
  const snap = vi.fn(async () => options?.snapCoordinate ?? null);
  const route = vi.fn(async () => {
    const coordinates = options?.routedCoordinates;

    if (!coordinates) {
      return null;
    }

    return {
      coordinates,
      snapDistanceStart: 0,
      snapDistanceEnd: 0,
    };
  });

  return {
    loader: { snap, route } as unknown as DynamicRoutingNetworkLoader,
    snap,
    route,
  };
}

function generatedSection(
  coordinates: Coordinate[],
  mode: 'straight' | 'network' = 'straight',
): RouteSection {
  return {
    origin: 'generated',
    mode,
    coordinates,
  };
}

function createThreePointRoute(closed = false): RouteState {
  return {
    steps: [
      { waypoint: [0, 0], section: null },
      {
        waypoint: [10, 0],
        section: generatedSection([
          [0, 0],
          [10, 0],
        ]),
      },
      {
        waypoint: [20, 0],
        section: generatedSection([
          [10, 0],
          [20, 0],
        ]),
      },
    ],
    closure: closed
      ? generatedSection([
          [20, 0],
          [0, 0],
        ])
      : null,
  };
}

describe('routeEditing', () => {
  it('creates independent straight steps and loop closures', () => {
    const coordinate: Coordinate = [10, 5];
    const firstStep = createStraightRouteStep(undefined, coordinate);
    coordinate[0] = 99;
    const secondStep = createStraightRouteStep(firstStep, [20, 5]);

    expect(firstStep).toEqual({
      waypoint: [10, 5],
      section: null,
    });
    expect(secondStep.section).toEqual(
      generatedSection([
        [10, 5],
        [20, 5],
      ]),
    );
    expect(createStraightRouteClosure([firstStep, secondStep])).toEqual(
      generatedSection([
        [20, 5],
        [10, 5],
      ]),
    );
  });

  it('adds exact endpoint connectors only when snapping leaves a visible gap', () => {
    const segment: Coordinate[] = [
      [1, 0],
      [9, 0],
    ];

    connectRoutedSegmentEndpoint(segment, [0, 0], 'start');
    connectRoutedSegmentEndpoint(segment, [10, 0], 'end');
    connectRoutedSegmentEndpoint(segment, [10.05, 0], 'end');

    expect(segment).toEqual([
      [0, 0],
      [1, 0],
      [9, 0],
      [10, 0],
    ]);
  });

  it('preserves network geometry and connects it to exact fixed endpoints', async () => {
    const { loader, route } = createRoutingLoader({
      routedCoordinates: [
        [1, 1],
        [9, 1],
      ],
    });

    await expect(
      rebuildFixedRouteSection(
        [0, 0],
        [10, 0],
        'network',
        loader,
        new AbortController().signal,
      ),
    ).resolves.toEqual(
      generatedSection(
        [
          [0, 0],
          [1, 1],
          [9, 1],
          [10, 0],
        ],
        'network',
      ),
    );
    expect(route).toHaveBeenCalledOnce();
  });

  it('rejects an overlong network section before invoking the routing loader', async () => {
    const { loader, route } = createRoutingLoader({
      routedCoordinates: [
        [0, 0],
        [16_000, 0],
      ],
    });

    await expect(
      requestNetworkRouteSection(
        [0, 0],
        [16_000, 0],
        loader,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(RouteSectionTooLongError);
    expect(route).not.toHaveBeenCalled();
  });

  it('keeps overlong straight sections available without routing work', async () => {
    const { loader, route } = createRoutingLoader();

    await expect(
      rebuildFixedRouteSection(
        [0, 0],
        [16_000, 0],
        'straight',
        loader,
        new AbortController().signal,
      ),
    ).resolves.toEqual(
      generatedSection([
        [0, 0],
        [16_000, 0],
      ]),
    );
    expect(route).not.toHaveBeenCalled();
  });

  it('falls back to an exact straight section when routing has no path', async () => {
    const { loader } = createRoutingLoader({ routedCoordinates: null });

    await expect(
      rebuildFixedRouteSection(
        [0, 0],
        [10, 0],
        'network',
        loader,
        new AbortController().signal,
      ),
    ).resolves.toEqual(
      generatedSection([
        [0, 0],
        [10, 0],
      ]),
    );
  });

  it('moves a middle waypoint while preserving unrelated geometry and closure', async () => {
    const state = createThreePointRoute(true);
    const originalSnapshot = structuredClone(state);
    const { loader, route, snap } = createRoutingLoader();

    const rebuilt = await rebuildRouteAfterWaypointMove(
      state,
      1,
      [10, 5],
      'straight',
      loader,
      new AbortController().signal,
    );

    expect(rebuilt.steps[0]).toBe(state.steps[0]);
    expect(rebuilt.steps[1].section?.coordinates).toEqual([
      [0, 0],
      [10, 5],
    ]);
    expect(rebuilt.steps[2].section?.coordinates).toEqual([
      [10, 5],
      [20, 0],
    ]);
    expect(rebuilt.closure).toBe(state.closure);
    expect(route).not.toHaveBeenCalled();
    expect(snap).not.toHaveBeenCalled();
    expect(state).toEqual(originalSnapshot);
  });

  it('rebuilds the loop closure when a closed-route endpoint moves', async () => {
    const state = createThreePointRoute(true);
    const { loader } = createRoutingLoader();

    const rebuilt = await rebuildRouteAfterWaypointMove(
      state,
      0,
      [0, 5],
      'straight',
      loader,
      new AbortController().signal,
    );

    expect(rebuilt.steps[0].waypoint).toEqual([0, 5]);
    expect(rebuilt.steps[1].section?.coordinates).toEqual([
      [0, 5],
      [10, 0],
    ]);
    expect(rebuilt.closure?.coordinates).toEqual([
      [20, 0],
      [0, 5],
    ]);
  });

  it('inserts a waypoint by replacing one section with two generated sections', async () => {
    const state = createThreePointRoute();
    const { loader } = createRoutingLoader();

    const rebuilt = await rebuildRouteAfterWaypointInsertion(
      state,
      2,
      [15, 5],
      'straight',
      loader,
      new AbortController().signal,
    );

    expect(rebuilt.steps.map((step) => step.waypoint)).toEqual([
      [0, 0],
      [10, 0],
      [15, 5],
      [20, 0],
    ]);
    expect(rebuilt.steps[2].section?.coordinates).toEqual([
      [10, 0],
      [15, 5],
    ]);
    expect(rebuilt.steps[3].section?.coordinates).toEqual([
      [15, 5],
      [20, 0],
    ]);
    expect(rebuilt.steps[2].section?.origin).toBe('generated');
  });

  it('deletes a middle generated waypoint and reconnects neighbours with the chosen mode', async () => {
    const state = createThreePointRoute();
    const { loader, route } = createRoutingLoader({
      routedCoordinates: [
        [0.2, 0],
        [19.8, 0],
      ],
    });

    const rebuilt = await rebuildRouteAfterWaypointDeletion(
      state,
      1,
      'network',
      loader,
      new AbortController().signal,
    );

    expect(rebuilt.steps.map((step) => step.waypoint)).toEqual([
      [0, 0],
      [20, 0],
    ]);
    expect(rebuilt.steps[1]).toEqual({
      waypoint: [20, 0],
      section: generatedSection(
        [
          [0, 0],
          [0.2, 0],
          [19.8, 0],
          [20, 0],
        ],
        'network',
      ),
    });
    expect(route).toHaveBeenCalledOnce();
  });

  it('deletes an imported editing anchor by merging original geometry without routing', async () => {
    const state: RouteState = {
      steps: [
        { waypoint: [0, 0], section: null },
        {
          waypoint: [10, 0],
          section: {
            origin: 'imported',
            coordinates: [
              [0, 0],
              [5, 1],
              [10, 0],
            ],
          },
        },
        {
          waypoint: [20, 0],
          section: {
            origin: 'imported',
            coordinates: [
              [10, 0],
              [15, -1],
              [20, 0],
            ],
          },
        },
      ],
      closure: null,
    };
    const { loader, route } = createRoutingLoader();

    const rebuilt = await rebuildRouteAfterWaypointDeletion(
      state,
      1,
      'network',
      loader,
      new AbortController().signal,
    );

    expect(rebuilt.steps[1].section).toEqual({
      origin: 'imported',
      coordinates: [
        [0, 0],
        [5, 1],
        [10, 0],
        [15, -1],
        [20, 0],
      ],
    });
    expect(route).not.toHaveBeenCalled();
  });

  it('rejects moving a waypoint when an affected network section exceeds the limit', async () => {
    const state = createThreePointRoute();
    const { loader, route } = createRoutingLoader();

    await expect(
      rebuildRouteAfterWaypointMove(
        state,
        1,
        [16_000, 0],
        'network',
        loader,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(RouteSectionTooLongError);
    expect(route).not.toHaveBeenCalled();
  });

  it('rejects insertion before routing a valid first half when the second is overlong', async () => {
    const state: RouteState = {
      steps: [
        { waypoint: [0, 0], section: null },
        {
          waypoint: [10, 0],
          section: generatedSection([
            [0, 0],
            [10, 0],
          ]),
        },
        {
          waypoint: [16_000, 0],
          section: generatedSection([
            [10, 0],
            [16_000, 0],
          ]),
        },
      ],
      closure: null,
    };
    const { loader, route } = createRoutingLoader();

    await expect(
      rebuildRouteAfterWaypointInsertion(
        state,
        2,
        [20, 0],
        'network',
        loader,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(RouteSectionTooLongError);
    expect(route).not.toHaveBeenCalled();
  });

  it('rejects deletion before reconnecting distant generated neighbours', async () => {
    const state: RouteState = {
      steps: [
        { waypoint: [0, 0], section: null },
        {
          waypoint: [10, 0],
          section: generatedSection([
            [0, 0],
            [10, 0],
          ]),
        },
        {
          waypoint: [16_000, 0],
          section: generatedSection([
            [10, 0],
            [16_000, 0],
          ]),
        },
      ],
      closure: null,
    };
    const { loader, route } = createRoutingLoader();

    await expect(
      rebuildRouteAfterWaypointDeletion(
        state,
        1,
        'network',
        loader,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(RouteSectionTooLongError);
    expect(route).not.toHaveBeenCalled();
  });

  it('reduces a closed two-point route to one open waypoint after deletion', async () => {
    const state: RouteState = {
      steps: createThreePointRoute(true).steps.slice(0, 2),
      closure: generatedSection([
        [10, 0],
        [0, 0],
      ]),
    };
    const { loader } = createRoutingLoader();

    const rebuilt = await rebuildRouteAfterWaypointDeletion(
      state,
      0,
      'straight',
      loader,
      new AbortController().signal,
    );

    expect(rebuilt).toEqual({
      steps: [
        {
          waypoint: [10, 0],
          section: null,
        },
      ],
      closure: null,
    });
  });
});
