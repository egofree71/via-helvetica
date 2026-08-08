/**
 * Business context: protects the small validation and expiry rules that keep
 * the temporary swisstopo Worker compatible with GPX accepted by the browser
 * while ensuring malformed metadata cannot turn a share into permanent storage.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  isExpired,
  isPlausibleGpx,
  shareTtlSeconds,
} from './index.js';

describe('swisstopo GPX Worker validation', () => {
  it('accepts namespace-prefixed tracks and self-closing track points', () => {
    expect(
      isPlausibleGpx(
        '<ns0:gpx xmlns:ns0="http://www.topografix.com/GPX/1/1"><ns0:trk><ns0:trkseg><ns0:trkpt lat="46.5" lon="7.5"/></ns0:trkseg></ns0:trk></ns0:gpx>',
      ),
    ).toBe(true);
  });

  it('accepts namespace-prefixed GPX routes', () => {
    expect(
      isPlausibleGpx(
        '<g:gpx xmlns:g="http://www.topografix.com/GPX/1/1"><g:rte><g:rtept lat="46.5" lon="7.5"/></g:rte></g:gpx>',
      ),
    ).toBe(true);
  });

  it('still rejects documents without GPX route geometry or with entities', () => {
    expect(isPlausibleGpx('<gpx><metadata /></gpx>')).toBe(false);
    expect(
      isPlausibleGpx(
        '<!DOCTYPE gpx [<!ENTITY x "y">]><gpx><trk><trkpt lat="1" lon="1"/></trk></gpx>',
      ),
    ).toBe(false);
  });
});

describe('swisstopo GPX Worker expiry', () => {
  it('fails closed when expiration metadata is absent or malformed', () => {
    vi.spyOn(Date, 'now').mockReturnValue(
      Date.parse('2026-08-08T20:00:00.000Z'),
    );

    expect(isExpired({ customMetadata: {} })).toBe(true);
    expect(
      isExpired({ customMetadata: { expiresAt: 'not-a-date' } }),
    ).toBe(true);
  });

  it('distinguishes future and expired shares', () => {
    vi.spyOn(Date, 'now').mockReturnValue(
      Date.parse('2026-08-08T20:00:00.000Z'),
    );

    expect(
      isExpired({
        customMetadata: { expiresAt: '2026-08-08T21:00:00.000Z' },
      }),
    ).toBe(false);
    expect(
      isExpired({
        customMetadata: { expiresAt: '2026-08-08T19:00:00.000Z' },
      }),
    ).toBe(true);
  });
});

describe('swisstopo GPX Worker retention', () => {
  it('uses the 24-hour default and caps accidental long-lived configuration', () => {
    expect(shareTtlSeconds({})).toBe(24 * 60 * 60);
    expect(shareTtlSeconds({ SHARE_TTL_SECONDS: '120' })).toBe(120);
    expect(shareTtlSeconds({ SHARE_TTL_SECONDS: '999999999' })).toBe(
      7 * 24 * 60 * 60,
    );
  });
});
