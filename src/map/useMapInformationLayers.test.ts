/**
 * Business context: protects the shared map-information click pipeline against
 * React lifecycle regressions. A click may close an existing
 * SwitzerlandMobility panel while its new identify request continues; empty
 * mobile clicks may instead preserve that panel for temporary map-only mode.
 */
import { act, createElement, useCallback, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { identifyTrailClosure } from '../closures/trailClosures';
import {
  getPublicTransportStopChoicesForVisibleStop,
  getPublicTransportStopFromFeature,
  publicTransportStopsCoverageContainsViewport,
  updatePublicTransportStopSelection,
  type PublicTransportStop,
} from '../transport/publicTransportStops';
import { HIKING_TRAILS_MIN_ZOOM } from './config';
import type { MapRuntime } from './mapRuntime';
import { useMapInformationLayers } from './useMapInformationLayers';

const selectionHarness = vi.hoisted(() => ({
  openPanel: null as (() => void) | null,
}));
const closureHarness = vi.hoisted(() => ({
  signals: [] as AbortSignal[],
}));

vi.mock('./useSwitzerlandMobilityHikingSelection', async () => {
  const React = await import('react');
  const readyPanel = {
    state: 'ready' as const,
    route: {
      featureId: '4.16',
      routeNumber: '4',
      routeId: '4.16',
      routeName: 'ViaJacobi',
      sectionName: 'Moudon - Lausanne',
      stageNumber: '16',
      hasStages: true,
      segments: [
        [
          [2_550_000, 1_170_000],
          [2_551_000, 1_170_000],
        ],
      ],
    },
    distanceMeters: 1_000,
    elevationStatus: 'loading' as const,
    elevation: null,
    durationMinutes: null,
  };

  return {
    useSwitzerlandMobilityHikingSelection: () => {
      const [panelStatus, setPanelStatus] = React.useState<
        typeof readyPanel | null
      >(null);
      const closeSelection = React.useCallback(() => {
        setPanelStatus(null);
      }, []);

      selectionHarness.openPanel = () => setPanelStatus(readyPanel);

      return {
        panelStatus,
        inspectAt: React.useCallback(async () => false, []),
        selectCandidate: React.useCallback(() => undefined, []),
        mapHoverDistanceMeters: null,
        handleProfileHoverDistanceChange: React.useCallback(
          () => undefined,
          [],
        ),
        closeSelection,
        dismissSelection: closeSelection,
      };
    },
  };
});

vi.mock('../closures/trailClosures', () => ({
  identifyTrailClosure: vi.fn(
    (_context: unknown, signal: AbortSignal) =>
      new Promise<null>(() => {
        closureHarness.signals.push(signal);
      }),
  ),
  fetchTrailClosurePopup: vi.fn(),
}));

vi.mock('../dangers/shootingDangerZones', () => ({
  identifyShootingDangerZone: vi.fn().mockResolvedValue(null),
  fetchShootingDangerZonePopup: vi.fn(),
  updateShootingDangerZoneSelection: vi.fn(),
}));

vi.mock('../transport/publicTransportStops', () => ({
  applyPublicTransportStopDeclutterVisibility: vi.fn(),
  PUBLIC_TRANSPORT_STOPS_MIN_ZOOM: 8,
  createPublicTransportStopsViewportCoverage: vi.fn(),
  getPublicTransportStopChoicesForVisibleStop: vi.fn(),
  getPublicTransportStopFromFeature: vi.fn().mockReturnValue(null),
  loadPublicTransportStops: vi.fn().mockResolvedValue([]),
  publicTransportStopsCoverageContainsViewport: vi.fn().mockReturnValue(false),
  updatePublicTransportStopsDisplay: vi.fn(),
  updatePublicTransportStopDeclutterPriority: vi.fn(),
  updatePublicTransportStopSelection: vi.fn(),
}));

vi.mock('./mapInformationViewport', () => ({
  ensureMapInformationCoordinateVisible: vi.fn(),
}));

/** Minimal event target implementing the OpenLayers listener methods used here. */
class FakeObservable {
  private readonly listeners = new Map<string, Set<(event?: unknown) => void>>();

  on(type: string, listener: (event?: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  un(type: string, listener: (event?: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

/** Creates the narrow map runtime surface required by the information hook. */
function createRuntime(options: { hitFeature?: object } = {}): {
  runtime: MapRuntime;
  mapEvents: FakeObservable;
} {
  const mapEvents = new FakeObservable();
  const viewEvents = new FakeObservable();
  const target = document.createElement('div');
  const view = {
    getZoom: () => HIKING_TRAILS_MIN_ZOOM + 1,
    getResolution: () => 10,
    getRotation: () => 0,
    calculateExtent: () => [2_540_000, 1_160_000, 2_570_000, 1_185_000],
    on: viewEvents.on.bind(viewEvents),
    un: viewEvents.un.bind(viewEvents),
  };
  const map = {
    getSize: () => [1_200, 800],
    getView: () => view,
    getTargetElement: () => target,
    forEachFeatureAtPixel: (
      _pixel: unknown,
      callback: (feature: object) => unknown,
    ) => options.hitFeature ? callback(options.hitFeature) : undefined,
    on: mapEvents.on.bind(mapEvents),
    un: mapEvents.un.bind(mapEvents),
  };
  const source = { clear: vi.fn() };

  return {
    mapEvents,
    runtime: {
      map,
      setTrailClosuresVisible: vi.fn(),
      setShootingDangerZonesVisible: vi.fn(),
      setPublicTransportStopsVisible: vi.fn(),
      publicTransportStopsDisplay: { source, layer: {} },
      shootingDangerZoneSelectionDisplay: {},
    } as unknown as MapRuntime,
  };
}

function Harness({
  runtime,
  onMapClickStart,
  publicTransportStopsVisible = false,
}: {
  runtime: MapRuntime;
  onMapClickStart?: () => boolean;
  publicTransportStopsVisible?: boolean;
}) {
  const mapRuntimeRef = useRef<MapRuntime | null>(runtime);
  const onInformationSelected = useCallback(() => undefined, []);
  const onRouteAccepted = useCallback(() => undefined, []);
  const controller = useMapInformationLayers({
    mapRuntimeRef,
    initialVisibility: {
      trailClosures: true,
      shootingDangerZones: false,
      publicTransportStops: publicTransportStopsVisible,
    },
    language: 'fr',
    isSwitzerlandMobilityHikingVisible: true,
    isRouteCreationActive: false,
    onMapClickStart,
    onInformationSelected,
    onSwitzerlandMobilityHikingRouteAccepted: onRouteAccepted,
  });

  return createElement(
    'div',
    null,
    `route:${controller.switzerlandMobilityHikingPanel?.state ?? 'closed'};transport:${controller.publicTransportStopPopup?.state ?? 'closed'}`,
  );
}

describe('useMapInformationLayers click lifecycle', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    closureHarness.signals.length = 0;
    selectionHarness.openPanel = null;
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

  it('keeps the identify request alive when the same click closes a public-route panel', async () => {
    const { runtime, mapEvents } = createRuntime();

    await act(async () => {
      root?.render(createElement(Harness, { runtime }));
    });
    await act(async () => {
      selectionHarness.openPanel?.();
    });

    expect(container.textContent).toContain('ready');

    await act(async () => {
      mapEvents.emit('singleclick', {
        pixel: [400, 300],
        coordinate: [2_553_000, 1_171_000],
      });
      await Promise.resolve();
    });

    expect(closureHarness.signals).toHaveLength(1);
    expect(closureHarness.signals[0].aborted).toBe(false);
    expect(container.textContent).toContain('closed');
  });

  it('preserves the current panel when a mobile empty-map click is handled by the shell', async () => {
    const { runtime, mapEvents } = createRuntime();
    const onMapClickStart = vi.fn(() => true);
    vi.mocked(identifyTrailClosure).mockResolvedValueOnce(null);

    await act(async () => {
      root?.render(
        createElement(Harness, { runtime, onMapClickStart }),
      );
    });
    await act(async () => {
      selectionHarness.openPanel?.();
    });

    await act(async () => {
      mapEvents.emit('singleclick', {
        pixel: [400, 300],
        coordinate: [2_553_000, 1_171_000],
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onMapClickStart).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('ready');
  });

  it('opens a stop chooser when one rendered symbol represents hidden neighbours', async () => {
    const hitFeature = {};
    const { runtime, mapEvents } = createRuntime({ hitFeature });
    const visibleStop: PublicTransportStop = {
      id: 'a',
      stationId: 'station-a',
      name: 'Stop A',
      modes: ['bus'],
      coordinate: [2_553_000, 1_171_000],
    };
    const hiddenStop: PublicTransportStop = {
      id: 'b',
      stationId: 'station-b',
      name: 'Stop B',
      modes: ['tram'],
      coordinate: [2_553_100, 1_171_000],
    };
    vi.mocked(publicTransportStopsCoverageContainsViewport).mockReturnValue(
      true,
    );
    vi.mocked(getPublicTransportStopFromFeature).mockReturnValue(visibleStop);
    vi.mocked(getPublicTransportStopChoicesForVisibleStop).mockReturnValue([
      visibleStop,
      hiddenStop,
    ]);

    await act(async () => {
      root?.render(
        createElement(Harness, {
          runtime,
          publicTransportStopsVisible: true,
        }),
      );
    });

    await act(async () => {
      mapEvents.emit('singleclick', {
        pixel: [400, 300],
        coordinate: [2_553_000, 1_171_000],
      });
    });

    expect(getPublicTransportStopChoicesForVisibleStop).toHaveBeenCalledWith(
      runtime.publicTransportStopsDisplay,
      runtime.map,
      visibleStop,
    );
    expect(container.textContent).toContain('transport:choices');
    expect(updatePublicTransportStopSelection).not.toHaveBeenCalledWith(
      runtime.publicTransportStopsDisplay,
      visibleStop,
    );
  });

  it('keeps the historical desktop dismissal when the shell does not handle an empty click', async () => {
    const { runtime, mapEvents } = createRuntime();
    const onMapClickStart = vi.fn(() => false);
    vi.mocked(identifyTrailClosure).mockResolvedValueOnce(null);

    await act(async () => {
      root?.render(
        createElement(Harness, { runtime, onMapClickStart }),
      );
    });
    await act(async () => {
      selectionHarness.openPanel?.();
    });

    await act(async () => {
      mapEvents.emit('singleclick', {
        pixel: [400, 300],
        coordinate: [2_553_000, 1_171_000],
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onMapClickStart).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('closed');
  });
});
