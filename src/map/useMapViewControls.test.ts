/**
 * Business context: protects the product defaults and browser persistence used
 * by optional rendered map layers. New visitors must not receive the green
 * SwitzerlandMobility portrayal until they explicitly enable it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  resolveInitialHikingTrailsVisibility,
  resolveInitialSwitzerlandMobilityHikingVisibility,
} from './useMapViewControls';

const HIKING_TRAILS_STORAGE_KEY = 'via-helvetica.hiking-trails-visible';
const SWITZERLAND_MOBILITY_HIKING_STORAGE_KEY =
  'via-helvetica.switzerland-mobility-hiking-visible';

describe('initial rendered-layer visibility', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('keeps ordinary hiking trails enabled and SwitzerlandMobility disabled for new visitors', () => {
    expect(resolveInitialHikingTrailsVisibility()).toBe(true);
    expect(resolveInitialSwitzerlandMobilityHikingVisibility()).toBe(false);
  });

  it('restores explicit layer choices from browser storage', () => {
    window.localStorage.setItem(HIKING_TRAILS_STORAGE_KEY, 'false');
    window.localStorage.setItem(
      SWITZERLAND_MOBILITY_HIKING_STORAGE_KEY,
      'true',
    );

    expect(resolveInitialHikingTrailsVisibility()).toBe(false);
    expect(resolveInitialSwitzerlandMobilityHikingVisibility()).toBe(true);
  });
});
