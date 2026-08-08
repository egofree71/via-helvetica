/**
 * Business context: protects GPX export geometry, metadata, and elevation
 * interpolation so compatible hiking applications receive the exact planned
 * track without redundant vertices or silently degraded altitude data.
 */
import type { Coordinate } from 'ol/coordinate.js';
import { describe, expect, it } from 'vitest';
import type { RouteClosure, RouteStep } from '../map/routeState';
import { toWgs84 } from '../map/projection';
import { calculateRouteDistance } from '../metrics/routeMetrics';
import {
  createNamedImportedGpxDocument,
  createRouteGpx,
  createRouteSegmentsGpx,
} from './gpx';

const START: Coordinate = [2_600_000, 1_200_000];
const EAST: Coordinate = [2_601_000, 1_200_000];
const NORTH_EAST: Coordinate = [2_601_000, 1_201_000];

interface ParsedTrackPoint {
  latitude: number;
  longitude: number;
  elevationMeters: number | null;
}

function createStep(
  waypoint: Coordinate,
  segment: Coordinate[] | null,
): RouteStep {
  return {
    waypoint,
    segment,
    mode: segment ? 'network' : 'straight',
  };
}

function parseGpx(xml: string): Document {
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  expect(document.querySelector('parsererror')).toBeNull();
  return document;
}

function readTrackPoints(container: Document | Element): ParsedTrackPoint[] {
  return Array.from(container.getElementsByTagNameNS('*', 'trkpt')).map(
    (element) => {
      const elevationElement = element.getElementsByTagNameNS('*', 'ele')[0];

      return {
        latitude: Number(element.getAttribute('lat')),
        longitude: Number(element.getAttribute('lon')),
        elevationMeters: elevationElement
          ? Number(elevationElement.textContent)
          : null,
      };
    },
  );
}

function expectTrackPointAt(
  point: ParsedTrackPoint,
  coordinate: Coordinate,
): void {
  const [longitude, latitude] = toWgs84(coordinate);
  expect(point.longitude).toBe(Number(longitude.toFixed(7)));
  expect(point.latitude).toBe(Number(latitude.toFixed(7)));
}

