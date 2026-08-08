/**
 * Business context: protects responsive GPX framing so mobile viewports never
 * lose almost all usable map space to desktop-oriented fit padding.
 */
import { describe, expect, it } from 'vitest';
import {
  calculateImportedRouteFitPadding,
  snapImportedRouteFitResolution,
} from './useImportedRoute';

describe('calculateImportedRouteFitPadding', () => {
  it('keeps the intended margins on a sufficiently large viewport', () => {
    expect(calculateImportedRouteFitPadding([1_200, 800])).toEqual([
      80, 80, 180, 80,
    ]);
  });

  it('scales vertical margins while preserving a usable landscape fit area', () => {
    const padding = calculateImportedRouteFitPadding([667, 240]);

    expect(padding[0] + padding[2]).toBeLessThanOrEqual(80);
    expect(240 - padding[0] - padding[2]).toBeGreaterThanOrEqual(160);
    expect(padding[1]).toBe(80);
    expect(padding[3]).toBe(80);
  });

  it('scales both axes on a very small viewport', () => {
    const padding = calculateImportedRouteFitPadding([200, 200]);

    expect(200 - padding[1] - padding[3]).toBeGreaterThanOrEqual(160);
    expect(200 - padding[0] - padding[2]).toBeGreaterThanOrEqual(160);
  });
});

describe('snapImportedRouteFitResolution', () => {
  it('uses the next coarser native WMTS matrix so the complete route still fits', () => {
    expect(snapImportedRouteFitResolution(3.2)).toBe(5);
    expect(snapImportedRouteFitResolution(0.8)).toBe(1);
  });

  it('skips unpublished matrix 24 instead of resampling the standard base map', () => {
    expect(snapImportedRouteFitResolution(1.4)).toBe(2);
  });

  it('never frames a short GPX beyond the configured native maximum zoom', () => {
    expect(snapImportedRouteFitResolution(0.2)).toBe(0.5);
  });
});
