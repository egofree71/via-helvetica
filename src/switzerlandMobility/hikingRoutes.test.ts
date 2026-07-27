/**
 * Business context: protects normalization of the public SwitzerlandMobility
 * route metadata and geometry used by the map selection workflow. Provider
 * response envelopes may differ between identify and get-feature requests, but
 * Via Helvetica must still select the intended stage and preserve disconnected
 * geometry parts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchSwitzerlandMobilityHikingRoute,
  identifySwitzerlandMobilityHikingRoutes,
  splitSwitzerlandMobilityHikingTitle,
} from './hikingRoutes';

/** Creates the minimal fetch response shape consumed by the API adapter. */
function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('splitSwitzerlandMobilityHikingTitle', () => {
  it('separates a final stage subtitle from the public route name', () => {
    expect(
      splitSwitzerlandMobilityHikingTitle('ViaJacobi (Moudon - Lausanne)'),
    ).toEqual({
      routeName: 'ViaJacobi',
      sectionName: 'Moudon - Lausanne',
    });
  });

  it('preserves a title that has no final parenthesized section', () => {
    expect(splitSwitzerlandMobilityHikingTitle('ViaJacobi')).toEqual({
      routeName: 'ViaJacobi',
      sectionName: null,
    });
  });
});

describe('identifySwitzerlandMobilityHikingRoutes', () => {
  it('keeps distinct overlapping stages and discards the simultaneous whole-route hit', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        results: [
          {
            layerBodId: 'ch.astra.wanderland',
            featureId: 4016,
            properties: {
              chmobil_route_number: '4',
              chmobil_has_segment: true,
              chmobil_title: 'ViaJacobi (Moudon - Lausanne)',
              id: '4.16',
            },
          },
          // A duplicate from another registered table must not create a second choice.
          {
            layerBodId: 'ch.astra.wanderland',
            featureId: 9916,
            properties: {
              chmobil_route_number: '4',
              chmobil_has_segment: 1,
              chmobil_title: 'ViaJacobi (Moudon - Lausanne)',
              id: '4.16',
            },
          },
          {
            layerBodId: 'ch.astra.wanderland',
            featureId: 5012,
            properties: {
              chmobil_route_number: '5',
              chmobil_has_segment: 'true',
              chmobil_title: 'Chemin panorama alpin (Lucens - Lausanne)',
              id: '5.12',
            },
          },
          {
            layerBodId: 'ch.astra.wanderland',
            featureId: 4000,
            properties: {
              chmobil_route_number: '4',
              chmobil_has_segment: true,
              chmobil_title: 'ViaJacobi',
              id: '4',
            },
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const routes = await identifySwitzerlandMobilityHikingRoutes(
      {
        coordinate: [2_553_000, 1_171_000],
        mapExtent: [2_540_000, 1_160_000, 2_570_000, 1_185_000],
        imageSize: [1_200, 800],
        language: 'fr',
      },
      new AbortController().signal,
    );

    expect(routes).toHaveLength(2);
    expect(routes[0]).toMatchObject({
      featureId: 9916,
      routeNumber: '4',
      routeId: '4.16',
      routeName: 'ViaJacobi',
      sectionName: 'Moudon - Lausanne',
      stageNumber: '16',
    });
    expect(routes[1]).toMatchObject({
      routeId: '5.12',
      stageNumber: '12',
    });

    const requestUrl = new URL(String(fetchMock.mock.calls[0][0]));
    expect(requestUrl.pathname).toContain('/MapServer/identify');
    expect(requestUrl.searchParams.get('layers')).toBe(
      'all:ch.astra.wanderland',
    );
    expect(requestUrl.searchParams.get('tolerance')).toBe('8');
    expect(requestUrl.searchParams.get('returnGeometry')).toBe('false');
    expect(requestUrl.searchParams.get('sr')).toBe('2056');
  });

  it('derives stage numbers from the top-level ids returned by identify', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          results: [
            {
              layerBodId: 'ch.astra.wanderland',
              featureId: '3.25',
              id: '3.25',
              properties: {
                chmobil_title: 'Alpenpanorama-Weg (Lausanne - Morges)',
                chmobil_route_number: 3,
                chmobil_has_segment: true,
              },
            },
            {
              layerBodId: 'ch.astra.wanderland',
              featureId: '4.17',
              id: '4.17',
              properties: {
                chmobil_title: 'ViaJacobi (Lausanne - Rolle)',
                chmobil_route_number: 4,
                chmobil_has_segment: true,
              },
            },
            {
              layerBodId: 'ch.astra.wanderland',
              featureId: '70.03',
              id: '70.03',
              properties: {
                chmobil_title: 'ViaFrancigena (Cossonay - Lausanne)',
                chmobil_route_number: 70,
                chmobil_has_segment: true,
              },
            },
          ],
        }),
      ),
    );

    const routes = await identifySwitzerlandMobilityHikingRoutes(
      {
        coordinate: [2_532_684, 1_151_367],
        mapExtent: [2_529_249, 1_148_158, 2_535_057, 1_153_732],
        imageSize: [769, 738],
        language: 'fr',
      },
      new AbortController().signal,
    );

    expect(routes).toMatchObject([
      { routeId: '3.25', stageNumber: '25' },
      { routeId: '4.17', stageNumber: '17' },
      { routeId: '70.03', stageNumber: '3' },
    ]);
  });

  it('keeps an unrelated unsegmented route when staged routes share the same path', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          results: [
            {
              layerBodId: 'ch.astra.wanderland',
              featureId: '2.18',
              id: '2.18',
              properties: {
                chmobil_title: 'Trans Swiss Trail (Flüeli-Ranft - Stans)',
                chmobil_route_number: 2,
                chmobil_has_segment: true,
              },
            },
            {
              layerBodId: 'ch.astra.wanderland',
              featureId: '4.7',
              id: '4.7',
              properties: {
                chmobil_title: 'ViaJacobi (Stans - Flüeli-Ranft)',
                chmobil_route_number: 4,
                chmobil_has_segment: true,
              },
            },
            {
              layerBodId: 'ch.astra.wanderland',
              featureId: 'route-4',
              id: '4',
              properties: {
                chmobil_title: 'ViaJacobi',
                chmobil_route_number: 4,
                chmobil_has_segment: true,
              },
            },
            {
              layerBodId: 'ch.astra.wanderland',
              featureId: '571',
              id: '571',
              properties: {
                chmobil_title: 'Bruderklauseweg (Stans - Sachseln)',
                chmobil_route_number: 571,
                chmobil_has_segment: false,
              },
            },
          ],
        }),
      ),
    );

    const routes = await identifySwitzerlandMobilityHikingRoutes(
      {
        coordinate: [2_668_000, 1_203_000],
        mapExtent: [2_660_000, 1_195_000, 2_676_000, 1_211_000],
        imageSize: [900, 700],
        language: 'fr',
      },
      new AbortController().signal,
    );

    expect(routes).toMatchObject([
      {
        routeNumber: '2',
        routeId: '2.18',
        routeName: 'Trans Swiss Trail',
        stageNumber: '18',
      },
      {
        routeNumber: '4',
        routeId: '4.7',
        routeName: 'ViaJacobi',
        stageNumber: '7',
      },
      {
        routeNumber: '571',
        routeId: '571',
        routeName: 'Bruderklauseweg',
        stageNumber: null,
      },
    ]);
  });

  it('returns the whole route when no stage-specific feature is available', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          results: [
            {
              layerBodId: 'ch.astra.wanderland',
              featureId: 'route-70',
              attributes: {
                chmobil_route_number: 70,
                chmobil_has_segment: false,
                chmobil_title: 'Via Francigena',
                id: '70',
              },
            },
          ],
        }),
      ),
    );

    const routes = await identifySwitzerlandMobilityHikingRoutes(
      {
        coordinate: [2_530_000, 1_155_000],
        mapExtent: [2_520_000, 1_145_000, 2_540_000, 1_165_000],
        imageSize: [900, 700],
        language: 'en',
      },
      new AbortController().signal,
    );

    expect(routes).toEqual([
      {
        featureId: 'route-70',
        routeNumber: '70',
        routeId: '70',
        routeName: 'Via Francigena',
        sectionName: null,
        stageNumber: null,
        hasStages: false,
      },
    ]);
  });
});

