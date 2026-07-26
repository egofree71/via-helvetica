/**
 * Business context: protects the provider contract for optional rendered map
 * overlays. A wrong technical identifier or image format would leave the layer
 * control functional while the SwitzerlandMobility routes remain invisible.
 */
import { describe, expect, it } from 'vitest';
import {
  createSwitzerlandMobilityHikingSource,
  DEFAULT_HIKING_TRAILS_OPACITY,
  DEFAULT_SWITZERLAND_MOBILITY_HIKING_OPACITY,
  HIKING_TRAILS_MIN_ZOOM,
  SWITZERLAND_MOBILITY_HIKING_MIN_ZOOM,
} from './config';

describe('rendered hiking overlays', () => {
  it('uses the same close-scale threshold as ordinary hiking trails', () => {
    expect(SWITZERLAND_MOBILITY_HIKING_MIN_ZOOM).toBe(
      HIKING_TRAILS_MIN_ZOOM,
    );
  });

  it('uses distinct readable defaults for the two hiking portrayals', () => {
    expect(DEFAULT_HIKING_TRAILS_OPACITY).toBe(0.8);
    expect(DEFAULT_SWITZERLAND_MOBILITY_HIKING_OPACITY).toBe(0.6);
  });

  it('uses the official Wanderland PNG layer in native LV95', () => {
    const source = createSwitzerlandMobilityHikingSource();

    expect(source.getLayer()).toBe('ch.astra.wanderland');
    expect(source.getFormat()).toBe('image/png');
    expect(source.getMatrixSet()).toBe('2056');
    expect(source.getUrls()).toEqual([
      'https://wmts.geo.admin.ch/1.0.0/ch.astra.wanderland/default/current/2056/{TileMatrix}/{TileCol}/{TileRow}.png',
    ]);
  });
});
