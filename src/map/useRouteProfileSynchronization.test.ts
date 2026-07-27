/**
 * Business context: protects exclusive ownership of the shared black marker.
 * A temporary public route must synchronize map and profile positions while
 * active, then release the marker cleanly when another workflow takes over.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type MapBrowserEvent from 'ol/MapBrowserEvent.js';
import type { Coordinate } from 'ol/coordinate.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MapRuntime } from './mapRuntime';
import { createRouteProfileMarker } from './routeProfileMarker';
import {
  useRouteProfileSynchronization,
  type RouteProfileSynchronizationController,
} from './useRouteProfileSynchronization';

const ROUTE_SEGMENTS: Coordinate[][] = [
  [
    [2_600_000, 1_200_000],
    [2_601_000, 1_200_000],
  ],
];

describe('useRouteProfileSynchronization', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
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

  it('links map hover to profile distance and clears state when disabled', async () => {
    const mapTarget = document.createElement('div');
    const marker = createRouteProfileMarker();
    let pointerMoveListener: ((event: MapBrowserEvent) => void) | null = null;
    const map = {
      on: vi.fn((eventName: string, listener: (event: MapBrowserEvent) => void) => {
        if (eventName === 'pointermove') {
          pointerMoveListener = listener;
        }
      }),
      un: vi.fn(),
      getTargetElement: () => mapTarget,
      getView: () => ({ getResolution: () => 1 }),
    };
    const mapRuntimeRef = {
      current: {
        map,
        routeProfileMarker: marker,
      } as unknown as MapRuntime,
    };
    const controllerRef: {
      current: RouteProfileSynchronizationController | null;
    } = { current: null };

    function Harness({ isEnabled }: { isEnabled: boolean }) {
      controllerRef.current = useRouteProfileSynchronization({
        mapRuntimeRef,
        routeSegments: ROUTE_SEGMENTS,
        isEnabled,
      });

      return null;
    }

    await act(async () => {
      root?.render(createElement(Harness, { isEnabled: true }));
    });

    expect(pointerMoveListener).not.toBeNull();

    await act(async () => {
      pointerMoveListener?.({
        originalEvent: { pointerType: 'mouse' },
        coordinate: [2_600_500, 1_200_000],
      } as unknown as MapBrowserEvent);
    });

    expect(controllerRef.current?.mapHoverDistanceMeters).not.toBeNull();
    expect(marker.feature.getGeometry()?.getCoordinates()).toEqual([
      2_600_500,
      1_200_000,
    ]);

    await act(async () => {
      controllerRef.current?.handleProfileHoverDistanceChange(0);
    });

    expect(marker.feature.getGeometry()?.getCoordinates()).toEqual([
      2_600_000,
      1_200_000,
    ]);

    await act(async () => {
      root?.render(createElement(Harness, { isEnabled: false }));
    });

    expect(controllerRef.current?.mapHoverDistanceMeters).toBeNull();
    expect(marker.feature.getGeometry()).toBeUndefined();
    expect(map.un).toHaveBeenCalledWith(
      'pointermove',
      expect.any(Function),
    );
  });
});
