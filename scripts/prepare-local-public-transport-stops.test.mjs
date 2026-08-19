// @vitest-environment node
/**
 * Business context: protects the offline FOT stop-catalog importer against
 * silent source-schema drift before generated artifacts can eventually be
 * published to shared static storage.
 */
import { describe, expect, it } from 'vitest';
import {
  assertCanonicalSourceFile,
  createPublicTransportReleasePath,
  createSourceReleaseId,
  decodeOfficialCsvUtf8,
  parsePointGeometry,
  resolveColumns,
  validateCandidatePlausibility,
  validateRecordCountAgainstPrevious,
} from './prepare-local-public-transport-stops.mjs';

const REAL_POINT_EXPLOITATION_HEADERS = [
  'Numero',
  'Nom',
  'TypePointExploitation_Code',
  'TypePointExploitation_Designation',
  'MoyenTransport_Code',
  'MoyenTransport_Designation',
  'E',
  'N',
];

function createPlausibleRecords(count = 20_001) {
  return Array.from({ length: count }, (_, index) => [
    String(8_500_000 + index),
    `Stop ${index}`,
    'Bus',
    'Haltestelle',
    2_500_000 + (index % 1000),
    1_100_000 + (index % 1000),
  ]);
}

describe('public-transport stop catalog preparation', () => {
  it('derives immutable release identity from the complete source fingerprint', () => {
    const hash = '0123456789abcdef'.repeat(4);
    const sourceRelease = createSourceReleaseId(hash);

    expect(sourceRelease).toBe('sha256-0123456789abcdef');
    expect(createPublicTransportReleasePath(sourceRelease)).toBe(
      'public-transport-stops-sha256-0123456789abcdef/format-v3/ch',
    );
  });

  it('resolves the current PointExploitation columns exactly', () => {
    const columns = resolveColumns(REAL_POINT_EXPLOITATION_HEADERS);

    expect(REAL_POINT_EXPLOITATION_HEADERS[columns.id]).toBe('Numero');
    expect(REAL_POINT_EXPLOITATION_HEADERS[columns.name]).toBe('Nom');
    expect(REAL_POINT_EXPLOITATION_HEADERS[columns.meansOfTransport]).toBe(
      'MoyenTransport_Designation',
    );
    expect(REAL_POINT_EXPLOITATION_HEADERS[columns.stopType]).toBe(
      'TypePointExploitation_Designation',
    );
    expect(REAL_POINT_EXPLOITATION_HEADERS[columns.east]).toBe('E');
    expect(REAL_POINT_EXPLOITATION_HEADERS[columns.north]).toBe('N');
  });

  it('does not confuse transport-company columns with stop identity columns', () => {
    expect(() =>
      resolveColumns([
        'TU_Nummer',
        'TU_Name',
        'MoyenTransport_Designation',
        'E',
        'N',
      ]),
    ).toThrow('Missing CSV column');
  });

  it('accepts the supported geometry representations', () => {
    expect(parsePointGeometry('POINT Z (2538200 1152300 400)')).toEqual([
      2_538_200,
      1_152_300,
    ]);
    expect(
      parsePointGeometry(
        '{"type":"Point","coordinates":[2538200,1152300,400]}',
      ),
    ).toEqual([2_538_200, 1_152_300]);
    expect(parsePointGeometry('2538200,5 1152300,25')).toEqual([
      2_538_200.5,
      1_152_300.25,
    ]);
    expect(parsePointGeometry('')).toBeNull();
  });

  it('accepts a national-scale DiDok/LV95 candidate and rejects implausible data', () => {
    const plausible = { records: createPlausibleRecords() };
    expect(validateCandidatePlausibility(plausible)).toEqual([]);

    const malformed = {
      records: createPlausibleRecords().map((record, index) =>
        index === 0
          ? ['008501120', record[1], '-', record[3], 6.63, 46.52]
          : record,
      ),
    };
    const errors = validateCandidatePlausibility(malformed);

    expect(errors.some((error) => error.includes('seven-digit DiDok'))).toBe(
      true,
    );
    expect(errors.some((error) => error.includes('LV95'))).toBe(true);
  });
});

// Additional production safeguards from the final pipeline audit.
describe('public-transport release publication safeguards', () => {
  it('rejects non-UTF-8 source bytes and replacement characters', () => {
    expect(() =>
      decodeOfficialCsvUtf8(
        Buffer.from([0x47, 0xe8, 0x6e, 0xe8, 0x76, 0x65]),
      ),
    ).toThrow(/UTF-8/);
    expect(() =>
      decodeOfficialCsvUtf8(Buffer.from('Gen\uFFFDve', 'utf8')),
    ).toThrow(/replacement/);
  });

  it('requires the canonical official table name', () => {
    expect(() => assertCanonicalSourceFile('/tmp/PointExploitation.csv')).not.toThrow();
    expect(() =>
      assertCanonicalSourceFile('/tmp/PointExploitation_2027.csv'),
    ).toThrow(/Do not rename/);
  });

  it('rejects implausible annual record-count drift', () => {
    expect(() => validateRecordCountAgainstPrevious(29_400, 28_962)).not.toThrow();
    expect(() =>
      validateRecordCountAgainstPrevious(24_000, 28_962),
    ).toThrow(/above the 5% safety threshold/);
  });
});
