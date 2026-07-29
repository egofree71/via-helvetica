/**
 * Business context: protects public-route map framing. Selected stages must fit
 * above the compact panel and remain clear of permanent map controls on every
 * viewport, using the same margins as imported GPX itineraries.
 */
import { describe, expect, it } from 'vitest';
import {
  calculateSwitzerlandMobilityHikingFitPadding,
  isSameSwitzerlandMobilityHikingFeature,
} from './useSwitzerlandMobilityHikingSelection';

describe('calculateSwitzerlandMobilityHikingFitPadding', () => {
  it('keeps the intended route-panel margins on a desktop viewport', () => {
    expect(calculateSwitzerlandMobilityHikingFitPadding([1_200, 800])).toEqual([
      80, 80, 180, 80,
    ]);
  });

  it('scales vertical margins on a short landscape mobile viewport', () => {
    const padding = calculateSwitzerlandMobilityHikingFitPadding([667, 240]);

    expect(240 - padding[0] - padding[2]).toBeGreaterThanOrEqual(160);
    expect(padding[1]).toBe(80);
    expect(padding[3]).toBe(80);
  });

  it('scales both axes when the viewport is extremely small', () => {
    const padding = calculateSwitzerlandMobilityHikingFitPadding([200, 200]);

    expect(200 - padding[1] - padding[3]).toBeGreaterThanOrEqual(160);
    expect(200 - padding[0] - padding[2]).toBeGreaterThanOrEqual(160);
  });
});

describe('isSameSwitzerlandMobilityHikingFeature', () => {
  it('treats string and numeric GeoAdmin identifiers as the same feature', () => {
    expect(
      isSameSwitzerlandMobilityHikingFeature(
        { featureId: '4.17' },
        { featureId: '4.17' },
      ),
    ).toBe(true);
    expect(
      isSameSwitzerlandMobilityHikingFeature(
        { featureId: 571 },
        { featureId: '571' },
      ),
    ).toBe(true);
  });

  it('keeps distinct overlapping routes separate', () => {
    expect(
      isSameSwitzerlandMobilityHikingFeature(
        { featureId: '2.18' },
        { featureId: '4.7' },
      ),
    ).toBe(false);
    expect(
      isSameSwitzerlandMobilityHikingFeature(null, { featureId: '4.7' }),
    ).toBe(false);
  });
});
