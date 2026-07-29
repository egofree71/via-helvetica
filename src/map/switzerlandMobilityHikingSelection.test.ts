/**
 * Business context: protects the temporary vector highlight used to distinguish
 * one selected SwitzerlandMobility route from the semitransparent raster
 * overview. Disconnected public geometry must remain disconnected and clearing
 * the panel must remove every highlighted part.
 */
import { describe, expect, it } from 'vitest';
import {
  createSwitzerlandMobilityHikingSelectionDisplay,
  updateSwitzerlandMobilityHikingSelection,
} from './switzerlandMobilityHikingSelection';

describe('SwitzerlandMobility hiking selection display', () => {
  it('adds every line part and returns their combined LV95 extent', () => {
    const display = createSwitzerlandMobilityHikingSelectionDisplay();
    const extent = updateSwitzerlandMobilityHikingSelection(display, {
      featureId: 4016,
      routeNumber: '4',
      routeId: '4.16',
      routeName: 'ViaJacobi',
      sectionName: 'Moudon - Lausanne',
      stageNumber: '16',
      hasStages: true,
      segments: [
        [
          [2_553_000, 1_171_000],
          [2_554_000, 1_170_500],
        ],
        [
          [2_560_000, 1_165_000],
          [2_561_500, 1_164_000],
        ],
      ],
    });

    expect(display.source.getFeatures()).toHaveLength(2);
    expect(extent).toEqual([2_553_000, 1_164_000, 2_561_500, 1_171_000]);
  });

  it('clears all highlighted geometry when the panel closes', () => {
    const display = createSwitzerlandMobilityHikingSelectionDisplay();
    updateSwitzerlandMobilityHikingSelection(display, {
      featureId: 4016,
      routeNumber: '4',
      routeId: '4.16',
      routeName: 'ViaJacobi',
      sectionName: 'Moudon - Lausanne',
      stageNumber: '16',
      hasStages: true,
      segments: [
        [
          [2_553_000, 1_171_000],
          [2_554_000, 1_170_500],
        ],
      ],
    });

    expect(updateSwitzerlandMobilityHikingSelection(display, null)).toBeNull();
    expect(display.source.getFeatures()).toHaveLength(0);
  });
});
