/**
 * Business context: protects the product-level limit that keeps one snapped
 * route section close enough for a hiker to express the intended corridor.
 * The check must remain purely local and reject overlong sections before any
 * routing Worker request can begin.
 */
import { describe, expect, it } from 'vitest';
import { MAX_NETWORK_SECTION_DIRECT_DISTANCE_METERS } from './routingConstants';
import {
  assertNetworkRouteSectionDistance,
  getRouteSectionDirectDistanceMeters,
  RouteSectionTooLongError,
} from './routeSectionLimit';

describe('routeSectionLimit', () => {
  it('accepts the configured boundary and rejects the first longer section', () => {
    expect(() =>
      assertNetworkRouteSectionDistance(
        [0, 0],
        [MAX_NETWORK_SECTION_DIRECT_DISTANCE_METERS, 0],
      ),
    ).not.toThrow();

    expect(() =>
      assertNetworkRouteSectionDistance(
        [0, 0],
        [MAX_NETWORK_SECTION_DIRECT_DISTANCE_METERS + 1, 0],
      ),
    ).toThrow(RouteSectionTooLongError);
  });

  it('reports the direct LV95 distance and configured maximum', () => {
    expect(getRouteSectionDirectDistanceMeters([0, 0], [3_000, 4_000])).toBe(
      5_000,
    );

    try {
      assertNetworkRouteSectionDistance([0, 0], [16_000, 0]);
      throw new Error('Expected the route section to be rejected.');
    } catch (error) {
      expect(error).toBeInstanceOf(RouteSectionTooLongError);
      expect(error).toMatchObject({
        distanceMeters: 16_000,
        maximumDistanceMeters: MAX_NETWORK_SECTION_DIRECT_DISTANCE_METERS,
      });
    }
  });
});
