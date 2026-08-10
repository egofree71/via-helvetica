/**
 * Business context: centralizes the decision between preserving an original
 * imported GPX document and generating a new GPX from editable route state.
 * The exact source must remain testable outside `App.tsx` because exporting a
 * stale imported document after an edit would silently discard user changes.
 */
import {
  routeStateMatches,
  type RouteHistory,
  type RouteState,
} from '../map/routeState';

/** Imported GPX fields required by exact-source export. */
export interface ExportableImportedRouteSource {
  /** Name proposed when the export dialog opens. */
  name: string;
  /** Complete original GPX XML preserved while it remains authoritative. */
  gpxDocument: string;
}

/** Original GPX resources retained while converted geometry may return to pristine. */
export interface EditableImportedRouteExportOrigin {
  /** Original source used for exact pristine export. */
  source: ExportableImportedRouteSource;
  /** Exact state created by lossless GPX conversion. */
  pristineState: RouteState;
}

/** Export source resolved for the shared editable/imported GPX workflow. */
export type ItineraryExportSource =
  | {
      /** Preserve the original GPX XML because no editable geometry has changed. */
      kind: 'imported';
      /** Source document whose metadata and extensions remain authoritative. */
      source: ExportableImportedRouteSource;
    }
  | {
      /** Generate a new GPX from current editable route state. */
      kind: 'editable';
    }
  | null;

/**
 * Checks whether a converted GPX still owns exactly its original route-state
 * references. Undo can therefore restore pristine export without a mutable
 * `hasBeenModified` flag.
 * @param history - Current editable route history.
 * @param origin - Retained imported origin, or `null` for ordinary routes.
 * @returns `true` only while steps and closure match the conversion state by reference.
 */
export function isEditableImportedRoutePristine(
  history: RouteHistory,
  origin: EditableImportedRouteExportOrigin | null,
): boolean {
  return origin !== null && routeStateMatches(history, origin.pristineState);
}

/**
 * Resolves an exact imported GPX document only while it is still authoritative.
 * A read-only import takes precedence over a retained editable origin because
 * the application exposes only one current itinerary at a time.
 * @param importedRouteSource - Current read-only imported GPX source.
 * @param editableImportedRouteOrigin - Retained source for a converted GPX.
 * @param routeHistory - Current editable history used to prove pristine identity.
 * @returns Exact source document, or `null` after any committed geometry change.
 */
export function resolveExactImportedRouteSource(
  importedRouteSource: ExportableImportedRouteSource | null,
  editableImportedRouteOrigin: EditableImportedRouteExportOrigin | null,
  routeHistory: RouteHistory,
): ExportableImportedRouteSource | null {
  if (importedRouteSource) {
    return importedRouteSource;
  }

  return isEditableImportedRoutePristine(
    routeHistory,
    editableImportedRouteOrigin,
  )
    ? editableImportedRouteOrigin?.source ?? null
    : null;
}

/**
 * Resolves whether the shared export dialog should preserve imported XML or
 * generate a document from editable geometry.
 * @param input - Current itinerary sources and editable-route availability.
 * @returns Imported source, editable source, or `null` when export is unavailable.
 */
export function resolveItineraryExportSource(input: {
  importedRouteSource: ExportableImportedRouteSource | null;
  editableImportedRouteOrigin: EditableImportedRouteExportOrigin | null;
  routeHistory: RouteHistory;
  isRouteEditingActive: boolean;
  isRouteOperationPending: boolean;
}): ItineraryExportSource {
  const exactImportedSource = resolveExactImportedRouteSource(
    input.importedRouteSource,
    input.editableImportedRouteOrigin,
    input.routeHistory,
  );

  if (exactImportedSource) {
    return {
      kind: 'imported',
      source: exactImportedSource,
    };
  }

  if (
    !input.isRouteEditingActive ||
    input.isRouteOperationPending ||
    input.routeHistory.steps.length < 2
  ) {
    return null;
  }

  return { kind: 'editable' };
}
