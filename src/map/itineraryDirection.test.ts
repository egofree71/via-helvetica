/**
 * Business context: protects the screen-space direction cues that make long,
 * curved, and repeated itineraries understandable without changing route
 * geometry. The assertions focus on placement invariants rather than private
 * rendering details so visual tuning remains possible without silent regressions.
 */
import type { Coordinate } from 'ol/coordinate.js';
import Feature from 'ol/Feature.js';
import Point from 'ol/geom/Point.js';
import Icon from 'ol/style/Icon.js';
import Style from 'ol/style/Style.js';
import { describe, expect, it } from 'vitest';
import { createDirectionalLineStyle } from './itineraryDirection';

interface ArrowSample {
  coordinate: Coordinate;
  rotation: number;
}

/** Returns only generated arrow symbols, excluding the supplied line style. */
function createArrowSamples(
  coordinates: Coordinate[],
  resolution: number,
  avoidCoordinates: Coordinate[] = [],
): ArrowSample[] {
  const lineStyle = new Style();
  const styleFunction = createDirectionalLineStyle({
    lineStyles: [lineStyle],
    coordinates,
    color: '#d52b1e',
    avoidCoordinates,
  });
  const styles = styleFunction(new Feature(), resolution);

  expect(styles[0]).toBe(lineStyle);

  return styles.slice(1).map((style) => {
    const geometry = style.getGeometry();
    const image = style.getImage();

    expect(geometry).toBeInstanceOf(Point);
    expect(image).toBeInstanceOf(Icon);

    return {
      coordinate: (geometry as Point).getCoordinates(),
      rotation: (image as Icon).getRotation(),
    };
  });
}

/** Returns planar distance between two generated symbol positions. */
function distance(first: Coordinate, second: Coordinate): number {
  return Math.hypot(second[0] - first[0], second[1] - first[1]);
}

describe('directional itinerary arrows', () => {
  it('keeps sparse placement and the defensive arrow cap on long lines', () => {
    expect(createArrowSamples([[0, 0], [1_000, 0]], 1)).toHaveLength(6);
    expect(createArrowSamples([[0, 0], [100_000, 0]], 1)).toHaveLength(16);
  });

  it('keeps regional direction cues but hides them once the map is too broad', () => {
    expect(createArrowSamples([[0, 0], [100, 0]], 1)).toEqual([]);
    expect(createArrowSamples([[0, 0], [10_000, 0]], 30).length).toBeGreaterThan(0);
    expect(createArrowSamples([[0, 0], [10_000, 0]], 41)).toEqual([]);
  });

  it('resolves protected coordinates from the current map resolution', () => {
    const protectedCoordinate: Coordinate = [434, 0];
    const lineStyle = new Style();
    const resolutions: number[] = [];
    const styleFunction = createDirectionalLineStyle({
      lineStyles: [lineStyle],
      coordinates: [[0, 0], [1_000, 0]],
      color: '#d52b1e',
      avoidCoordinates: (resolution) => {
        resolutions.push(resolution);
        return [protectedCoordinate];
      },
    });
    const styles = styleFunction(new Feature(), 1);

    expect(resolutions).toEqual([1]);
    expect(styles[0]).toBe(lineStyle);
    for (const style of styles.slice(1)) {
      const geometry = style.getGeometry();
      expect(geometry).toBeInstanceOf(Point);
      expect(
        distance((geometry as Point).getCoordinates(), protectedCoordinate),
      ).toBeGreaterThanOrEqual(24);
    }
  });

  it('keeps every accepted arrow clear of protected waypoints', () => {
    const protectedCoordinate: Coordinate = [434, 0];
    const arrows = createArrowSamples(
      [[0, 0], [1_000, 0]],
      1,
      [protectedCoordinate],
    );

    expect(arrows).toHaveLength(6);
    for (const arrow of arrows) {
      expect(
        distance(arrow.coordinate, protectedCoordinate),
      ).toBeGreaterThanOrEqual(24);
    }
  });

  it('moves a candidate away from the centre of a sharp visible bend', () => {
    const bend: Coordinate = [100, 0];
    const arrows = createArrowSamples(
      [
        [0, 0],
        bend,
        [100, 100],
      ],
      1,
    );

    expect(arrows).toHaveLength(1);
    expect(distance(arrows[0].coordinate, bend)).toBeGreaterThanOrEqual(40);
  });

  it('reverses symbol orientation with the itinerary traversal order', () => {
    const forward = createArrowSamples([[0, 0], [1_000, 0]], 1);
    const reverse = createArrowSamples([[1_000, 0], [0, 0]], 1);

    expect(forward[0].rotation).toBeCloseTo(0);
    expect(Math.abs(reverse[0].rotation)).toBeCloseTo(Math.PI);
  });

  it('desynchronizes arrows on exactly overlapping out-and-back passages', () => {
    const arrows = createArrowSamples(
      [
        [0, 0],
        [1_000, 0],
        [0, 0],
      ],
      1,
    );

    expect(arrows.length).toBeGreaterThan(8);

    for (let firstIndex = 0; firstIndex < arrows.length; firstIndex += 1) {
      for (
        let secondIndex = firstIndex + 1;
        secondIndex < arrows.length;
        secondIndex += 1
      ) {
        expect(
          distance(
            arrows[firstIndex].coordinate,
            arrows[secondIndex].coordinate,
          ),
        ).toBeGreaterThanOrEqual(30);
      }
    }
  });
});
