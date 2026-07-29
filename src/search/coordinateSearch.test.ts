/**
 * Business context: protects local coordinate search against regressions in
 * accepted WGS 84 and LV95 formats, axis-order detection, map-extent validation,
 * and rejection of text that must remain a normal place search.
 */
import { describe, expect, it } from 'vitest';
import { fromWgs84 } from '../map/projection';
import {
  isCoordinateSearchDraft,
  parseCoordinateSearch,
} from './coordinateSearch';

describe('WGS 84 coordinate search', () => {
  it.each([
    ['46.987, 8.383', 46.987, 8.383],
    ['8.383 46.987', 46.987, 8.383],
    ['46.987; 8.383', 46.987, 8.383],
    ['46,987 ; 8,383', 46.987, 8.383],
  ])(
    'recognizes %s without depending on one axis order or separator',
    (searchText, latitude, longitude) => {
      const parsed = parseCoordinateSearch(searchText);

      expect(parsed.kind).toBe('result');

      if (parsed.kind !== 'result') {
        return;
      }

      expect(parsed.result).toMatchObject({
        label: '46.987, 8.383',
        origin: 'wgs84',
        latitude,
        longitude,
      });
    },
  );

  it.each([
    '48.8566, 2.3522',
    '2.3522, 48.8566',
  ])('reports supported coordinates outside the Swiss map: %s', (searchText) => {
    expect(parseCoordinateSearch(searchText)).toEqual({
      kind: 'outside-map',
    });
  });


  it.each([
    '-48, -174',
    '-47, -170',
  ])('rejects antipodal coordinates folded by the Swiss projection: %s', (searchText) => {
    expect(parseCoordinateSearch(searchText)).toEqual({
      kind: 'outside-map',
    });
  });
});

describe('LV95 coordinate search', () => {
  it.each([
    "2'671'804, 1'204'459",
    '2671804 1204459',
    '1’204’459; 2’671’804',
    '2 671 804, 1 204 459',
    '2 671 804 1 204 459',
  ])('recognizes Swiss grouping and safely reversible axes: %s', (searchText) => {
    const parsed = parseCoordinateSearch(searchText);

    expect(parsed.kind).toBe('result');

    if (parsed.kind !== 'result') {
      return;
    }

    expect(parsed.result.label).toBe("2'671'804, 1'204'459");
    expect(parsed.result.origin).toBe('lv95');

    const roundTrippedLv95 = fromWgs84([
      parsed.result.longitude,
      parsed.result.latitude,
    ]);

    expect(roundTrippedLv95[0]).toBeCloseTo(2_671_804, 2);
    expect(roundTrippedLv95[1]).toBeCloseTo(1_204_459, 2);
  });

  it('reports plausible LV95 input outside the navigable map extent', () => {
    expect(parseCoordinateSearch("2'100'000, 1'100'000")).toEqual({
      kind: 'outside-map',
    });
  });
});

describe('coordinate-search strictness', () => {
  it.each([
    '1204 Genève',
    '1204 2026',
    '46,987, 8,383',
    'Lausanne 46.5 6.6',
  ])('leaves non-coordinate text to the normal place search: %s', (searchText) => {
    expect(parseCoordinateSearch(searchText)).toEqual({
      kind: 'not-coordinate',
    });
  });
});

describe('coordinate-search drafts', () => {
  it.each([
    "2'671'804, 1'20",
    '2 671 804 1 20',
    '2671804 1',
    '46.987,',
  ])('keeps unfinished coordinate-like input local: %s', (searchText) => {
    expect(isCoordinateSearchDraft(searchText)).toBe(true);
  });

  it.each([
    '1204',
    '1204 2026',
    '1204 Genève',
    'Lausanne 46.5',
    '46.987, 8.383',
  ])('preserves place searches and complete coordinates: %s', (searchText) => {
    expect(isCoordinateSearchDraft(searchText)).toBe(false);
  });
});