describe('createRouteGpx', () => {
  it('rejects a route that does not contain two export coordinates', () => {
    expect(() => createRouteGpx([createStep(START, null)])).toThrow(
      'A GPX route requires at least two coordinates.',
    );
  });

  it('writes valid track metadata, escaped names, and exact geographic bounds', () => {
    const xml = createRouteGpx(
      [
        createStep(START, null),
        createStep(EAST, [START, EAST]),
        createStep(NORTH_EAST, [EAST, NORTH_EAST]),
      ],
      new Date('2026-07-17T12:34:56.000Z'),
      'Rock & <Roll> "A"',
    );
    const document = parseGpx(xml);
    const trackPoints = readTrackPoints(document);
    const names = Array.from(
      document.getElementsByTagNameNS('*', 'name'),
    ).map((element) => element.textContent);
    const bounds = document.getElementsByTagNameNS('*', 'bounds')[0];

    expect(names).toEqual(['Rock & <Roll> "A"', 'Rock & <Roll> "A"']);
    expect(
      document.getElementsByTagNameNS('*', 'time')[0]?.textContent,
    ).toBe('2026-07-17T12:34:56.000Z');
    expect(document.getElementsByTagNameNS('*', 'trk')).toHaveLength(1);
    expect(document.getElementsByTagNameNS('*', 'rte')).toHaveLength(0);
    expect(document.getElementsByTagNameNS('*', 'wpt')).toHaveLength(0);
    expect(bounds).toBeDefined();
    expect(bounds.getAttribute('minlat')).toBe(
      Math.min(...trackPoints.map((point) => point.latitude)).toFixed(7),
    );
    expect(bounds.getAttribute('minlon')).toBe(
      Math.min(...trackPoints.map((point) => point.longitude)).toFixed(7),
    );
    expect(bounds.getAttribute('maxlat')).toBe(
      Math.max(...trackPoints.map((point) => point.latitude)).toFixed(7),
    );
    expect(bounds.getAttribute('maxlon')).toBe(
      Math.max(...trackPoints.map((point) => point.longitude)).toFixed(7),
    );
  });

  it('serializes generated GPX without presentation whitespace', () => {
    const xml = createRouteGpx(
      [createStep(START, null), createStep(EAST, [START, EAST])],
      new Date('2026-07-17T12:34:56.000Z'),
      'Compact route',
      [
        { distanceMeters: 0, elevationMeters: 500 },
        { distanceMeters: 1_000, elevationMeters: 550 },
      ],
    );

    expect(xml).not.toContain('\n');
    expect(xml).not.toMatch(/>\s+</);
    expect(parseGpx(xml).getElementsByTagNameNS('*', 'trkpt')).not.toHaveLength(
      0,
    );
  });

  it('simplifies each section independently and preserves every waypoint', () => {
    const middleOfFirstSection: Coordinate = [2_600_500, 1_200_000];
    const middleOfSecondSection: Coordinate = [2_601_000, 1_200_500];
    const document = parseGpx(
      createRouteGpx([
        createStep(START, null),
        createStep(EAST, [START, middleOfFirstSection, EAST]),
        createStep(NORTH_EAST, [
          EAST,
          middleOfSecondSection,
          NORTH_EAST,
        ]),
      ]),
    );
    const trackPoints = readTrackPoints(document);

    expect(trackPoints).toHaveLength(3);
    expectTrackPointAt(trackPoints[0], START);
    expectTrackPointAt(trackPoints[1], EAST);
    expectTrackPointAt(trackPoints[2], NORTH_EAST);
  });

  it('keeps a loop closing section and returns to the original start point', () => {
    const closure: RouteClosure = {
      segment: [EAST, START],
      mode: 'straight',
    };
    const document = parseGpx(
      createRouteGpx(
        [createStep(START, null), createStep(EAST, [START, EAST])],
        new Date('2026-07-17T00:00:00.000Z'),
        'Loop',
        [],
        closure,
      ),
    );
    const trackPoints = readTrackPoints(document);

    expect(trackPoints).toHaveLength(3);
    expectTrackPointAt(trackPoints[0], START);
    expectTrackPointAt(trackPoints[1], EAST);
    expectTrackPointAt(trackPoints[2], START);
  });

  it('merges regular profile samples and interpolates their elevations', () => {
    const document = parseGpx(
      createRouteGpx(
        [createStep(START, null), createStep(EAST, [START, EAST])],
        new Date('2026-07-17T00:00:00.000Z'),
        'Elevated route',
        [
          { distanceMeters: 100, elevationMeters: 500 },
          { distanceMeters: 600, elevationMeters: 550 },
          { distanceMeters: 1_100, elevationMeters: 600 },
        ],
      ),
    );
    const trackPoints = readTrackPoints(document);

    expect(trackPoints).toHaveLength(3);
    expect(trackPoints.map((point) => point.elevationMeters)).toEqual([
      500,
      550,
      600,
    ]);
    expectTrackPointAt(trackPoints[0], START);
    expectTrackPointAt(trackPoints[2], EAST);
  });

  it('replaces near-duplicate profile distances and avoids duplicate merged points', () => {
    const bend: Coordinate = [2_600_500, 1_200_100];
    const document = parseGpx(
      createRouteGpx(
        [
          createStep(START, null),
          createStep(EAST, [START, bend, EAST]),
        ],
        new Date('2026-07-17T00:00:00.000Z'),
        'Profile normalization',
        [
          { distanceMeters: 0, elevationMeters: 100 },
          { distanceMeters: 0.005, elevationMeters: 200 },
          { distanceMeters: 500, elevationMeters: 250 },
          { distanceMeters: 1_000, elevationMeters: 300 },
        ],
      ),
    );
    const trackPoints = readTrackPoints(document);

    expect(trackPoints).toHaveLength(3);
    expect(trackPoints.map((point) => point.elevationMeters)).toEqual([
      200,
      250,
      300,
    ]);
    expectTrackPointAt(trackPoints[1], bend);
  });

  it('exports geometry without elevations when the profile is incomplete', () => {
    const document = parseGpx(
      createRouteGpx(
        [createStep(START, null), createStep(EAST, [START, EAST])],
        new Date('2026-07-17T00:00:00.000Z'),
        'No profile',
        [{ distanceMeters: 0, elevationMeters: 500 }],
      ),
    );

    expect(
      readTrackPoints(document).map((point) => point.elevationMeters),
    ).toEqual([null, null]);
  });
});