describe('fetchSwitzerlandMobilityHikingRoute', () => {
  it('retrieves localized metadata and preserves independent multiline parts', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        feature: {
          type: 'Feature',
          featureId: 4016,
          layerBodId: 'ch.astra.wanderland',
          geometry: {
            type: 'MultiLineString',
            coordinates: [
              [
                [2_553_000, 1_171_000],
                [2_554_000, 1_170_500],
              ],
              // The provider may reverse a contiguous road-table part.
              [
                [2_555_000, 1_170_000],
                [2_554_000.5, 1_170_500.5],
              ],
              [
                [2_560_000, 1_165_000],
                [2_561_500, 1_164_000],
              ],
            ],
          },
          properties: {
            chmobil_route_number: '4',
            chmobil_has_segment: true,
            chmobil_title: 'ViaJacobi (Moudon - Lausanne)',
            id: '4.16',
          },
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const route = await fetchSwitzerlandMobilityHikingRoute(
      {
        featureId: 4016,
        routeNumber: '4',
        routeId: '4.16',
        routeName: null,
        sectionName: null,
        stageNumber: '16',
        hasStages: true,
      },
      'fr',
      new AbortController().signal,
    );

    expect(route.routeName).toBe('ViaJacobi');
    expect(route.sectionName).toBe('Moudon - Lausanne');
    expect(route.segments).toEqual([
      [
        [2_553_000, 1_171_000],
        [2_554_000, 1_170_500],
        [2_555_000, 1_170_000],
      ],
      [
        [2_560_000, 1_165_000],
        [2_561_500, 1_164_000],
      ],
    ]);

    const requestUrl = new URL(String(fetchMock.mock.calls[0][0]));
    expect(requestUrl.pathname).toBe(
      '/rest/services/ech/MapServer/ch.astra.wanderland/4016',
    );
    expect(requestUrl.searchParams.get('geometryFormat')).toBe('geojson');
    expect(requestUrl.searchParams.get('returnGeometry')).toBe('true');
    expect(requestUrl.searchParams.get('sr')).toBe('2056');
    expect(requestUrl.searchParams.get('lang')).toBe('fr');
  });

  it('rejects a feature that has no usable line geometry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          feature: {
            featureId: 4016,
            layerBodId: 'ch.astra.wanderland',
            geometry: { type: 'Point', coordinates: [2_553_000, 1_171_000] },
            properties: { id: '4.16' },
          },
        }),
      ),
    );

    await expect(
      fetchSwitzerlandMobilityHikingRoute(
        {
          featureId: 4016,
          routeNumber: '4',
          routeId: '4.16',
          routeName: 'ViaJacobi',
          sectionName: 'Moudon - Lausanne',
          stageNumber: '16',
          hasStages: true,
        },
        'fr',
        new AbortController().signal,
      ),
    ).rejects.toThrow('no usable line geometry');
  });
});
