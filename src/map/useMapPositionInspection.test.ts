/**
 * Business context: protects desktop-only right-click inspection from becoming
 * a mobile long-press interaction, and verifies that marker, altitude request,
 * and dismissal all follow one cancellable map context.
 */
import { act, createElement, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMapPositionMarker } from './mapPositionMarker';
import type { MapRuntime } from './mapRuntime';
import { fetchPointHeight } from './pointHeight';
import {
  useMapPositionInspection,
  type MapPositionInspectionController,
} from './useMapPositionInspection';

vi.mock('./pointHeight', () => ({
  fetchPointHeight: vi.fn(),
}));

/** Minimal OpenLayers-style observable used by the hook's single-click listener. */
class FakeObservable {
  private readonly listeners = new Map<string, Set<() => void>>();

  on(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  un(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener();
    }
  }
}

function createRuntime(
  initialCoordinate: [number, number] = [2_600_000, 1_200_000],
): {
  runtime: MapRuntime;
  viewport: HTMLDivElement;
  mapEvents: FakeObservable;
  setCoordinate: (coordinate: [number, number]) => void;
} {
  const viewport = document.createElement('div');
  const mapEvents = new FakeObservable();
  let coordinate = initialCoordinate;
  const map = {
    getViewport: () => viewport,
    getEventCoordinate: () => coordinate,
    on: mapEvents.on.bind(mapEvents),
    un: mapEvents.un.bind(mapEvents),
  };

  return {
    runtime: {
      map,
      mapPositionMarker: createMapPositionMarker(),
    } as unknown as MapRuntime,
    viewport,
    mapEvents,
    setCoordinate: (nextCoordinate) => {
      coordinate = nextCoordinate;
    },
  };
}


const hookHarness: { controller: MapPositionInspectionController | null } = {
  controller: null,
};

function Harness({
  runtime,
  onOpen,
}: {
  runtime: MapRuntime;
  onOpen: () => void;
}) {
  const runtimeRef = useRef<MapRuntime | null>(runtime);
  hookHarness.controller = useMapPositionInspection({
    mapRuntimeRef: runtimeRef,
    onOpen,
  });
  return null;
}

describe('useMapPositionInspection', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    hookHarness.controller = null;
    vi.mocked(fetchPointHeight).mockResolvedValue(553.6);
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

  it('opens on a fine-pointer context menu and closes on the next left click', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(hover: hover) and (pointer: fine)',
    }));
    const { runtime, viewport, mapEvents } = createRuntime();
    const onOpen = vi.fn();

    await act(async () => {
      root?.render(createElement(Harness, { runtime, onOpen }));
    });

    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
    });

    await act(async () => {
      viewport.dispatchEvent(event);
      await Promise.resolve();
    });

    expect(event.defaultPrevented).toBe(true);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(fetchPointHeight).toHaveBeenCalledTimes(1);
    expect(hookHarness.controller?.inspection?.coordinate).toEqual([
      2_600_000,
      1_200_000,
    ]);
    expect(hookHarness.controller?.inspection?.wgs84Coordinate[0]).toBeCloseTo(
      7.43863242,
      6,
    );
    expect(hookHarness.controller?.inspection?.wgs84Coordinate[1]).toBeCloseTo(
      46.95108277,
      6,
    );
    expect(hookHarness.controller?.inspection?.elevationStatus).toBe('ready');
    expect(hookHarness.controller?.inspection?.elevationMeters).toBe(553.6);
    expect(
      runtime.mapPositionMarker.feature.getGeometry()?.getCoordinates(),
    ).toEqual([2_600_000, 1_200_000]);

    await act(async () => mapEvents.emit('singleclick'));

    expect(hookHarness.controller?.inspection).toBeNull();
    expect(runtime.mapPositionMarker.feature.getGeometry()).toBeUndefined();
  });

  it('preserves the native context menu on OpenLayers controls', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(hover: hover) and (pointer: fine)',
    }));
    const { runtime, viewport } = createRuntime();
    const control = document.createElement('div');
    control.className = 'ol-control';
    const attributionLink = document.createElement('a');
    control.appendChild(attributionLink);
    viewport.appendChild(control);

    await act(async () => {
      root?.render(createElement(Harness, { runtime, onOpen: vi.fn() }));
    });

    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
    });

    await act(async () => {
      attributionLink.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
    expect(fetchPointHeight).not.toHaveBeenCalled();
    expect(hookHarness.controller?.inspection).toBeNull();
  });

  it('does not replace the native context menu on coarse-pointer devices', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const { runtime, viewport } = createRuntime();

    await act(async () => {
      root?.render(createElement(Harness, { runtime, onOpen: vi.fn() }));
    });

    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
    });

    await act(async () => {
      viewport.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
    expect(fetchPointHeight).not.toHaveBeenCalled();
    expect(hookHarness.controller?.inspection).toBeNull();
  });

  it('keeps the newest point when an older height response arrives late', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(hover: hover) and (pointer: fine)',
    }));
    let resolveFirst: ((value: number) => void) | null = null;
    let resolveSecond: ((value: number) => void) | null = null;
    vi.mocked(fetchPointHeight)
      .mockImplementationOnce(
        () =>
          new Promise<number>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<number>((resolve) => {
            resolveSecond = resolve;
          }),
      );
    const { runtime, viewport, setCoordinate } = createRuntime();

    await act(async () => {
      root?.render(createElement(Harness, { runtime, onOpen: vi.fn() }));
    });

    await act(async () => {
      viewport.dispatchEvent(
        new MouseEvent('contextmenu', { cancelable: true, button: 2 }),
      );
    });

    setCoordinate([2_601_000, 1_201_000]);
    await act(async () => {
      viewport.dispatchEvent(
        new MouseEvent('contextmenu', { cancelable: true, button: 2 }),
      );
    });

    const firstSignal = vi.mocked(fetchPointHeight).mock.calls[0][1];
    const secondSignal = vi.mocked(fetchPointHeight).mock.calls[1][1];
    expect(firstSignal.aborted).toBe(true);
    expect(secondSignal.aborted).toBe(false);

    await act(async () => {
      resolveSecond?.(612.4);
      await Promise.resolve();
    });
    expect(hookHarness.controller?.inspection?.coordinate).toEqual([
      2_601_000,
      1_201_000,
    ]);
    expect(hookHarness.controller?.inspection?.elevationMeters).toBe(612.4);

    await act(async () => {
      resolveFirst?.(999.9);
      await Promise.resolve();
    });

    expect(hookHarness.controller?.inspection?.coordinate).toEqual([
      2_601_000,
      1_201_000,
    ]);
    expect(hookHarness.controller?.inspection?.elevationMeters).toBe(612.4);
  });
});
