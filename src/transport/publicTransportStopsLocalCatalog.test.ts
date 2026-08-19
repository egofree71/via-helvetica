/**
 * Business context: validates the opt-in static stop provider independently of
 * GeoAdmin so the local/R2 architecture can be compared without changing map
 * rendering, decluttering, or timetable behaviour.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadPublicTransportStopsFromLocalCatalog,
  resetLocalPublicTransportStopsCatalogForTests,
} from './publicTransportStopsLocalCatalog';

const catalog = {
  version: 2,
  source: 'ch.bav.haltestellen-oev',
  generatedAt: '2026-08-19T00:00:00.000Z',
  meansOfTransport: ['', 'Train, Tram, Bus', 'Métro', '-', 'Bus'],
  stopTypes: ['', 'Haltestelle', 'Bedienpunkt'],
  records: [
    ['8501008', 'Lausanne, gare', 1, 1, 2_538_200, 1_152_300],
    ['8501120', 'Lausanne, Ouchy-Olympique', 2, 1, 2_538_100, 1_150_400],
    ['9999999', 'Technical point', 3, 2, 2_538_150, 1_152_350],
    ['8570000', 'Outside', 4, 1, 2_600_000, 1_200_000],
  ],
};

describe('publicTransportStopsLocalCatalog', () => {
  beforeEach(() => {
    resetLocalPublicTransportStopsCatalogForTests();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(catalog), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads once, filters by extent, and rejects operating-only records', async () => {
    const controller = new AbortController();
    const extent: [number, number, number, number] = [
      2_537_000,
      1_149_000,
      2_540_000,
      1_154_000,
    ];

    const first = await loadPublicTransportStopsFromLocalCatalog(
      '/local-data/public-transport-stops.json',
      extent,
      controller.signal,
    );
    const second = await loadPublicTransportStopsFromLocalCatalog(
      '/local-data/public-transport-stops.json',
      extent,
      controller.signal,
    );

    expect(first).toEqual([
      {
        id: '8501008',
        stationId: '8501008',
        name: 'Lausanne, gare',
        modes: ['train', 'tram', 'bus'],
        coordinate: [2_538_200, 1_152_300],
      },
      {
        id: '8501120',
        stationId: '8501120',
        name: 'Lausanne, Ouchy-Olympique',
        modes: ['metro'],
        coordinate: [2_538_100, 1_150_400],
      },
    ]);
    expect(second).toEqual(first);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps extent boundaries inclusive across grid-cell edges', async () => {
    const boundaryCatalog = {
      ...catalog,
      records: [
        ['8500001', 'Boundary west', 4, 1, 2_540_000, 1_150_000],
        ['8500002', 'Boundary east', 4, 1, 2_550_000, 1_150_000],
      ],
    };
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(boundaryCatalog), { status: 200 }),
    );

    const stops = await loadPublicTransportStopsFromLocalCatalog(
      '/local-data/public-transport-stops.json',
      [2_540_000, 1_149_000, 2_550_000, 1_151_000],
      new AbortController().signal,
    );

    expect(stops.map((stop) => stop.id)).toEqual(['8500001', '8500002']);
  });

  it('discards superseded viewport calls after the shared lazy load', async () => {
    let resolveResponse!: (value: Response) => void;
    vi.mocked(fetch).mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      }),
    );
    const controller = new AbortController();
    const pending = loadPublicTransportStopsFromLocalCatalog(
      '/local-data/public-transport-stops.json',
      [2_537_000, 1_149_000, 2_540_000, 1_154_000],
      controller.signal,
    );

    controller.abort();
    resolveResponse(new Response(JSON.stringify(catalog), { status: 200 }));

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects malformed generated dictionaries', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ...catalog, meansOfTransport: ['Bus', 42] }),
        { status: 200 },
      ),
    );

    await expect(
      loadPublicTransportStopsFromLocalCatalog(
        '/local-data/public-transport-stops.json',
        [2_537_000, 1_149_000, 2_540_000, 1_154_000],
        new AbortController().signal,
      ),
    ).rejects.toThrow('Unsupported local public-transport stop catalog.');
  });

  it('rejects incompatible generated artifacts', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ ...catalog, version: 3 }), { status: 200 }),
    );

    await expect(
      loadPublicTransportStopsFromLocalCatalog(
        '/local-data/public-transport-stops.json',
        [2_537_000, 1_149_000, 2_540_000, 1_154_000],
        new AbortController().signal,
      ),
    ).rejects.toThrow('Unsupported local public-transport stop catalog.');
  });
});
