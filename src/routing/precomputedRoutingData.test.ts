/**
 * Business context: protects the compact graph-cell contract used by the
 * second Geneva routing experiment without reading production files.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { precomputedNodeKey } from './precomputedRoutingGraph';

const MANIFEST = {
  version: 1,
  format: 'via-helvetica-precomputed-routing-graph',
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

describe('precomputed Geneva routing cells', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('resolves local node indexes to globally mergeable graph keys', async () => {
    const first = [2_499_000, 1_117_000, 410];
    const second = [2_499_100, 1_117_100, 412];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(MANIFEST))
      .mockResolvedValueOnce(
        jsonResponse({
          v: 1,
          k: '1041:465',
          e: [2_498_400, 1_116_000, 2_500_800, 1_118_400],
          n: [first, second],
          s: [[0, 1, 91.5, 1]],
          f: 1,
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const { fetchPrecomputedGenevaRoutingCell } = await import(
      './precomputedRoutingData'
    );

    await expect(
      fetchPrecomputedGenevaRoutingCell(
        '1041:465',
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      nodes: [
        { key: precomputedNodeKey(first), coordinate: first },
        { key: precomputedNodeKey(second), coordinate: second },
      ],
      segments: [
        {
          startNodeKey: precomputedNodeKey(first),
          endNodeKey: precomputedNodeKey(second),
          cost: 91.5,
          isHikingTrail: true,
        },
      ],
      sourceRoadFeatures: 1,
      sourceHikingFeatures: 0,
    });
  });

  it('returns an empty graph without requesting an unlisted in-region cell', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(MANIFEST));
    vi.stubGlobal('fetch', fetchMock);
    const { fetchPrecomputedGenevaRoutingCell } = await import(
      './precomputedRoutingData'
    );

    await expect(
      fetchPrecomputedGenevaRoutingCell(
        '1032:459',
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      nodes: [],
      segments: [],
      sourceRoadFeatures: 0,
      sourceHikingFeatures: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects cells outside the declared experiment before a cell request', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(MANIFEST));
    vi.stubGlobal('fetch', fetchMock);
    const {
      fetchPrecomputedGenevaRoutingCell,
      PrecomputedRoutingCoverageError,
    } = await import('./precomputedRoutingData');

    await expect(
      fetchPrecomputedGenevaRoutingCell(
        '1000:400',
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(PrecomputedRoutingCoverageError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
