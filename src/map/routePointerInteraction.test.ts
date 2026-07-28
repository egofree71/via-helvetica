/**
 * Business context: protects the touch input split used while reshaping an
 * editable route. Deliberate drags may edit the itinerary and auto-pan near
 * viewport edges, while gestures starting elsewhere and every multi-touch
 * gesture remain available to normal map navigation.
 */
import type { Coordinate } from 'ol/coordinate.js';
import type OlMap from 'ol/Map.js';
import type MapBrowserEvent from 'ol/MapBrowserEvent.js';
import type { Pixel } from 'ol/pixel.js';
import { describe, expect, it, vi } from 'vitest';
import {
  createRouteDisplay,
  getRouteWaypointIndex,
  updateRouteDisplay,
} from './routeDisplay';
import {
  createRouteDragInteraction,
  type RouteDragCallbacks,
} from './routePointerInteraction';
import type { RouteState } from './routeState';

const ROUTE_STATE: RouteState = {
  steps: [
    {
      waypoint: [100, 100],
      segment: null,
      mode: 'straight',
    },
    {
      waypoint: [200, 100],
      segment: [
        [100, 100],
        [200, 100],
      ],
      mode: 'straight',
    },
  ],
  closure: null,
};

type HitTarget = 'waypoint' | 'segment' | 'none';

interface InteractionHarness {
  interaction: ReturnType<typeof createRouteDragInteraction>;
  callbacks: {
    [Key in keyof RouteDragCallbacks]: ReturnType<typeof vi.fn>;
  };
  createEvent: (
    type: string,
    pixel: Pixel,
    pointerType?: string,
    pointerCount?: number,
  ) => MapBrowserEvent;
  /** Returns the mutable view centre used by auto-pan assertions. */
  getViewCenter: () => Coordinate;
}

/** Creates a small OpenLayers interaction harness without rendering a map. */
function createHarness(hitTarget: HitTarget): InteractionHarness {
  const display = createRouteDisplay();
  updateRouteDisplay(display, ROUTE_STATE.steps, ROUTE_STATE.closure);
  const waypointFeature = display.source
    .getFeatures()
    .find((feature) => getRouteWaypointIndex(feature) === 0);

  expect(waypointFeature).toBeDefined();

  const target = document.createElement('div');
  let viewCenter: Coordinate = [0, 0];
  const view = {
    getResolution: () => 1,
    getRotation: () => 0,
    getCenter: () => [...viewCenter],
    setCenter: (coordinate: Coordinate) => {
      viewCenter = [...coordinate];
    },
  };
  const map = {
    forEachFeatureAtPixel: (
      _pixel: Pixel,
      callback: (feature: NonNullable<typeof waypointFeature>) => unknown,
    ) =>
      hitTarget === 'waypoint' ? callback(waypointFeature!) : undefined,
    getTargetElement: () => target,
    getCoordinateFromPixel: (pixel: Pixel) => [
      pixel[0] + viewCenter[0],
      pixel[1] + viewCenter[1],
    ],
    getSize: () => [300, 200],
    getView: () => view,
  } as unknown as OlMap;

  const callbacks = {
    canStart: vi.fn(() => true),
    getRouteState: vi.fn(() => ROUTE_STATE),
    onStart: vi.fn(),
    onTapWaypoint: vi.fn(),
    onDrag: vi.fn(),
    onCancel: vi.fn(),
    onHover: vi.fn(),
    onEnd: vi.fn(),
  } satisfies RouteDragCallbacks;

  const interaction = createRouteDragInteraction(display, callbacks);
  const createEvent = (
    type: string,
    pixel: Pixel,
    pointerType = 'touch',
    pointerCount = 1,
  ) => {
    const originalEvent = {
      pointerType,
      preventDefault: vi.fn(),
    } as unknown as PointerEvent;
    const activePointers = Array.from(
      { length: pointerCount },
      (_, index) =>
        ({
          pointerId: index + 1,
          pointerType,
          clientX: pixel[0] + index * 20,
          clientY: pixel[1],
        }) as PointerEvent,
    );

    return {
      type,
      map,
      originalEvent,
      activePointers,
      pixel: [...pixel],
      coordinate: map.getCoordinateFromPixel(pixel) ?? [...pixel],
    } as unknown as MapBrowserEvent;
  };

  return {
    interaction,
    callbacks: callbacks as InteractionHarness['callbacks'],
    createEvent,
    getViewCenter: () => [...viewCenter],
  };
}

