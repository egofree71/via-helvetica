// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { validateCatalogPlausibility } from './verify-public-transport-stops-release.mjs';

function catalog(count = 20_001) {
  return {
    meansOfTransport: ['', 'Bus'],
    stopTypes: ['', 'Haltestelle'],
    records: Array.from({ length: count }, (_, index) => [
      String(8_500_000 + index),
      `Stop ${index}`,
      1,
      1,
      2_500_000 + (index % 1000),
      1_100_000 + (index % 1000),
    ]),
  };
}

describe('local public-transport release verification', () => {
  it('accepts a plausible decoded catalog', () => {
    expect(validateCatalogPlausibility(catalog())).toEqual([]);
  });

  it('rejects corrupt text and invalid dictionary references', () => {
    const value = catalog();
    value.records[0][1] = 'Gen\uFFFDve';
    value.records[1][2] = 99;
    expect(validateCatalogPlausibility(value).join(' ')).toMatch(/invalid stop name|dictionary/);
  });
});
