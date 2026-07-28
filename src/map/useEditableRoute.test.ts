/**
 * Business context: protects editable-route orchestration that cannot be
 * covered by pure geometry tests, including React Strict Mode Worker lifecycle
 * and synchronous rejection of ambiguous long sections before routing starts.
 */
import { StrictMode, act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Coordinate } from 'ol/coordinate.js';
import type { RouteState } from './routeState';
import { useEditableRoute, type EditableRouteController } from './useEditableRoute';

interface CapturedRouteInteractions {
  onAppendEndpoint: (
    expectedState: RouteState,
    coordinate: Coordinate,
  ) => void;
}

const loaderState = vi.hoisted(() => ({
  instances: [] as Array<{
    disposed: boolean;
    routeCalls: number;
    emit: (notice: 'hiking-enrichment-unavailable') => void;
  }>,
}));

const interactionState = vi.hoisted(() => ({
  options: null as CapturedRouteInteractions | null,
}));

const controllerState: { current: EditableRouteController | null } = {
  current: null,
};

vi.mock('../routing/dynamicRoutingNetwork', () => {
  class RoutingAreaTooLargeError extends Error {}

  class DynamicRoutingNetworkLoader {
    private readonly listeners = new Set<
      (notice: 'hiking-enrichment-unavailable') => void
    >();
    disposed = false;
    routeCalls = 0;

    constructor() {
      loaderState.instances.push(this);
    }

    subscribeToNotices(
      listener: (notice: 'hiking-enrichment-unavailable') => void,
    ): () => void {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

    emit(notice: 'hiking-enrichment-unavailable'): void {
      for (const listener of this.listeners) {
        listener(notice);
      }
    }

    snap(): Promise<null> {
      return Promise.resolve(null);
    }

    route(): Promise<null> {
      this.routeCalls += 1;
      return Promise.resolve(null);
    }

    dispose(): void {
      this.disposed = true;
      this.listeners.clear();
    }
  }

  return {
    DynamicRoutingNetworkLoader,
    RoutingAreaTooLargeError,
  };
});

vi.mock('./useRouteInteractions', () => ({
  useRouteInteractions: (options: CapturedRouteInteractions) => {
    interactionState.options = options;

    return {
      routeContextHint: null,
      isInteractionActive: false,
      isPointerInteractionActive: () => false,
    };
  },
}));

vi.mock('./route', () => ({
  updateRouteDisplay: vi.fn(),
}));

function Harness() {
  const controller = useEditableRoute({
    mapRuntimeRef: { current: null },
    mapTargetRef: { current: null },
    locale: 'en-CH',
    t: (key, parameters) => {
      if (key === 'route.hikingEnrichmentUnavailable') {
        return 'Roads-only routing warning';
      }

      if (key === 'route.sectionTooLong') {
        return `Section ${parameters?.distance} km / ${parameters?.maximum} km`;
      }

      return key;
    },
  });
  controllerState.current = controller;

  return createElement(
    'div',
    null,
    `${controller.routeMessage}|${controller.isRouteOperationPending}`,
  );
}

describe('useEditableRoute orchestration', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    loaderState.instances.length = 0;
    interactionState.options = null;
    controllerState.current = null;
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
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

  it('subscribes the replacement Worker created by React Strict Mode', async () => {
    await act(async () => {
      root?.render(createElement(StrictMode, null, createElement(Harness)));
    });

    expect(loaderState.instances).toHaveLength(2);
    expect(loaderState.instances[0].disposed).toBe(true);
    expect(loaderState.instances[1].disposed).toBe(false);

    await act(async () => {
      loaderState.instances[1].emit('hiking-enrichment-unavailable');
    });

    expect(container.textContent).toBe('Roads-only routing warning|false');
  });

  it('rejects an overlong appended section before pending state or Worker routing', async () => {
    await act(async () => {
      root?.render(createElement(Harness));
    });

    const expectedState: RouteState = {
      steps: [
        {
          waypoint: [0, 0],
          segment: null,
          mode: 'network',
        },
      ],
      closure: null,
    };

    await act(async () => {
      interactionState.options?.onAppendEndpoint(expectedState, [16_000, 0]);
    });

    expect(controllerState.current?.isRouteOperationPending).toBe(false);
    expect(loaderState.instances[0].routeCalls).toBe(0);
    expect(container.textContent).toBe('Section 16 km / 15 km|false');
  });
});

