/**
 * Business context: protects the public-transport rendering contract that keeps
 * dense urban maps readable without losing access to individual official stops.
 * Decluttering is presentation-only and must coexist with close-stop fan-out.
 */
import type OlMap from 'ol/Map.js';
import Icon from 'ol/style/Icon.js';
import type Style from 'ol/style/Style.js';
import { describe, expect, it, vi } from 'vitest';
import type { PublicTransportStop } from './publicTransportStopModel';
import {
  applyPublicTransportStopDeclutterVisibility,
  createPublicTransportStopsDisplay,
  getPublicTransportStopChoicesForVisibleStop,
  getPublicTransportStopFromFeature,
  updatePublicTransportStopDeclutterPriority,
  updatePublicTransportStopSelection,
  updatePublicTransportStopsDisplay,
  updatePublicTransportStopsViewRotation,
  type PublicTransportStopsDisplay,
} from './publicTransportStopsDisplay';

/** Creates one normalized passenger stop with only fields relevant to rendering. */
function createStop(
  id: string,
  coordinate: [number, number],
): PublicTransportStop {
  return {
    id,
    stationId: `station-${id}`,
    name: `Stop ${id}`,
    modes: ['bus'],
    coordinate,
  };
}

/** Minimal rotated-map surface needed by the screen-space decluttering code. */
function createMapHarness(
  initialResolution: number,
  initialRotation = 0,
): {
  map: OlMap;
  setResolution: (resolution: number) => void;
  setRotation: (rotation: number) => void;
} {
  let resolution = initialResolution;
  let rotation = initialRotation;
  const view = {
    getResolution: () => resolution,
    getRotation: () => rotation,
  };
  const map = {
    getSize: () => [1_000, 800],
    getView: () => view,
    getPixelFromCoordinate: (coordinate: [number, number]) => {
      const x = coordinate[0] / resolution;
      const y = coordinate[1] / resolution;
      const cosRotation = Math.cos(rotation);
      const sinRotation = Math.sin(rotation);
      const screenX = x * cosRotation + y * sinRotation;
      const screenYUp = -x * sinRotation + y * cosRotation;
      return [screenX, -screenYUp];
    },
  } as unknown as OlMap;

  return {
    map,
    setResolution: (nextResolution) => {
      resolution = nextResolution;
    },
    setRotation: (nextRotation) => {
      rotation = nextRotation;
    },
  };
}

/** Returns stop ids whose layer style currently survives decluttering. */
function renderedStopIds(
  display: PublicTransportStopsDisplay,
  resolution: number,
): string[] {
  const styleFunction = display.layer.getStyleFunction();

  if (!styleFunction) {
    return [];
  }

  return display.source
    .getFeatures()
    .filter((feature) => styleFunction(feature, resolution) !== undefined)
    .map((feature) => getPublicTransportStopFromFeature(feature)?.id)
    .filter((id): id is string => id !== undefined)
    .sort();
}

