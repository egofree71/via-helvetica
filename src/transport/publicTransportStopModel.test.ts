/**
 * Business context: protects the passenger-stop filtering rules extracted from
 * GeoAdmin transport records. The map must keep useful multimodal stops while
 * rejecting technical, retired, malformed, and unsupported operating points.
 */
import { describe, expect, it } from 'vitest';
import {
  getPrimaryPublicTransportMode,
  normalizePublicTransportStop,
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