describe('createRouteSegmentsGpx', () => {
  it('preserves independent geometry as separate GPX track segments', () => {
    const secondSegmentStart: Coordinate = [2_602_000, 1_202_000];
    const secondSegmentEnd: Coordinate = [2_603_000, 1_202_000];
    const document = parseGpx(
      createRouteSegmentsGpx(
        [
          [START, EAST],
          [secondSegmentStart, secondSegmentEnd],
        ],
        new Date('2026-07-26T12:00:00.000Z'),
        'Public route',
      ),
    );
    const trackSegments = Array.from(
      document.getElementsByTagNameNS('*', 'trkseg'),
    );

    expect(trackSegments).toHaveLength(2);
    expect(
      trackSegments.map((segment) =>
        segment.getElementsByTagNameNS('*', 'trkpt').length,
      ),
    ).toEqual([2, 2]);
  });

  it('keeps distinct elevations on both sides of a segment gap', () => {
    const secondSegmentStart: Coordinate = [2_602_000, 1_202_000];
    const secondSegmentEnd: Coordinate = [2_603_000, 1_202_000];
    const firstDistance = calculateRouteDistance([START, EAST]);
    const secondDistance = calculateRouteDistance([
      secondSegmentStart,
      secondSegmentEnd,
    ]);
    const document = parseGpx(
      createRouteSegmentsGpx(
        [
          [START, EAST],
          [secondSegmentStart, secondSegmentEnd],
        ],
        new Date('2026-07-26T12:00:00.000Z'),
        'Elevated public route',
        [
          { distanceMeters: 0, elevationMeters: 500 },
          { distanceMeters: firstDistance, elevationMeters: 550 },
          { distanceMeters: firstDistance, elevationMeters: 700 },
          {
            distanceMeters: firstDistance + secondDistance,
            elevationMeters: 750,
          },
        ],
      ),
    );
    const trackSegments = Array.from(
      document.getElementsByTagNameNS('*', 'trkseg'),
    );
    const firstSegmentPoints = readTrackPoints(trackSegments[0]);
    const secondSegmentPoints = readTrackPoints(trackSegments[1]);

    expect(firstSegmentPoints.at(-1)?.elevationMeters).toBe(550);
    expect(secondSegmentPoints[0]?.elevationMeters).toBe(700);
  });
});


describe('createNamedImportedGpxDocument', () => {
  it('returns the original XML unchanged when itinerary names already match', () => {
    const xml = `<gpx><metadata><name>Imported hike</name></metadata><trk><name>Imported hike</name><trkseg><trkpt lat="46" lon="7"/><trkpt lat="46.1" lon="7.1"/></trkseg></trk></gpx>`;

    expect(createNamedImportedGpxDocument(xml, 'Imported hike')).toBe(xml);
  });

  it('changes only itinerary names while preserving imported metadata and extensions', () => {
    const xml = `<?xml version="1.0"?>
      <gpx xmlns="http://www.topografix.com/GPX/1/1" xmlns:vendor="https://example.test/vendor">
        <metadata>
          <time>2026-08-08T12:00:00Z</time>
          <extensions><vendor:token>keep-me</vendor:token></extensions>
        </metadata>
        <rte>
          <name>Old route</name>
          <rtept lat="46" lon="7"><ele>500</ele></rtept>
          <rtept lat="46.1" lon="7.1"><ele>550</ele></rtept>
        </rte>
      </gpx>`;

    const document = parseGpx(
      createNamedImportedGpxDocument(xml, 'Shared route'),
    );
    const metadata = document.getElementsByTagNameNS('*', 'metadata')[0];
    const route = document.getElementsByTagNameNS('*', 'rte')[0];

    expect(metadata.getElementsByTagNameNS('*', 'name')[0]?.textContent).toBe(
      'Shared route',
    );
    expect(route.getElementsByTagNameNS('*', 'name')[0]?.textContent).toBe(
      'Shared route',
    );
    expect(document.getElementsByTagNameNS('*', 'time')[0]?.textContent).toBe(
      '2026-08-08T12:00:00Z',
    );
    expect(
      document.getElementsByTagNameNS(
        'https://example.test/vendor',
        'token',
      )[0]?.textContent,
    ).toBe('keep-me');
    expect(document.getElementsByTagNameNS('*', 'rtept')).toHaveLength(2);
  });
});
