/**
 * Business context: proves that turning one imported GPX trace into editable
 * route state does not alter its geometry before the user performs an edit.
 */
import { describe, expect, it } from 'vitest';
import { MAX_NETWORK_SECTION_DIRECT_DISTANCE_METERS } from '../routing/routingConstants';
import { collectRouteCoordinates } from './routeState';
import {
  createEditableRouteFromImportedGeometry,
  DEFAULT_IMPORTED_ROUTE_PREFERRED_MAX_SECTION_COUNT,
  ImportedRouteSparseGeometryError,
  ImportedRouteTooManyVerticesError,
  MAX_EDITABLE_IMPORTED_VERTEX_COUNT,
} from './importedRouteConversion';

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
      preferredMaxSectionCount: 10,
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
      preferredMaxSectionCount: 20,
    });

    for (const step of state.steps) {
      expect(source).toContainEqual(step.waypoint);
    }
  });

  it('keeps roughly one anchor per kilometre on a 100 km trace', () => {
    const source = Array.from({ length: 101 }, (_value, index) => [index * 1_000, 0]);
    const state = createEditableRouteFromImportedGeometry(source);

    expect(state.steps).toHaveLength(101);
    expect(collectRouteCoordinates(state.steps)).toEqual(source);
  });

  it('treats the preferred section count as soft when editability needs more anchors', () => {
    const source = Array.from({ length: 4_501 }, (_value, index) => [index * 1_000, 0]);
    const state = createEditableRouteFromImportedGeometry(source);

    expect(state.steps.length).toBeGreaterThan(
      DEFAULT_IMPORTED_ROUTE_PREFERRED_MAX_SECTION_COUNT + 1,
    );
    expect(collectRouteCoordinates(state.steps)).toEqual(source);

    for (let index = 1; index < state.steps.length; index += 1) {
      const start = state.steps[index - 1].waypoint;
      const end = state.steps[index].waypoint;
      expect(Math.hypot(end[0] - start[0], end[1] - start[1])).toBeLessThanOrEqual(
        MAX_NETWORK_SECTION_DIRECT_DISTANCE_METERS,
      );
    }
  });

  it('rejects GPX geometries above the editable vertex ceiling without thinning them', () => {
    const source = Array.from(
      { length: MAX_EDITABLE_IMPORTED_VERTEX_COUNT + 1 },
      (_value, index) => [index, 0],
    );

    expect(() => createEditableRouteFromImportedGeometry(source)).toThrow(
      ImportedRouteTooManyVerticesError,
    );
  });

  it('rejects sparse source geometry that cannot stay within the network section limit', () => {
    expect(() =>
      createEditableRouteFromImportedGeometry([
        [0, 0],
        [MAX_NETWORK_SECTION_DIRECT_DISTANCE_METERS + 1, 0],
      ]),
    ).toThrow(ImportedRouteSparseGeometryError);
  });

  it('rejects geometries too short to form a route', () => {
    expect(() => createEditableRouteFromImportedGeometry([[0, 0]])).toThrow(
      'at least two coordinates',
    );
  });
});
