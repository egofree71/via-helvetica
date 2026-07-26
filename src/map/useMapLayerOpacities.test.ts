/**
 * Business context: protects the semitransparent hiking defaults and the
 * browser persistence used by the shared information-layer opacity sliders.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MAP_LAYER_OPACITIES,
  normalizeMapLayerOpacity,
  resolveInitialMapLayerOpacities,
} from './useMapLayerOpacities';

const HIKING_TRAILS_STORAGE_KEY =
  'via-helvetica.hiking-trails-opacity';
const TRAIL_CLOSURES_STORAGE_KEY =
  'via-helvetica.trail-closures-opacity';

describe('map information-layer opacity preferences', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it(
    'starts the yellow hiking portrayal more strongly than the green routes',
    () => {
      const opacities = resolveInitialMapLayerOpacities();

      expect(opacities.hikingTrails).toBe(0.8);
      expect(opacities.switzerlandMobilityHiking).toBe(0.6);
      expect(opacities.trailClosures).toBe(0.8);
      expect(opacities).toEqual(DEFAULT_MAP_LAYER_OPACITIES);
    },
  );

  it('restores valid ratios and ignores malformed stored values', () => {
    window.localStorage.setItem(HIKING_TRAILS_STORAGE_KEY, '0.35');
    window.localStorage.setItem(TRAIL_CLOSURES_STORAGE_KEY, 'unexpected');

    const opacities = resolveInitialMapLayerOpacities();

    expect(opacities.hikingTrails).toBe(0.35);
    expect(opacities.trailClosures).toBe(
      DEFAULT_MAP_LAYER_OPACITIES.trailClosures,
    );
  });

  it('clamps slider ratios to the OpenLayers range', () => {
    expect(normalizeMapLayerOpacity(-0.5)).toBe(0);
    expect(normalizeMapLayerOpacity(0.45)).toBe(0.45);
    expect(normalizeMapLayerOpacity(2)).toBe(1);
    expect(normalizeMapLayerOpacity(Number.NaN)).toBe(1);
  });
});
