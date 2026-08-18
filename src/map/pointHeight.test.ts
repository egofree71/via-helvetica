/**
 * Business context: protects the lightweight point-height lookup used by
 * desktop map-position inspection so coordinate display does not depend on an
 * unvalidated provider response or the route-profile request contract.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPointHeight } from './pointHeight';

describe('fetchPointHeight', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('requests one LV95 point and parses the returned height', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ height: '553.6' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await expect(
      fetchPointHeight([2_600_000, 1_200_000], controller.signal),
    ).resolves.toBe(553.6);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [request, options] = fetchMock.mock.calls[0];
    const url = new URL(String(request));
    expect(url.pathname).toBe('/rest/services/height');
    expect(url.searchParams.get('easting')).toBe('2600000.00');
    expect(url.searchParams.get('northing')).toBe('1200000.00');
    expect(url.searchParams.get('sr')).toBe('2056');
    expect(options).toEqual({ signal: controller.signal });
  });

  it('rejects an invalid provider height instead of displaying it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ height: 'not-a-number' }),
      }),
    );

    await expect(
      fetchPointHeight([2_600_000, 1_200_000], new AbortController().signal),
    ).rejects.toThrow('no valid height');
  });
});
