/**
 * Business context: protects explicit remote routing activation while keeping
 * GeoAdmin as the safe production default when no dataset URL is configured.
 */
import { describe, expect, it } from 'vitest';
import {
  LOCAL_PRECOMPUTED_BINARY_ROUTING_BASE_URL,
  normalizeRoutingDataBaseUrl,
  resolveRoutingConfiguration,
  shouldUseHikingEnrichment,
} from './routingConfig';

const LOCAL_CONFIG = {
  dataSource: 'precomputed-binary-geneva' as const,
  useHikingEnrichment: false,
};

describe('routing configuration', () => {
  it('uses local binary cells in Vite development without an environment URL', () => {
    expect(resolveRoutingConfiguration(true, undefined, LOCAL_CONFIG)).toEqual({
      dataSource: 'precomputed-binary-geneva',
      precomputedBinaryBaseUrl: LOCAL_PRECOMPUTED_BINARY_ROUTING_BASE_URL,
      usesRemoteBinaryData: false,
    });
    expect(shouldUseHikingEnrichment(true, LOCAL_CONFIG)).toBe(false);
  });

  it('can select GeoAdmin explicitly during local comparison', () => {
    expect(
      resolveRoutingConfiguration(true, undefined, {
        dataSource: 'geo-admin',
        useHikingEnrichment: true,
      }),
    ).toEqual({
      dataSource: 'geo-admin',
      usesRemoteBinaryData: false,
    });
  });

  it('activates a configured remote binary root in development and production', () => {
    const remote =
      'https://routing-data.example.test/swisstlm3d-2026/format-v2/geneva/';

    expect(resolveRoutingConfiguration(true, remote, LOCAL_CONFIG)).toEqual({
      dataSource: 'precomputed-binary-geneva',
      precomputedBinaryBaseUrl:
        'https://routing-data.example.test/swisstlm3d-2026/format-v2/geneva',
      usesRemoteBinaryData: true,
    });
    expect(resolveRoutingConfiguration(false, remote, LOCAL_CONFIG)).toEqual({
      dataSource: 'precomputed-binary-geneva',
      precomputedBinaryBaseUrl:
        'https://routing-data.example.test/swisstlm3d-2026/format-v2/geneva',
      usesRemoteBinaryData: true,
    });
  });

  it('keeps GeoAdmin as the production default without an explicit remote root', () => {
    expect(resolveRoutingConfiguration(false, undefined, LOCAL_CONFIG)).toEqual({
      dataSource: 'geo-admin',
      usesRemoteBinaryData: false,
    });
    expect(shouldUseHikingEnrichment(false, LOCAL_CONFIG)).toBe(true);
  });

  it('rejects ambiguous or credential-bearing routing-data URLs', () => {
    expect(() =>
      normalizeRoutingDataBaseUrl('https://user:secret@example.test/data'),
    ).toThrow('without credentials');
    expect(() => normalizeRoutingDataBaseUrl('/routing-data?version=2')).toThrow(
      'query or fragment',
    );
  });
});
