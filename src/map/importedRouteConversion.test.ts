/**
 * Business context: proves that turning one imported GPX trace into editable
 * route state does not alter its geometry before the user performs an edit.
 */
import { describe, expect, it } from 'vitest';
import { collectRouteCoordinates } from './routeState';
import { createEditableRouteFromImportedGeometry } from './importedRouteConversion';

describe('createEditableRouteFromImportedGeometry', () => {
  it('reconstructs the source geometry exactly without routing or simplification', () => {
    const source = [
      [0, 0],
      [0.05, 0],
      [400, 10],
      [900, 20],
      [1_200, 30],
      [2_100, 40],
    ];

    const state = createEditableRouteFromImportedGeometry(source, {
      targetSectionLengthMeters: 700,
      maxAnchorCount: 10,
    });

    expect(collectRouteCoordinates(state.steps, state.closure)).toEqual(source);
    expect(state.steps[0].section).toBeNull();
    expect(
      state.steps.slice(1).every((step) => step.section?.origin === 'imported'),
    ).toBe(true);
  });

  it('adapts spacing on short traces so they still expose interior anchors', () => {
    const source = Array.from({ length: 7 }, (_value, index) => [index * 100, 0]);
    const state = createEditableRouteFromImportedGeometry(source);

    expect(state.steps).toHaveLength(4);
    expect(state.steps.map((step) => step.waypoint)).toEqual([
      source[0],
      source[2],
      source[4],
      source[6],
    ]);
    expect(collectRouteCoordinates(state.steps)).toEqual(source);
  });

  it('uses only existing source vertices as editable anchors', () => {
    const source = Array.from({ length: 21 }, (_value, index) => [index * 100, index]);
    const state = createEditableRouteFromImportedGeometry(source, {
      targetSectionLengthMeters: 350,
      maxAnchorCount: 20,
    });

    for (const step of state.steps) {
      expect(source).toContainEqual(step.waypoint);
    }
  });

  it('caps anchor count on long traces while always retaining both endpoints', () => {
    const source = Array.from({ length: 201 }, (_value, index) => [index * 1_000, 0]);
    const state = createEditableRouteFromImportedGeometry(source, {
      targetSectionLengthMeters: 1_000,
      maxAnchorCount: 10,
    });

    expect(state.steps.length).toBeLessThanOrEqual(10);
    expect(state.steps[0].waypoint).toEqual(source[0]);
    expect(state.steps[state.steps.length - 1].waypoint).toEqual(source[source.length - 1]);
    expect(collectRouteCoordinates(state.steps)).toEqual(source);
  });

  it('rejects geometries too short to form a route', () => {
    expect(() => createEditableRouteFromImportedGeometry([[0, 0]])).toThrow(
      'at least two coordinates',
    );
  });
});
