/**
 * Business context: protects route statistics shared by editable itineraries
 * and imported GPX files. Distances must not bridge disconnected segments,
 * elevation totals must stay segment-local, and the published Swiss hiking
 * time model must remain stable across refactoring.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  calculateRouteDistance,
  calculateRouteSegmentsDistance,
  createImportedRouteElevationSummary,
  estimateHikingDuration,
  fetchRouteElevationSummary,
  fetchRouteSegmentsElevationSummary,
} from './routeMetrics';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('route metrics', () => {
  it('calculates native LV95 route distance in metres', () => {
    const distance = calculateRouteDistance([
      [2_600_000, 1_200_000],
      [2_601_000, 1_200_000],
    ]);

    expect(distance).toBeGreaterThan(990);
    expect(distance).toBeLessThan(1_010);
  });

  it('sums independent GPX segments without inventing a connector across their gap', () => {
    const firstSegment = [
      [2_600_000, 1_200_000],
      [2_601_000, 1_200_000],
    ];
    const secondSegment = [
      [2_700_000, 1_100_000],
      [2_701_000, 1_100_000],
    ];

    const total = calculateRouteSegmentsDistance([
      firstSegment,
      secondSegment,
    ]);

    expect(total).toBeCloseTo(
      calculateRouteDistance(firstSegment) +
        calculateRouteDistance(secondSegment),
      8,
    );
    expect(total).toBeLessThan(2_100);
  });

  it('accumulates embedded GPX ascent and descent independently per segment', () => {
    const summary = createImportedRouteElevationSummary([
      {
        coordinates: [
          [2_600_000, 1_200_000],
          [2_600_100, 1_200_000],
        ],
        elevationsMeters: [500, 550],
      },
      {
        coordinates: [
          [2_700_000, 1_100_000],
          [2_700_100, 1_100_000],
        ],
        elevationsMeters: [900, 850],
      },
    ]);

    expect(summary.ascentMeters).toBeCloseTo(50, 8);
    expect(summary.descentMeters).toBeCloseTo(50, 8);

    const firstRepeatedDistanceIndex = summary.points.findIndex(
      (point, index) =>
        index > 0 &&
        point.distanceMeters === summary.points[index - 1].distanceMeters,
    );
    expect(firstRepeatedDistanceIndex).toBeGreaterThan(0);
    expect(summary.points[firstRepeatedDistanceIndex - 1].elevationMeters).toBe(
      550,
    );
    expect(summary.points[firstRepeatedDistanceIndex].elevationMeters).toBe(900);
  });

  it('interpolates irregular embedded GPX elevations across ascending samples', () => {
    const coordinates = [
      [2_600_000, 1_200_000],
      [2_600_010, 1_200_000],
      [2_600_100, 1_200_000],
    ];
    const firstSectionDistance = calculateRouteDistance(coordinates.slice(0, 2));
    const totalDistance = calculateRouteDistance(coordinates);
    const summary = createImportedRouteElevationSummary([
      {
        coordinates,
        elevationsMeters: [500, 600, 700],
      },
    ]);
    const firstInteriorSample = summary.points[1];
    const expectedElevation =
      600 +
      ((firstInteriorSample.distanceMeters - firstSectionDistance) /
        (totalDistance - firstSectionDistance)) *
        100;

    expect(firstInteriorSample.distanceMeters).toBeGreaterThan(
      firstSectionDistance,
    );
    expect(firstInteriorSample.elevationMeters).toBeCloseTo(
      expectedElevation,
      8,
    );
    expect(summary.ascentMeters).toBeCloseTo(200, 8);
    expect(summary.descentMeters).toBe(0);
  });

  it('rejects imported elevation data with no valid measurable segment', () => {
    expect(() =>
      createImportedRouteElevationSummary([
        {
          coordinates: [[2_600_000, 1_200_000]],
          elevationsMeters: [500],
        },
      ]),
    ).toThrow('too few valid samples');
  });

  it('keeps the published flat walking pace and ignores repeated-distance GPX gaps', () => {
    const flatDuration = estimateHikingDuration([
      { distanceMeters: 0, elevationMeters: 500 },
      { distanceMeters: 1_000, elevationMeters: 500 },
    ]);
    const durationWithGap = estimateHikingDuration([
      { distanceMeters: 0, elevationMeters: 500 },
      { distanceMeters: 1_000, elevationMeters: 500 },
      { distanceMeters: 1_000, elevationMeters: 900 },
      { distanceMeters: 2_000, elevationMeters: 900 },
    ]);

    expect(flatDuration).toBeCloseTo(14.271, 6);
    expect(durationWithGap).toBeCloseTo(flatDuration * 2, 6);
  });

  it('clamps slopes above the published forty-percent model boundary', () => {
    const atBoundary = estimateHikingDuration([
      { distanceMeters: 0, elevationMeters: 0 },
      { distanceMeters: 1_000, elevationMeters: 400 },
    ]);
    const beyondBoundary = estimateHikingDuration([
      { distanceMeters: 0, elevationMeters: 0 },
      { distanceMeters: 1_000, elevationMeters: 1_000 },
    ]);

    expect(beyondBoundary).toBeCloseTo(atBoundary, 8);
    expect(atBoundary).toBeGreaterThan(14.271);
  });

  it('validates and accumulates a GeoAdmin elevation profile response', async () => {
    const fetchMock = vi.fn(
      async (
        _input: RequestInfo | URL,
        _init?: RequestInit,
      ): Promise<Response> =>
        ({
          ok: true,
          status: 200,
          json: async () => [
            { dist: '0', alts: { COMB: '500' } },
            { dist: 500, alts: { COMB: 550 } },
            { dist: 1_000, alts: { COMB: 525 } },
            { dist: 'invalid', alts: { COMB: 600 } },
          ],
        }) as Response,
    );
    vi.stubGlobal('fetch', fetchMock);

    const summary = await fetchRouteElevationSummary(
      [
        [2_600_000, 1_200_000],
        [2_601_000, 1_200_000],
      ],
      1_000,
      new AbortController().signal,
    );

    expect(summary).toEqual({
      ascentMeters: 50,
      descentMeters: 25,
      points: [
        { distanceMeters: 0, elevationMeters: 500 },
        { distanceMeters: 500, elevationMeters: 550 },
        { distanceMeters: 1_000, elevationMeters: 525 },
      ],
    });
    const [requestUrl, requestOptions] = fetchMock.mock.calls[0]!;
    expect(String(requestUrl)).toContain('sr=2056');
    expect(String(requestUrl)).toContain('nb_points=51');
    expect(requestOptions).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(JSON.parse(String(requestOptions?.body))).toEqual({
      type: 'LineString',
      coordinates: [
        [2_600_000, 1_200_000],
        [2_601_000, 1_200_000],
      ],
    });
  });

  it('shares one 1,000-point profile budget across independent segments', async () => {
    const requestedSampleCounts: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        const requestUrl = new URL(String(input));
        requestedSampleCounts.push(
          Number(requestUrl.searchParams.get('nb_points')),
        );

        return {
          ok: true,
          status: 200,
          json: async () => [
            { dist: 0, alts: { COMB: 500 } },
            { dist: 1, alts: { COMB: 501 } },
          ],
        } as Response;
      }),
    );

    await fetchRouteSegmentsElevationSummary(
      [
        [
          [2_600_000, 1_200_000],
          [2_620_000, 1_200_000],
        ],
        [
          [2_620_000, 1_200_000],
          [2_660_000, 1_200_000],
        ],
      ],
      new AbortController().signal,
    );

    expect(requestedSampleCounts).toHaveLength(2);
    expect(
      requestedSampleCounts.reduce(
        (total, sampleCount) => total + sampleCount,
        0,
      ),
    ).toBe(1_000);
    expect(requestedSampleCounts[1]).toBeGreaterThan(
      requestedSampleCounts[0],
    );
    expect(requestedSampleCounts.every((sampleCount) => sampleCount >= 2)).toBe(
      true,
    );
  });
});