describe('route pointer interaction', () => {
  it('leaves finger gestures away from the itinerary available to map navigation', () => {
    const { interaction, callbacks, createEvent } = createHarness('none');

    const shouldPropagate = interaction.handleEvent(
      createEvent('pointerdown', [150, 120]),
    );

    expect(shouldPropagate).toBe(true);
    expect(callbacks.onStart).not.toHaveBeenCalled();
  });

  it('reports a waypoint tap without starting a drag preview', () => {
    const { interaction, callbacks, createEvent } = createHarness('waypoint');

    expect(
      interaction.handleEvent(createEvent('pointerdown', [100, 100])),
    ).toBe(false);
    interaction.handleEvent(createEvent('pointerdrag', [105, 100]));
    interaction.handleEvent(createEvent('pointerup', [105, 100], 'touch', 0));

    expect(callbacks.onTapWaypoint).toHaveBeenCalledTimes(1);
    expect(callbacks.onTapWaypoint).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'waypoint', waypointIndex: 0 }),
      [105, 100],
    );
    expect(callbacks.onStart).not.toHaveBeenCalled();
    expect(callbacks.onDrag).not.toHaveBeenCalled();
    expect(callbacks.onEnd).not.toHaveBeenCalled();
  });

  it('moves an existing waypoint after deliberate one-finger movement', () => {
    const { interaction, callbacks, createEvent } = createHarness('waypoint');

    interaction.handleEvent(createEvent('pointerdown', [100, 100]));
    interaction.handleEvent(createEvent('pointerdrag', [112, 100]));
    interaction.handleEvent(createEvent('pointerup', [112, 100], 'touch', 0));

    expect(callbacks.onStart).toHaveBeenCalledTimes(1);
    expect(callbacks.onStart).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'waypoint', waypointIndex: 0 }),
    );
    expect(callbacks.onDrag).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'waypoint', waypointIndex: 0 }),
      [112, 100],
    );
    expect(callbacks.onEnd).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'waypoint', waypointIndex: 0 }),
      [112, 100],
      true,
      [112, 100],
    );
    expect(callbacks.onTapWaypoint).not.toHaveBeenCalled();
  });

  it('auto-pans the map and keeps the dragged waypoint attached near an edge', () => {
    const scheduledFrames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 1;
    const originalRequestAnimationFrame = window.requestAnimationFrame;
    const originalCancelAnimationFrame = window.cancelAnimationFrame;

    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: vi.fn((callback: FrameRequestCallback) => {
        const frameId = nextFrameId;
        nextFrameId += 1;
        scheduledFrames.set(frameId, callback);
        return frameId;
      }),
    });
    Object.defineProperty(window, 'cancelAnimationFrame', {
      configurable: true,
      value: vi.fn((frameId: number) => {
        scheduledFrames.delete(frameId);
      }),
    });

    try {
      const { interaction, callbacks, createEvent, getViewCenter } =
        createHarness('waypoint');
      const runNextFrame = (timestamp: number) => {
        const nextFrame = scheduledFrames.entries().next().value as
          | [number, FrameRequestCallback]
          | undefined;

        expect(nextFrame).toBeDefined();
        scheduledFrames.delete(nextFrame![0]);
        nextFrame![1](timestamp);
      };

      interaction.handleEvent(
        createEvent('pointerdown', [100, 100], 'mouse'),
      );
      interaction.handleEvent(
        createEvent('pointerdrag', [295, 100], 'mouse'),
      );

      expect(callbacks.onDrag).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: 'waypoint', waypointIndex: 0 }),
        [295, 100],
      );
      expect(scheduledFrames.size).toBe(1);

      // The first frame establishes timing; the second applies a bounded pan.
      runNextFrame(0);
      runNextFrame(16);

      const autoPannedCoordinate = callbacks.onDrag.mock.calls.at(-1)?.[1] as
        | Coordinate
        | undefined;

      expect(getViewCenter()[0]).toBeGreaterThan(0);
      expect(autoPannedCoordinate?.[0]).toBeGreaterThan(295);

      interaction.handleEvent(
        createEvent('pointerup', [295, 100], 'mouse', 0),
      );

      const releasedCoordinate = callbacks.onEnd.mock.calls.at(-1)?.[1] as
        | Coordinate
        | undefined;

      expect(releasedCoordinate?.[0]).toBeGreaterThan(295);
      expect(scheduledFrames.size).toBe(0);
    } finally {
      Object.defineProperty(window, 'requestAnimationFrame', {
        configurable: true,
        value: originalRequestAnimationFrame,
      });
      Object.defineProperty(window, 'cancelAnimationFrame', {
        configurable: true,
        value: originalCancelAnimationFrame,
      });
    }
  });

  it('does not turn a route-section tap or normal finger tremor into an edit', () => {
    const { interaction, callbacks, createEvent } = createHarness('segment');

    expect(
      interaction.handleEvent(createEvent('pointerdown', [150, 100])),
    ).toBe(false);
    interaction.handleEvent(createEvent('pointerdrag', [155, 100]));
    interaction.handleEvent(createEvent('pointerup', [155, 100], 'touch', 0));

    expect(callbacks.onStart).not.toHaveBeenCalled();
    expect(callbacks.onDrag).not.toHaveBeenCalled();
    expect(callbacks.onTapWaypoint).not.toHaveBeenCalled();
    expect(callbacks.onEnd).not.toHaveBeenCalled();
  });

  it('pulls a new waypoint from a nearby route section after deliberate movement', () => {
    const { interaction, callbacks, createEvent } = createHarness('segment');

    interaction.handleEvent(createEvent('pointerdown', [150, 100]));
    interaction.handleEvent(createEvent('pointerdrag', [150, 112]));
    interaction.handleEvent(createEvent('pointerup', [150, 112], 'touch', 0));

    expect(callbacks.onStart).toHaveBeenCalledTimes(1);
    expect(callbacks.onStart).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'segment', stepIndex: 1 }),
    );
    expect(callbacks.onDrag).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'segment', stepIndex: 1 }),
      [150, 112],
    );
    expect(callbacks.onEnd).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'segment', stepIndex: 1 }),
      [150, 112],
      true,
      [150, 112],
    );
  });

  it('cancels a waypoint preview when a second finger starts pinch zoom', () => {
    const { interaction, callbacks, createEvent } = createHarness('waypoint');

    interaction.handleEvent(createEvent('pointerdown', [100, 100]));
    interaction.handleEvent(createEvent('pointerdrag', [112, 100]));
    interaction.handleEvent(
      createEvent('pointerdown', [112, 100], 'touch', 2),
    );
    interaction.handleEvent(
      createEvent('pointerdrag', [116, 100], 'touch', 2),
    );
    interaction.handleEvent(createEvent('pointerup', [116, 100], 'touch', 1));

    expect(callbacks.onStart).toHaveBeenCalledTimes(1);
    expect(callbacks.onCancel).toHaveBeenCalledTimes(1);
    expect(callbacks.onTapWaypoint).not.toHaveBeenCalled();
    expect(callbacks.onEnd).not.toHaveBeenCalled();
  });

  it('cancels a route-section preview when a second finger starts pinch zoom', () => {
    const { interaction, callbacks, createEvent } = createHarness('segment');

    interaction.handleEvent(createEvent('pointerdown', [150, 100]));
    interaction.handleEvent(createEvent('pointerdrag', [150, 112]));
    interaction.handleEvent(
      createEvent('pointerdown', [150, 112], 'touch', 2),
    );
    interaction.handleEvent(
      createEvent('pointerdrag', [150, 116], 'touch', 2),
    );
    interaction.handleEvent(createEvent('pointerup', [150, 116], 'touch', 1));

    expect(callbacks.onStart).toHaveBeenCalledTimes(1);
    expect(callbacks.onCancel).toHaveBeenCalledTimes(1);
    expect(callbacks.onEnd).not.toHaveBeenCalled();
  });

  it('does not commit when one finger is released from a multi-touch gesture', () => {
    const { interaction, callbacks, createEvent } = createHarness('waypoint');

    interaction.handleEvent(createEvent('pointerdown', [100, 100]));
    interaction.handleEvent(createEvent('pointerdrag', [112, 100]));
    interaction.handleEvent(
      createEvent('pointerdown', [112, 100], 'touch', 2),
    );
    interaction.handleEvent(createEvent('pointerup', [112, 100], 'touch', 1));

    expect(callbacks.onCancel).toHaveBeenCalledTimes(1);
    expect(callbacks.onTapWaypoint).not.toHaveBeenCalled();
    expect(callbacks.onEnd).not.toHaveBeenCalled();
  });
});
