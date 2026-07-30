/**
 * Business context: protects the compact static-cell contract used to compare
 * local GeoPackage routing with the production GeoAdmin provider.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const MANIFEST = {
  version: 2,
  format: 'via-helvetica-static-routing-cells',
  projection: 'EPSG:2056',
  cellSizeMetres: 2_400,
  extent: [2_476_800, 1_101_600, 2_522_400, 1_142_400],
  nonEmptyCellKeys: ['1041:465'],
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('static Geneva routing cells', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('normalizes compact road data and preserves precomputed hiking status', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(MANIFEST))
      .mockResolvedValueOnce(
        jsonResponse({
          v: 2,
          k: '1041:465',
          e: [2_498_400, 1_116_000, 2_500_800, 1_118_400],
          r: [
            {
              i: 'road-1',
              l: [
                [
                  [2_499_000, 1_117_000, 410],
                  [2_499_100, 1_117_100, 412],
                ],
              ],
              a: [16, 300, 200, 300],
              h: 1,
            },
          ],
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const { fetchStaticGenevaRoutingCell } = await import(
      './staticRoutingData'
    );

    await expect(
      fetchStaticGenevaRoutingCell(
        '1041:465',
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      roads: [
        {
          id: 'road-1',
          lines: [
            [
              [2_499_000, 1_117_000, 410],
              [2_499_100, 1_117_100, 412],
            ],
          ],
          attributes: {
            objectType: 16,
            restriction: 300,
            surface: 200,
            importance: 300,
          },
          isHikingTrail: true,
        },
      ],
      hikingTrails: [],
    });
  });

  it('returns an empty cell from the manifest without requesting a file', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(MANIFEST));
    vi.stubGlobal('fetch', fetchMock);
    const { fetchStaticGenevaRoutingCell } = await import(
      './staticRoutingData'
    );

    await expect(
      fetchStaticGenevaRoutingCell(
        '1032:459',
        new AbortController().signal,
      ),
    ).resolves.toEqual({ roads: [], hikingTrails: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects cells outside the declared experiment before requesting a file', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(MANIFEST));
    vi.stubGlobal('fetch', fetchMock);
    const {
      fetchStaticGenevaRoutingCell,
      StaticRoutingCoverageError,
    } = await import('./staticRoutingData');

    await expect(
      fetchStaticGenevaRoutingCell('1000:400', new AbortController().signal),
    ).rejects.toBeInstanceOf(StaticRoutingCoverageError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
