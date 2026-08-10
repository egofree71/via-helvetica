/**
 * Business context: protects the immutable route geometry used by undo, redo,
 * rendering, metrics, reversal, and GPX export. These tests focus on exact
 * section ownership because a subtle mutation or reversal error can corrupt
 * several user-visible workflows at once.
 */
import { describe, expect, it } from 'vitest';
import {
  collectRouteCoordinates,
  reverseRouteState,
  reverseRouteSteps,
  routeStateMatches,
  type RouteSection,
  type RouteState,
  type RouteStep,
} from './routeState';

function generatedSection(
  coordinates: number[][],
  mode: 'straight' | 'network' = 'straight',
): RouteSection {
  return {
    origin: 'generated',
    mode,
    coordinates,
  };
}

function createOpenRouteSteps(): RouteStep[] {
  return [
    {
      waypoint: [0, 0],
      section: null,
    },
    {
      waypoint: [10, 0],
      section: generatedSection(
        [
          [0, 0],
          [5, 0],
          [10, 0],
        ],
        'network',
      ),
    },
    {
      waypoint: [10, 10],
      section: generatedSection([
        [10, 0],
        [10, 10],
      ]),
    },
  ];
}

describe('routeState', () => {
  it('flattens stored sections without duplicate junction vertices', () => {
    const steps = createOpenRouteSteps();

    expect(collectRouteCoordinates(steps)).toEqual([
      [0, 0],
      [5, 0],
      [10, 0],
      [10, 10],
    ]);
  });

  it('keeps the existing sub-decimetre deduplication for generated geometry', () => {
    const steps: RouteStep[] = [
      { waypoint: [0, 0], section: null },
      {
        waypoint: [1, 0],
        section: generatedSection([
          [0, 0],
          [0.05, 0],
          [0.11, 0],
          [1, 0],
        ]),
      },
    ];

    expect(collectRouteCoordinates(steps)).toEqual([
      [0, 0],
      [0.11, 0],
      [1, 0],
    ]);
  });

  it('preserves distinct source vertices even when they are less than ten centimetres apart', () => {
    const steps: RouteStep[] = [
      { waypoint: [0, 0], section: null },
      {
        waypoint: [1, 0],
        section: {
          origin: 'imported',
          coordinates: [
            [0, 0],
            [0.05, 0],
            [0.11, 0],
            [1, 0],
          ],
        },
      },
    ];

    expect(collectRouteCoordinates(steps)).toEqual([
      [0, 0],
      [0.05, 0],
      [0.11, 0],
      [1, 0],
    ]);
  });

  it('reverses an open route while transferring each incoming section', () => {
    const steps = createOpenRouteSteps();
    const originalSnapshot = structuredClone(steps);

    expect(reverseRouteSteps(steps)).toEqual([
      {
        waypoint: [10, 10],
        section: null,
      },
      {
        waypoint: [10, 0],
        section: generatedSection([
          [10, 10],
          [10, 0],
        ]),
      },
      {
        waypoint: [0, 0],
        section: generatedSection(
          [
            [10, 0],
            [5, 0],
            [0, 0],
          ],
          'network',
        ),
      },
    ]);
    expect(steps).toEqual(originalSnapshot);
  });

  it('preserves imported section provenance when reversing', () => {
    const steps: RouteStep[] = [
      { waypoint: [0, 0], section: null },
      {
        waypoint: [10, 0],
        section: {
          origin: 'imported',
          coordinates: [
            [0, 0],
            [10, 0],
          ],
        },
      },
    ];

    expect(reverseRouteSteps(steps)[1].section).toEqual({
      origin: 'imported',
      coordinates: [
        [10, 0],
        [0, 0],
      ],
    });
  });

  it('reverses a closed route while preserving its physical start', () => {
    const state: RouteState = {
      steps: createOpenRouteSteps(),
      closure: generatedSection(
        [
          [10, 10],
          [0, 10],
          [0, 0],
        ],
        'network',
      ),
    };

    const reversed = reverseRouteState(state);

    expect(reversed.steps.map((step) => step.waypoint)).toEqual([
      [0, 0],
      [10, 10],
      [10, 0],
    ]);
    expect(collectRouteCoordinates(reversed.steps, reversed.closure)).toEqual([
      [0, 0],
      [0, 10],
      [10, 10],
      [10, 0],
      [5, 0],
      [0, 0],
    ]);
    expect(reverseRouteState(reversed)).toEqual(state);
  });

  it('matches asynchronous work only while immutable geometry references remain current', () => {
    const state: RouteState = {
      steps: createOpenRouteSteps(),
      closure: null,
    };
    const history = {
      ...state,
      undoStates: [],
      redoStates: [],
    };

    expect(routeStateMatches(history, state)).toBe(true);
    expect(
      routeStateMatches(
        {
          ...history,
          steps: [...history.steps],
        },
        state,
      ),
    ).toBe(false);
  });
});
