/**
 * Provider-contract tests keep the buffered geometry request independent from
 * the real viewport used to describe GeoAdmin identify scale.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadPublicTransportStops } from './publicTransportStopsApi';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('public-transport stop identify requests', () => {
  it('queries the buffered envelope while preserving the real viewport scale', async () => {
    // A developer may have the local static provider enabled in `.env.local`.
    // This provider-contract test must explicitly exercise GeoAdmin regardless.
    vi.stubEnv('VITE_PUBLIC_TRANSPORT_STOPS_LOCAL_URL', '');

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await loadPublicTransportStops(
      {
        requestExtent: [0, 0, 1800, 1400],
        viewportExtent: [100, 100, 1700, 1300],
        imageSize: [800, 600],
        language: 'fr',
      },
      new AbortController().signal,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestedUrl = new URL(String(fetchMock.mock.calls[0][0]));

    expect(requestedUrl.searchParams.get('geometry')).toBe('0,0,1800,1400');
    expect(requestedUrl.searchParams.get('mapExtent')).toBe(
      '100,100,1700,1300',
    );
    expect(requestedUrl.searchParams.get('imageDisplay')).toBe('800,600,96');
  });
});
