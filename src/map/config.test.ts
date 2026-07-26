/**
 * Business context: protects the provider contract for optional rendered map
 * overlays. A wrong technical identifier or image format would leave the layer
 * control functional while the SwitzerlandMobility routes remain invisible.
 */
import { describe, expect, it } from 'vitest';
import {
  createSwitzerlandMobilityHikingSource,
  HIKING_TRAILS_MIN_ZOOM,
  SWITZERLAND_MOBILITY_HIKING_MIN_ZOOM,
  SWITZERLAND_MOBILITY_HIKING_OPACITY,
} from './config';

describe('SwitzerlandMobility hiking WMTS source', () => {
  it('uses the same close-scale threshold as ordinary hiking trails', () => {
    expect(SWITZERLAND_MOBILITY_HIKING_MIN_ZOOM).toBe(
      HIKING_TRAILS_MIN_ZOOM,
    );
  });

  it('keeps the thick green portrayal partially transparent', () => {
    expect(SWITZERLAND_MOBILITY_HIKING_OPACITY).toBeGreaterThan(0);
    expect(SWITZERLAND_MOBILITY_HIKING_OPACITY).toBeLessThan(1);
    expect(SWITZERLAND_MOBILITY_HIKING_OPACITY).toBe(0.6);
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
