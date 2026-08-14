/**
 * Business context: protects the export-source contract so converted GPX edits
 * can never accidentally download stale original XML and undo can restore exact
 * source preservation when the pristine route state returns by reference.
 */
import { describe, expect, it } from 'vitest';
import type { Coordinate } from 'ol/coordinate.js';
import type {
  RouteHistory,
  RouteState,
  RouteStep,
} from '../map/routeState';
import {
  isEditableImportedRoutePristine,
  resolveExactImportedRouteSource,
  resolveItineraryExportSource,
  type EditableImportedRouteExportOrigin,
  type ExportableImportedRouteSource,
} from './itineraryExportSource';

const SOURCE: ExportableImportedRouteSource = {
  name: 'original.gpx',
  gpxDocument: '<gpx/>',
};

function importedStep(
  waypoint: Coordinate,
  coordinates: Coordinate[] | null,
): RouteStep {
  return {
    waypoint,
    section: coordinates
      ? { origin: 'imported', coordinates }
      : null,
  };
}

function historyFromState(state: RouteState): RouteHistory {
  return {
    ...state,
    undoStates: [],
    redoStates: [],
  };
}

function createOrigin(state: RouteState): EditableImportedRouteExportOrigin {
  return {
    source: SOURCE,
    pristineState: state,
  };
}

const PRISTINE_STATE: RouteState = {
  steps: [
    importedStep([0, 0], null),
    importedStep([1_000, 0], [[0, 0], [1_000, 0]]),
  ],
  closure: null,
};

describe('editable imported-route export source', () => {
  it('uses the exact XML for a read-only imported GPX', () => {
    const result = resolveItineraryExportSource({
      importedRouteSource: SOURCE,
      editableImportedRouteOrigin: null,
      routeHistory: historyFromState({ steps: [], closure: null }),
      isRouteOperationPending: false,
    });

    expect(result).toEqual({ kind: 'imported', source: SOURCE });
  });

  it('offers generated export whenever a complete editable route remains current', () => {
    expect(
      resolveItineraryExportSource({
        importedRouteSource: null,
        editableImportedRouteOrigin: null,
        routeHistory: historyFromState(PRISTINE_STATE),
        isRouteOperationPending: false,
      }),
    ).toEqual({ kind: 'editable' });
  });

  it('keeps the exact XML after conversion while route references remain pristine', () => {
    const origin = createOrigin(PRISTINE_STATE);
    const history = historyFromState(PRISTINE_STATE);

    expect(isEditableImportedRoutePristine(history, origin)).toBe(true);
    expect(
      resolveItineraryExportSource({
        importedRouteSource: null,
        editableImportedRouteOrigin: origin,
        routeHistory: history,
        isRouteOperationPending: false,
      }),
    ).toEqual({ kind: 'imported', source: SOURCE });
  });

  it('switches to generated export after an editable geometry change', () => {
    const origin = createOrigin(PRISTINE_STATE);
    const changedState: RouteState = {
      steps: PRISTINE_STATE.steps.map((step, index) =>
        index === 1
          ? {
              waypoint: [1_100, 0],
              section: {
                origin: 'generated',
                mode: 'straight',
                coordinates: [[0, 0], [1_100, 0]],
              },
            }
          : step,
      ),
      closure: null,
    };

    expect(
      resolveItineraryExportSource({
        importedRouteSource: null,
        editableImportedRouteOrigin: origin,
        routeHistory: historyFromState(changedState),
        isRouteOperationPending: false,
      }),
    ).toEqual({ kind: 'editable' });
  });

  it('restores exact imported export when undo restores pristine references', () => {
    const origin = createOrigin(PRISTINE_STATE);
    const restoredHistory: RouteHistory = {
      ...PRISTINE_STATE,
      undoStates: [],
      redoStates: [
        {
          steps: [...PRISTINE_STATE.steps],
          closure: null,
        },
      ],
    };

    expect(isEditableImportedRoutePristine(restoredHistory, origin)).toBe(true);
    expect(
      resolveExactImportedRouteSource(null, origin, restoredHistory),
    ).toBe(SOURCE);
  });

  it('restores pristine export after a loop is opened back to the original references', () => {
    const origin = createOrigin(PRISTINE_STATE);
    const reopenedHistory: RouteHistory = {
      steps: PRISTINE_STATE.steps,
      closure: PRISTINE_STATE.closure,
      undoStates: [],
      redoStates: [],
    };

    expect(resolveExactImportedRouteSource(null, origin, reopenedHistory)).toBe(
      SOURCE,
    );
  });

  it('does not offer editable export while route work is pending or too short', () => {
    expect(
      resolveItineraryExportSource({
        importedRouteSource: null,
        editableImportedRouteOrigin: null,
        routeHistory: historyFromState(PRISTINE_STATE),
        isRouteOperationPending: true,
      }),
    ).toBeNull();

    expect(
      resolveItineraryExportSource({
        importedRouteSource: null,
        editableImportedRouteOrigin: null,
        routeHistory: historyFromState({
          steps: [importedStep([0, 0], null)],
          closure: null,
        }),
        isRouteOperationPending: false,
      }),
    ).toBeNull();
  });
});
