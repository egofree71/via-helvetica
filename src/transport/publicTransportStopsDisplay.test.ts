/**
 * Business context: protects the public-transport rendering contract that keeps
 * dense urban maps readable without losing access to individual official stops.
 * Decluttering is presentation-only and must coexist with close-stop fan-out.
 */
import type OlMap from 'ol/Map.js';
import Icon from 'ol/style/Icon.js';
import type Style from 'ol/style/Style.js';
import { describe, expect, it } from 'vitest';
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
    const first = createStop('a', [2_550_000, 1_170_000]);
    const second = createStop('b', [2_550_020, 1_170_000]);
    updatePublicTransportStopsDisplay(display, [first, second]);
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

  it('does not cache an incomplete declutter pass before pixels can be resolved', () => {
    const display = createPublicTransportStopsDisplay();
    const view = { getResolution: () => 10, getRotation: () => 0 };
    const map = {
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
