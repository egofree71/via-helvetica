/**
 * Business context: protects the non-destructive map adjustment used by stop,
 * closure, and danger-zone panels. The selected click must remain visible
 * without forcing a zoom change or fitting an arbitrarily large feature.
 */
import { describe, expect, it } from 'vitest';
import {
  calculateVisibleMapInformationAnchorPixel,
} from './mapInformationViewport';

describe('map information viewport', () => {
  it('keeps an already visible stop coordinate unchanged', () => {
    expect(
      calculateVisibleMapInformationAnchorPixel({
        anchorPixel: [700, 400],
        mapSize: [1_000, 700],
        popupRect: { left: 16, top: 80, right: 384, bottom: 500 },
        placement: 'keep-visible',
      }),
    ).toBeNull();
  });

  it('keeps a stop coordinate away from the outer viewport edge', () => {
    expect(
      calculateVisibleMapInformationAnchorPixel({
        anchorPixel: [5, 680],
        mapSize: [1_000, 700],
        popupRect: { left: 16, top: 80, right: 384, bottom: 500 },
        placement: 'keep-visible',
      }),
    ).toEqual([24, 676]);
  });

  it('moves a hidden stop only as far as needed beside the panel', () => {
    expect(
      calculateVisibleMapInformationAnchorPixel({
        anchorPixel: [180, 200],
        mapSize: [1_000, 700],
        popupRect: { left: 16, top: 80, right: 384, bottom: 500 },
        placement: 'keep-visible',
      }),
    ).toEqual([402, 200]);
  });

  it('centres a nearby closure click in the largest free desktop region', () => {
    expect(
      calculateVisibleMapInformationAnchorPixel({
        anchorPixel: [480, 300],
        mapSize: [1_000, 700],
        popupRect: { left: 16, top: 40, right: 455, bottom: 640 },
        placement: 'focus-free-region',
      }),
    ).toEqual([752, 350]);
  });

  it('does not move a geometry click that already has comfortable context', () => {
    expect(
      calculateVisibleMapInformationAnchorPixel({
        anchorPixel: [800, 300],
        mapSize: [1_000, 700],
        popupRect: { left: 16, top: 40, right: 455, bottom: 640 },
        placement: 'focus-free-region',
      }),
    ).toBeNull();
  });

  it('centres a geometry click in the useful area below a mobile panel', () => {
    expect(
      calculateVisibleMapInformationAnchorPixel({
        anchorPixel: [160, 200],
        mapSize: [390, 800],
        popupRect: { left: 12, top: 68, right: 318, bottom: 500 },
        placement: 'focus-free-region',
      }),
    ).toEqual([195, 674]);
  });
});
