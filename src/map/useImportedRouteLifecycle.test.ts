/**
 * Business context: protects stale GPX-read invalidation when another workflow
 * takes ownership of the map before `File.text()` finishes. A late import must
 * never replace an editable route the user has already started.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MapRuntime } from './mapRuntime';
import {
  useImportedRoute,
  type ImportedRouteController,
} from './useImportedRoute';

vi.mock('./importedRoute', () => ({
  updateImportedRouteDisplay: vi.fn(),
}));

const controllerState: { current: ImportedRouteController | null } = {
  current: null,
};
const accepted = vi.fn();

function Harness() {
  const controller = useImportedRoute({
    mapRuntimeRef: {
      current: {
        map: {},
        importedRouteDisplay: {},
      } as MapRuntime,
    },
    t: (key) => key,
    onImportAccepted: accepted,
    onImportError: vi.fn(),
  });
  controllerState.current = controller;
  return null;
}

describe('useImportedRoute stale read lifecycle', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(async () => {
    accepted.mockReset();
    controllerState.current = null;
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(createElement(Harness));
    });
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }

    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('ignores a file read that resolves after clearImportedRoute invalidates its session', async () => {
    let resolveText: ((value: string) => void) | null = null;
    const textPromise = new Promise<string>((resolve) => {
      resolveText = resolve;
    });
    const file = {
      name: 'slow.gpx',
      size: 1_024,
      text: () => textPromise,
    } as File;

    let importPromise: Promise<void> | null = null;

    await act(async () => {
      importPromise = controllerState.current?.importRouteFile(file) ?? null;
    });

    await act(async () => {
      controllerState.current?.clearImportedRoute();
    });

    await act(async () => {
      resolveText?.('<gpx version="1.1"></gpx>');
      await importPromise;
    });

    expect(accepted).not.toHaveBeenCalled();
    expect(controllerState.current?.source).toBeNull();
    expect(controllerState.current?.segments).toEqual([]);
  });
});
