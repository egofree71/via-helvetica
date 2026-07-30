/**
 * Business context: protects development routing experiments so neither static
 * Geneva data nor roads-only GeoAdmin testing can leak into a production build.
 */
import { describe, expect, it } from 'vitest';
import {
  resolveRoutingDataSource,
  shouldUseHikingEnrichment,
} from './routingConfig';

const LOCAL_CONFIG = {
  dataSource: 'static-geneva' as const,
  useHikingEnrichment: false,
};

describe('routing development configuration', () => {
  it('uses the configured source and hiking value in Vite development mode', () => {
    expect(resolveRoutingDataSource(true, LOCAL_CONFIG)).toBe('static-geneva');
    expect(shouldUseHikingEnrichment(true, LOCAL_CONFIG)).toBe(false);
  });

  it('can select GeoAdmin explicitly during local comparison', () => {
    expect(
      resolveRoutingDataSource(true, {
        dataSource: 'geo-admin',
        useHikingEnrichment: true,
      }),
    ).toBe('geo-admin');
  });

  it('can select the binary precomputed graph experiment locally', () => {
    expect(
      resolveRoutingDataSource(true, {
        dataSource: 'precomputed-binary-geneva',
        useHikingEnrichment: true,
      }),
    ).toBe('precomputed-binary-geneva');
  });

  it('always uses production-safe choices in a production bundle', () => {
    expect(resolveRoutingDataSource(false, LOCAL_CONFIG)).toBe('geo-admin');
    expect(shouldUseHikingEnrichment(false, LOCAL_CONFIG)).toBe(true);
  });
});
