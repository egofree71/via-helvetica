/** Regression tests for the documented swisstopo `/u/` URL transformation. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSwisstopoImportUrl,
  createSwisstopoShare,
  encodeBase64Url,
  isSwisstopoShareConfigured,
} from './swisstopoShare';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('swisstopo share URL', () => {
  it('uses unpadded RFC 4648 base64url encoding', () => {
    expect(encodeBase64Url('https://example.org/a.gpx')).toBe(
      'aHR0cHM6Ly9leGFtcGxlLm9yZy9hLmdweA',
    );
  });

  it('wraps only HTTPS GPX URLs in the official swisstopo hand-off prefix', () => {
    expect(createSwisstopoImportUrl('https://example.org/a.gpx')).toBe(
      'https://swisstopo.app/u/aHR0cHM6Ly9leGFtcGxlLm9yZy9hLmdweA',
    );
    expect(() => createSwisstopoImportUrl('http://example.org/a.gpx')).toThrow(
      /HTTPS/iu,
    );
  });
});

describe('createSwisstopoShare', () => {
  it('uploads the GPX only when the optional Worker is configured', async () => {
    vi.stubEnv(
      'VITE_SWISSTOPO_SHARE_SERVICE_URL',
      'https://share.example.org/',
    );
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          gpxUrl: 'https://share.example.org/gpx/route.gpx',
          expiresAt: '2026-08-09T12:00:00.000Z',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    expect(isSwisstopoShareConfigured()).toBe(true);

    const share = await createSwisstopoShare('<gpx><trk><trkpt /></trk></gpx>');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://share.example.org/gpx',
      expect.objectContaining({
        method: 'POST',
        body: '<gpx><trk><trkpt /></trk></gpx>',
        credentials: 'omit',
      }),
    );
    expect(share.gpxUrl).toBe('https://share.example.org/gpx/route.gpx');
    expect(share.swisstopoUrl).toMatch(/^https:\/\/swisstopo\.app\/u\//u);
  });
});
