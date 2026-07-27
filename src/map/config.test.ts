/**
 * Business context: protects centralized map limits and provider contracts.
 * Wrong geographic bounds can accept unrelated coordinates, while a wrong
 * rendered-layer identifier can leave an apparently functional control blank.
 */
import { describe, expect, it } from 'vitest';
import {
  COORDINATE_SEARCH_ZOOM,
  createSwitzerlandMobilityHikingSource,
  DEFAULT_HIKING_TRAILS_OPACITY,
  DEFAULT_SWITZERLAND_MOBILITY_HIKING_OPACITY,
  HIKING_TRAILS_MIN_ZOOM,
  isWgs84CoordinateInsideMapBounds,
  LOCATION_SEARCH_ZOOM,
  SWITZERLAND_MOBILITY_HIKING_MIN_ZOOM,
  USER_LOCATION_ZOOM,
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

describe('WGS 84 map bounds', () => {
  it('accepts the Swiss map margin without projecting distant coordinates', () => {
    expect(isWgs84CoordinateInsideMapBounds([8.383, 46.987])).toBe(true);
    expect(isWgs84CoordinateInsideMapBounds([-174, -48])).toBe(false);
  });
});

describe('search zoom policy', () => {
  it('frames exact coordinates closer than place results', () => {
    expect(COORDINATE_SEARCH_ZOOM).toBe(USER_LOCATION_ZOOM);
    expect(COORDINATE_SEARCH_ZOOM).toBeGreaterThan(LOCATION_SEARCH_ZOOM);
  });
});

