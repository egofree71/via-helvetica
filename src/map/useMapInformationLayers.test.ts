/**
 * Business context: protects the shared map-information click pipeline against
 * React lifecycle and cross-layer ambiguity regressions. One click can combine
 * safety, public transport, and SwitzerlandMobility candidates, while empty
 * mobile clicks may preserve the current panel for temporary map-only mode.
 */
import { act, createElement, useCallback, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { identifyTrailClosure } from '../closures/trailClosures';
import { identifyShootingDangerZone } from '../dangers/shootingDangerZones';
import {
  applyPublicTransportStopDeclutterVisibility,
  getPublicTransportStopChoicesForVisibleStop,
  getPublicTransportStopFromFeature,
  publicTransportStopsCoverageContainsViewport,
  updatePublicTransportStopDeclutterPriority,
  updatePublicTransportStopSelection,
  updatePublicTransportStopsViewRotation,
  type PublicTransportStop,
} from '../transport/publicTransportStops';
import { HIKING_TRAILS_MIN_ZOOM } from './config';
import type { MapInformationChoice } from './mapInformationChoice';
import type { MapRuntime } from './mapRuntime';
import { useMapInformationLayers } from './useMapInformationLayers';

const selectionHarness = vi.hoisted(() => ({
  openPanel: null as (() => void) | null,
}));
const closureHarness = vi.hoisted(() => ({
  signals: [] as AbortSignal[],
}));
const routeHarness = vi.hoisted(() => ({
  candidates: [] as Array<Record<string, unknown>>,
}));
const informationHarness = vi.hoisted(() => ({
  selectMapInformationChoice: null as
    | ((choice: MapInformationChoice) => void)
    | null,
  mapInformationChoices: null as MapInformationChoice[] | null,
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
        identifyCandidatesAt: React.useCallback(
          async () => routeHarness.candidates,
          [],
        ),
        showIdentifyError: React.useCallback(() => undefined, []),
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
  identifyTrailClosure: vi.fn().mockResolvedValue(null),
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
  updatePublicTransportStopsViewRotation: vi.fn(),
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
  viewEvents: FakeObservable;
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
    viewEvents,
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
  shootingDangerZonesVisible = false,
}: {
  runtime: MapRuntime;
  onMapClickStart?: () => boolean;
  publicTransportStopsVisible?: boolean;
  shootingDangerZonesVisible?: boolean;
}) {
  const mapRuntimeRef = useRef<MapRuntime | null>(runtime);
  const onInformationSelected = useCallback(() => undefined, []);
  const onRouteAccepted = useCallback(() => undefined, []);
  const controller = useMapInformationLayers({
    mapRuntimeRef,
    initialVisibility: {
      trailClosures: true,
      shootingDangerZones: shootingDangerZonesVisible,
      publicTransportStops: publicTransportStopsVisible,
    },
    language: 'fr',
    isSwitzerlandMobilityHikingVisible: true,
    isRouteCreationActive: false,
    onMapClickStart,
    onInformationSelected,
    onSwitzerlandMobilityHikingRouteAccepted: onRouteAccepted,
  });
  informationHarness.selectMapInformationChoice =
    controller.selectMapInformationChoice;
  informationHarness.mapInformationChoices = controller.mapInformationChoices;

  return createElement(
    'div',
    null,
    `route:${controller.switzerlandMobilityHikingPanel?.state ?? 'closed'};transport:${controller.publicTransportStopPopup?.state ?? 'closed'};choices:${controller.mapInformationChoices?.map((choice) => choice.kind).join(',') ?? 'closed'}`,
  );
}

describe('useMapInformationLayers click lifecycle', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    closureHarness.signals.length = 0;
    routeHarness.candidates = [];
    selectionHarness.openPanel = null;
    informationHarness.selectMapInformationChoice = null;
    informationHarness.mapInformationChoices = null;
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
    vi.mocked(identifyTrailClosure).mockImplementationOnce(
      (_context, signal) =>
        new Promise<null>(() => {
          closureHarness.signals.push(signal);
        }),
    );

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

  it('opens one concrete stop directly when no other layer matches the click', async () => {
    const hitFeature = {};
    const { runtime, mapEvents } = createRuntime({ hitFeature });
    const stop: PublicTransportStop = {
      id: 'single-stop',
      stationId: 'station-single',
      name: 'Stop unique',
      modes: ['bus'],
      coordinate: [2_553_000, 1_171_000],
    };
    vi.mocked(publicTransportStopsCoverageContainsViewport).mockReturnValue(
      true,
    );
    vi.mocked(getPublicTransportStopFromFeature).mockReturnValue(stop);
    vi.mocked(getPublicTransportStopChoicesForVisibleStop).mockReturnValue([
      stop,
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
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('transport:stop');
    expect(container.textContent).toContain('choices:closed');
    expect(updatePublicTransportStopSelection).toHaveBeenCalledWith(
      runtime.publicTransportStopsDisplay,
      stop,
    );
  });

  it('keeps a concrete stop usable when a remote safety identify fails', async () => {
    const hitFeature = {};
    const { runtime, mapEvents } = createRuntime({ hitFeature });
    const stop: PublicTransportStop = {
      id: 'fallback-stop',
      stationId: 'station-fallback',
      name: 'Stop fallback',
      modes: ['bus'],
      coordinate: [2_553_000, 1_171_000],
    };
    vi.mocked(publicTransportStopsCoverageContainsViewport).mockReturnValue(
      true,
    );
    vi.mocked(getPublicTransportStopFromFeature).mockReturnValue(stop);
    vi.mocked(getPublicTransportStopChoicesForVisibleStop).mockReturnValue([
      stop,
    ]);
    vi.mocked(identifyTrailClosure).mockRejectedValueOnce(
      new Error('GeoAdmin unavailable'),
    );
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

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
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(consoleError).toHaveBeenCalled();
    expect(container.textContent).toContain('transport:stop');
    expect(container.textContent).toContain('choices:closed');
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
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getPublicTransportStopChoicesForVisibleStop).toHaveBeenCalledWith(
      runtime.publicTransportStopsDisplay,
      runtime.map,
      visibleStop,
    );
    expect(container.textContent).toContain(
      'choices:publicTransportStop,publicTransportStop',
    );
    expect(updatePublicTransportStopSelection).not.toHaveBeenCalledWith(
      runtime.publicTransportStopsDisplay,
      visibleStop,
    );
  });

  it('dismisses a common chooser when zoom changes invalidate its click context', async () => {
    const hitFeature = {};
    const { runtime, mapEvents, viewEvents } = createRuntime({ hitFeature });
    const firstStop: PublicTransportStop = {
      id: 'zoom-a',
      stationId: 'station-zoom-a',
      name: 'Stop A',
      modes: ['bus'],
      coordinate: [2_553_000, 1_171_000],
    };
    const secondStop: PublicTransportStop = {
      id: 'zoom-b',
      stationId: 'station-zoom-b',
      name: 'Stop B',
      modes: ['tram'],
      coordinate: [2_553_100, 1_171_000],
    };
    vi.mocked(publicTransportStopsCoverageContainsViewport).mockReturnValue(
      true,
    );
    vi.mocked(getPublicTransportStopFromFeature).mockReturnValue(firstStop);
    vi.mocked(getPublicTransportStopChoicesForVisibleStop).mockReturnValue([
      firstStop,
      secondStop,
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
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain(
      'choices:publicTransportStop,publicTransportStop',
    );

    await act(async () => {
      viewEvents.emit('change:resolution');
    });

    expect(container.textContent).toContain('choices:closed');
  });

  it('combines safety, public transport, and SwitzerlandMobility matches in product order', async () => {
    const hitFeature = {};
    const { runtime, mapEvents } = createRuntime({ hitFeature });
    const stop: PublicTransportStop = {
      id: 'stop-a',
      stationId: 'station-a',
      name: 'Stop A',
      modes: ['bus'],
      coordinate: [2_553_000, 1_171_000],
    };
    vi.mocked(publicTransportStopsCoverageContainsViewport).mockReturnValue(
      true,
    );
    vi.mocked(getPublicTransportStopFromFeature).mockReturnValue(stop);
    vi.mocked(getPublicTransportStopChoicesForVisibleStop).mockReturnValue([
      stop,
    ]);
    vi.mocked(identifyTrailClosure).mockResolvedValueOnce({
      featureId: 'closure-1',
      context: {},
    } as never);
    vi.mocked(identifyShootingDangerZone).mockResolvedValueOnce({
      featureId: 'danger-1',
      geometry: null,
      context: {},
    } as never);
    routeHarness.candidates = [
      {
        featureId: 'route-1',
        routeNumber: '1',
        routeId: '1',
        routeName: 'Route 1',
        sectionName: null,
        stageNumber: null,
        hasStages: false,
      },
    ];

    await act(async () => {
      root?.render(
        createElement(Harness, {
          runtime,
          publicTransportStopsVisible: true,
          shootingDangerZonesVisible: true,
        }),
      );
    });

    await act(async () => {
      mapEvents.emit('singleclick', {
        pixel: [400, 300],
        coordinate: [2_553_000, 1_171_000],
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain(
      'choices:trailClosure,shootingDangerZone,publicTransportStop,switzerlandMobilityHiking',
    );
    expect(container.textContent).toContain('transport:closed');
    expect(container.textContent).toContain('route:closed');
  });

  it('resolves hidden neighbours before clearing a previously selected stop on a repeat click', async () => {
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
    const clickSequence: string[] = [];
    vi.mocked(getPublicTransportStopChoicesForVisibleStop).mockImplementation(
      () => {
        clickSequence.push('choices');
        return [visibleStop, hiddenStop];
      },
    );
    vi.mocked(updatePublicTransportStopSelection).mockImplementation(
      (_display, stop) => {
        if (stop === null) {
          clickSequence.push('clear');
        }
      },
    );

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
      await Promise.resolve();
      await Promise.resolve();
    });
    const firstStopChoice = informationHarness.mapInformationChoices?.find(
      (choice) =>
        choice.kind === 'publicTransportStop' && choice.stop.id === visibleStop.id,
    );
    expect(firstStopChoice).toBeDefined();
    await act(async () => {
      if (firstStopChoice) {
        informationHarness.selectMapInformationChoice?.(firstStopChoice);
      }
    });

    clickSequence.length = 0;
    vi.mocked(getPublicTransportStopChoicesForVisibleStop).mockClear();
    vi.mocked(updatePublicTransportStopSelection).mockClear();

    await act(async () => {
      mapEvents.emit('singleclick', {
        pixel: [400, 300],
        coordinate: [2_553_000, 1_171_000],
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      getPublicTransportStopChoicesForVisibleStop,
    ).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain(
      'choices:publicTransportStop,publicTransportStop',
    );
    expect(clickSequence.slice(0, 2)).toEqual(['choices', 'clear']);
  });

  it('keeps the clicked stop as declutter priority while remote identification is pending', async () => {
    const hitFeature = {};
    const { runtime, mapEvents } = createRuntime({ hitFeature });
    const renderedStop: PublicTransportStop = {
      id: 'stop-a',
      stationId: 'station-a',
      name: 'Stop A',
      modes: ['bus'],
      coordinate: [2_553_000, 1_171_000],
    };
    let resolveClosure: ((value: null) => void) | null = null;

    vi.mocked(publicTransportStopsCoverageContainsViewport).mockReturnValue(
      true,
    );
    vi.mocked(getPublicTransportStopFromFeature).mockReturnValue(renderedStop);
    vi.mocked(getPublicTransportStopChoicesForVisibleStop).mockReturnValue([
      renderedStop,
    ]);
    vi.mocked(identifyTrailClosure).mockImplementationOnce(
      () =>
        new Promise<null>((resolve) => {
          resolveClosure = resolve;
        }),
    );

    await act(async () => {
      root?.render(
        createElement(Harness, {
          runtime,
          publicTransportStopsVisible: true,
        }),
      );
    });

    vi.mocked(updatePublicTransportStopDeclutterPriority).mockClear();

    await act(async () => {
      mapEvents.emit('singleclick', {
        pixel: [400, 300],
        coordinate: [2_553_000, 1_171_000],
      });
      await Promise.resolve();
    });

    expect(updatePublicTransportStopDeclutterPriority).toHaveBeenCalledWith(
      runtime.publicTransportStopsDisplay,
      renderedStop.id,
    );
    expect(container.textContent).toContain('choices:closed');

    await act(async () => {
      resolveClosure?.(null);
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it('recomputes screen-space decluttering after render rather than on raw resolution changes', async () => {
    const { runtime, mapEvents, viewEvents } = createRuntime();
    vi.mocked(publicTransportStopsCoverageContainsViewport).mockReturnValue(
      true,
    );

    await act(async () => {
      root?.render(
        createElement(Harness, {
          runtime,
          publicTransportStopsVisible: true,
        }),
      );
    });

    vi.mocked(updatePublicTransportStopsViewRotation).mockClear();
    const declutterMock = vi.mocked(
      applyPublicTransportStopDeclutterVisibility,
    );
    declutterMock.mockClear();

    act(() => {
      viewEvents.emit('change:resolution');
    });
    expect(declutterMock).not.toHaveBeenCalled();

    act(() => {
      mapEvents.emit('postrender');
    });
    expect(declutterMock).toHaveBeenCalledWith(
      runtime.publicTransportStopsDisplay,
      runtime.map,
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