describe('publicTransportStopsDisplay decluttering', () => {
  it('keeps newly loaded stops hidden until the first rendered-frame declutter pass', () => {
    const display = createPublicTransportStopsDisplay();
    const { map } = createMapHarness(10);
    const stops = [
      createStop('a', [2_550_000, 1_170_000]),
      createStop('b', [2_550_100, 1_170_000]),
    ];

    updatePublicTransportStopsDisplay(display, stops);
    expect(renderedStopIds(display, 10)).toEqual([]);

    applyPublicTransportStopDeclutterVisibility(display, map);
    expect(renderedStopIds(display, 10).length).toBeGreaterThan(0);
  });

  it('preserves rendered shared stops while a buffered viewport adds new data', () => {
    const display = createPublicTransportStopsDisplay();
    const { map } = createMapHarness(10);
    const first = createStop('a', [2_550_000, 1_170_000]);
    const second = createStop('b', [2_550_500, 1_170_000]);

    updatePublicTransportStopsDisplay(display, [first, second]);
    applyPublicTransportStopDeclutterVisibility(display, map);
    const originalFirstFeature = display.source.getFeatureById(first.id);

    expect(renderedStopIds(display, 10)).toEqual(['a', 'b']);

    const enteringStop = createStop('c', [2_551_000, 1_170_000]);
    updatePublicTransportStopsDisplay(display, [first, second, enteringStop]);

    // Existing symbols stay painted while brand-new buffer members wait for the
    // postrender declutter pass. This avoids a whole-layer blink on coverage refresh.
    expect(display.source.getFeatureById(first.id)).toBe(originalFirstFeature);
    expect(renderedStopIds(display, 10)).toEqual(['a', 'b']);

    applyPublicTransportStopDeclutterVisibility(display, map);
    expect(renderedStopIds(display, 10)).toEqual(['a', 'b', 'c']);
  });

  it('does not invalidate the layer when a declutter pass keeps the same visibility', () => {
    const display = createPublicTransportStopsDisplay();
    const { map } = createMapHarness(10);
    const changedSpy = vi.spyOn(display.layer, 'changed');
    const stops = [
      createStop('a', [2_550_000, 1_170_000]),
      createStop('b', [2_550_500, 1_170_000]),
    ];

    updatePublicTransportStopsDisplay(display, stops);
    applyPublicTransportStopDeclutterVisibility(display, map);
    changedSpy.mockClear();

    // Giving priority to an already visible stop invalidates the snapshot but
    // should not rebuild the OpenLayers replay group if visibility is unchanged.
    updatePublicTransportStopDeclutterPriority(display, 'a');
    applyPublicTransportStopDeclutterVisibility(display, map);

    expect(changedSpy).not.toHaveBeenCalled();
  });

  it('keeps close stops fanned out and simultaneously renderable', () => {
    const display = createPublicTransportStopsDisplay();
    const { map } = createMapHarness(10);
    const stops = [
      createStop('a', [2_550_000, 1_170_000]),
      createStop('b', [2_550_020, 1_170_000]),
    ];

    updatePublicTransportStopsDisplay(display, stops);
    applyPublicTransportStopDeclutterVisibility(display, map);

    expect(renderedStopIds(display, 10)).toEqual(['a', 'b']);
    expect(display.source.getFeatures()).toHaveLength(2);
  });

  it('hides a colliding stop without removing it from the source', () => {
    const display = createPublicTransportStopsDisplay();
    const { map } = createMapHarness(10);
    const stops = [
      createStop('a', [2_550_000, 1_170_000]),
      createStop('b', [2_550_100, 1_170_000]),
    ];

    updatePublicTransportStopsDisplay(display, stops);
    applyPublicTransportStopDeclutterVisibility(display, map);

    expect(renderedStopIds(display, 10)).toEqual(['a']);
    expect(display.source.getFeatures()).toHaveLength(2);
  });

  it('gives the selected stop priority over a colliding neighbour', () => {
    const display = createPublicTransportStopsDisplay();
    const { map } = createMapHarness(10);
    const first = createStop('a', [2_550_000, 1_170_000]);
    const second = createStop('b', [2_550_100, 1_170_000]);

    updatePublicTransportStopsDisplay(display, [first, second]);
    updatePublicTransportStopSelection(display, second);
    applyPublicTransportStopDeclutterVisibility(display, map);

    expect(renderedStopIds(display, 10)).toEqual(['b']);
    expect(display.selectionSource.getFeatures()).toHaveLength(1);
  });

  it('lets hidden stops reappear naturally at a more detailed resolution', () => {
    const display = createPublicTransportStopsDisplay();
    const { map, setResolution } = createMapHarness(10);
    const stops = [
      createStop('a', [2_550_000, 1_170_000]),
      createStop('b', [2_550_100, 1_170_000]),
    ];

    updatePublicTransportStopsDisplay(display, stops);
    applyPublicTransportStopDeclutterVisibility(display, map);
    expect(renderedStopIds(display, 10)).toEqual(['a']);

    setResolution(1);
    applyPublicTransportStopDeclutterVisibility(display, map);
    expect(renderedStopIds(display, 1)).toEqual(['a', 'b']);
  });

  it('produces the same visible ids for identical data and view inputs', () => {
    const display = createPublicTransportStopsDisplay();
    const { map } = createMapHarness(10);
    const stops = [
      createStop('c', [2_550_180, 1_170_000]),
      createStop('a', [2_550_000, 1_170_000]),
      createStop('b', [2_550_100, 1_170_000]),
    ];

    updatePublicTransportStopsDisplay(display, stops);
    applyPublicTransportStopDeclutterVisibility(display, map);
    const firstPass = renderedStopIds(display, 10);

    updatePublicTransportStopsDisplay(display, [...stops].reverse());
    applyPublicTransportStopDeclutterVisibility(display, map);

    expect(renderedStopIds(display, 10)).toEqual(firstPass);
  });

  it('returns hidden neighbours only after a visible stop has been hit', () => {
    const display = createPublicTransportStopsDisplay();
    const { map } = createMapHarness(10);
    const first = createStop('a', [2_550_000, 1_170_000]);
    const second = createStop('b', [2_550_100, 1_170_000]);

    updatePublicTransportStopsDisplay(display, [first, second]);
    applyPublicTransportStopDeclutterVisibility(display, map);

    expect(
      getPublicTransportStopChoicesForVisibleStop(display, map, first).map(
        (stop) => stop.id,
      ),
    ).toEqual(['a', 'b']);
  });

  it('does not expose an unrelated hidden stop from a distant visible symbol', () => {
    const display = createPublicTransportStopsDisplay();
    const { map } = createMapHarness(10);
    const first = createStop('a', [2_550_000, 1_170_000]);
    const hiddenNeighbour = createStop('b', [2_550_100, 1_170_000]);
    const distantVisible = createStop('c', [2_551_000, 1_170_000]);

    updatePublicTransportStopsDisplay(display, [
      first,
      hiddenNeighbour,
      distantVisible,
    ]);
    applyPublicTransportStopDeclutterVisibility(display, map);

    expect(
      getPublicTransportStopChoicesForVisibleStop(
        display,
        map,
        distantVisible,
      ).map((stop) => stop.id),
    ).toEqual(['c']);
  });

  it('keeps chooser priority separate from the selected-stop halo across reloads', () => {
    const display = createPublicTransportStopsDisplay();
    const stops = [
      createStop('a', [2_550_000, 1_170_000]),
      createStop('b', [2_550_100, 1_170_000]),
    ];

    updatePublicTransportStopsDisplay(display, stops);
    updatePublicTransportStopDeclutterPriority(display, 'a');
    expect(display.selectionSource.getFeatures()).toHaveLength(0);
    expect(display.selectedStopId).toBeNull();

    updatePublicTransportStopsDisplay(display, stops);

    expect(display.selectionSource.getFeatures()).toHaveLength(0);
    expect(display.selectedStopId).toBeNull();
    expect(display.declutterPriorityStopId).toBe('a');
  });

  it('rotates fan-out displacement into screen axes', () => {
    const display = createPublicTransportStopsDisplay();
    const { map } = createMapHarness(10);
    const first = createStop('a', [2_550_000, 1_170_000]);
    const second = createStop('b', [2_550_020, 1_170_000]);
    updatePublicTransportStopsDisplay(display, [first, second]);
    applyPublicTransportStopDeclutterVisibility(display, map);
    const feature = display.source.getFeatureById(first.id);
    const styleFunction = display.layer.getStyleFunction();

    expect(feature).not.toBeNull();
    expect(styleFunction).toBeDefined();

    const styleAtZero = styleFunction?.(feature!, 10) as Style;
    const zeroDisplacement = (styleAtZero.getImage() as Icon).getDisplacement();

    updatePublicTransportStopsViewRotation(display, Math.PI / 2);
    const styleAtQuarterTurn = styleFunction?.(feature!, 10) as Style;
    const rotatedDisplacement = (
      styleAtQuarterTurn.getImage() as Icon
    ).getDisplacement();

    expect(zeroDisplacement[1]).toBe(0);
    expect(rotatedDisplacement[1]).not.toBe(0);
  });

  it('declutters former fan-out members again after the fan-out is released', () => {
    const display = createPublicTransportStopsDisplay();
    const { map } = createMapHarness(2);
    const stops = [
      createStop('a', [2_550_000, 1_170_000]),
      createStop('b', [2_550_002, 1_170_000]),
      createStop('c', [2_550_060, 1_170_000]),
    ];

    updatePublicTransportStopsDisplay(display, stops);
    applyPublicTransportStopDeclutterVisibility(display, map);

    expect(renderedStopIds(display, 2)).toEqual(['a', 'c']);
  });

  it('does not schedule another render from a zero-area map frame', () => {
    const display = createPublicTransportStopsDisplay();
    const view = { getResolution: () => 10, getRotation: () => 0 };
    const map = {
      getSize: () => [0, 0],
      getView: () => view,
    } as unknown as OlMap;
    const changedSpy = vi.spyOn(display.layer, 'changed');

    updatePublicTransportStopsDisplay(display, [
      createStop('a', [2_550_000, 1_170_000]),
    ]);
    changedSpy.mockClear();
    applyPublicTransportStopDeclutterVisibility(display, map);

    expect(changedSpy).not.toHaveBeenCalled();
    expect(display.declutterSnapshot).toBeNull();
  });

  it('does not cache an incomplete declutter pass before pixels can be resolved', () => {
    const display = createPublicTransportStopsDisplay();
    const view = { getResolution: () => 10, getRotation: () => 0 };
    const map = {
      getSize: () => [1_000, 800],
      getView: () => view,
      getPixelFromCoordinate: () => null,
    } as unknown as OlMap;

    updatePublicTransportStopsDisplay(display, [
      createStop('a', [2_550_000, 1_170_000]),
      createStop('b', [2_550_100, 1_170_000]),
    ]);
    applyPublicTransportStopDeclutterVisibility(display, map);

    expect(renderedStopIds(display, 10)).toEqual(['a', 'b']);
    expect(display.declutterSnapshot).toBeNull();
  });

});
