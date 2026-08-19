/**
 * Business context: protects the passenger-stop filtering rules extracted from
 * GeoAdmin transport records. The map must keep useful multimodal stops while
 * rejecting technical, retired, malformed, and unsupported operating points.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyPublicTransportMeansOfTransport,
  getPrimaryPublicTransportMode,
  isDidokServiceNumber,
  isPublicTransportStopTypeOutOfService,
  normalizePublicTransportStop,
  normalizePublicTransportStopWithPrecomputedMetadata,
  parsePublicTransportStop,
  PUBLIC_TRANSPORT_STOPS_LAYER_ID,
} from './publicTransportStopModel';

function createFeature(
  properties: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    layerBodId: PUBLIC_TRANSPORT_STOPS_LAYER_ID,
    featureId: 8501008,
    geometry: {
      type: 'Point',
      coordinates: [2_600_000, 1_200_000],
    },
    properties,
    ...overrides,
  };
}

describe('publicTransportStopModel', () => {
  it('normalizes source-independent static catalog records with the same rules', () => {
    expect(
      normalizePublicTransportStop({
        id: '8501008',
        name: 'Lausanne, gare',
        meansOfTransport: 'Train, Tram, Bus',
        stopType: 'Haltestelle',
        coordinate: [2_538_200, 1_152_300],
      }),
    ).toEqual({
      id: '8501008',
      stationId: '8501008',
      name: 'Lausanne, gare',
      modes: ['train', 'tram', 'bus'],
      coordinate: [2_538_200, 1_152_300],
    });
  });

  it('keeps the official DiDok service number identical across both providers', () => {
    // The FOT linked-data publication exposes Oberentfelden Engelplatz with
    // identifier 8502194, and the GeoAdmin layer uses that same value as its
    // feature id. The downloaded PointExploitation.Numero field follows the same
    // seven-digit DiDok contract.
    const didokId = '8502194';
    const localStop = normalizePublicTransportStop({
      id: didokId,
      name: 'Oberentfelden Engelplatz',
      meansOfTransport: 'Bus',
      stopType: 'Haltestelle',
      coordinate: [2_645_000, 1_246_000],
    });
    const geoAdminStop = parsePublicTransportStop(
      createFeature(
        {
          name: 'Oberentfelden Engelplatz',
          meansOfTransport: 'Bus',
          type: 'Haltestelle',
        },
        { featureId: Number(didokId) },
      ),
    );

    expect(isDidokServiceNumber(didokId)).toBe(true);
    expect(localStop?.id).toBe(didokId);
    expect(localStop?.stationId).toBe(didokId);
    expect(geoAdminStop?.id).toBe(didokId);
    expect(geoAdminStop?.stationId).toBe(didokId);
  });

  it('rejects identifiers that do not satisfy the source DiDok contract', () => {
    expect(isDidokServiceNumber('008501120')).toBe(false);
    expect(
      normalizePublicTransportStop({
        id: '008501120',
        name: 'Lausanne',
        meansOfTransport: 'Train',
        coordinate: [2_538_000, 1_152_000],
      }),
    ).toBeNull();
  });

  it('keeps precomputed dictionary classification equivalent to normal normalization', () => {
    const input = {
      id: '8501008',
      name: 'Lausanne, gare',
      meansOfTransport: 'Train, Tram, Bus',
      stopType: 'Haltestelle',
      coordinate: [2_538_200, 1_152_300] as [number, number],
    };

    expect(
      normalizePublicTransportStopWithPrecomputedMetadata(
        input,
        classifyPublicTransportMeansOfTransport(input.meansOfTransport),
        isPublicTransportStopTypeOutOfService(input.stopType),
      ),
    ).toEqual(normalizePublicTransportStop(input));
  });

  it('normalizes and prioritizes multimodal passenger stops', () => {
    expect(
      parsePublicTransportStop(
        createFeature({
          name: 'Lausanne, gare',
          meansOfTransport: 'Bus, Tram, Train',
        }),
      ),
    ).toEqual({
      id: '8501008',
      stationId: '8501008',
      name: 'Lausanne, gare',
      modes: ['train', 'tram', 'bus'],
      coordinate: [2_600_000, 1_200_000],
    });
  });

  it('keeps funiculars and chairlifts distinct from generic cable cars', () => {
    expect(
      parsePublicTransportStop(
        createFeature({
          bezeichnung: 'Polybahn',
          verkehrsmittel: 'Standseilbahn',
        }),
      )?.modes,
    ).toEqual(['funicular']);

    expect(
      parsePublicTransportStop(
        createFeature({
          nome: 'Seggiovia',
          mezzoDiTrasporto: 'Seggiovia',
        }),
      )?.modes,
    ).toEqual(['chairlift']);
  });

  it('uses only a final parenthesized name qualifier as a missing-mode fallback', () => {
    expect(
      parsePublicTransportStop(
        createFeature({
          nom: 'Plan-Francey (téléphérique)',
          moyenDeTransport: '-',
        }),
      )?.modes,
    ).toEqual(['cableCar']);

    expect(
      parsePublicTransportStop(
        createFeature({ name: 'Zug Süd', meansOfTransport: '' }),
      ),
    ).toBeNull();
  });

  it('rejects numeric-only, retired, unsupported, and unrelated records', () => {
    const rejectedFeatures = [
      createFeature({ name: '02', meansOfTransport: 'Train' }),
      createFeature({
        name: 'Old station',
        meansOfTransport: 'Train',
        type: 'hors service',
      }),
      createFeature({ name: 'Heliport', meansOfTransport: 'Helicopter' }),
      createFeature(
        { name: 'Bus stop', meansOfTransport: 'Bus' },
        { layerBodId: 'another.layer' },
      ),
    ];

    for (const feature of rejectedFeatures) {
      expect(parsePublicTransportStop(feature)).toBeNull();
    }
  });

  it('uses a point-like bbox when explicit geometry is unavailable', () => {
    expect(
      parsePublicTransportStop(
        createFeature(
          { name: 'Village, poste', meansOfTransport: 'Car postal' },
          {
            geometry: undefined,
            bbox: [2_600_000, 1_200_000, 2_600_020, 1_200_010],
          },
        ),
      )?.coordinate,
    ).toEqual([2_600_010, 1_200_005]);
  });

  it('chooses the highest-priority symbol from normalized modes', () => {
    expect(getPrimaryPublicTransportMode(['bus', 'boat', 'tram'])).toBe(
      'tram',
    );
  });
});
