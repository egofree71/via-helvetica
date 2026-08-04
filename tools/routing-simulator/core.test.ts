/**
 * Business context: protects deterministic GPX waypoint sampling because both
 * routing policies must receive exactly the same synthetic click sequence.
 */
import { describe, expect, it } from 'vitest';
import {
  createSimulatorWaypointSequence,
  routingSimulationExportBaseName,
  samplingConfigurationLabel,
} from './core';

const source = {
  name: 'Straight kilometre',
  coordinates: [
    [0, 0],
    [1_000, 0],
  ],
};

describe('routing simulator waypoint sampling', () => {
  it('includes exact endpoints at regular metric intervals', () => {
    const sequence = createSimulatorWaypointSequence(source, {
      mode: 'regular-distance',
      intervalMetres: 250,
    });

    expect(sequence.waypoints).toEqual([
      [0, 0],
      [250, 0],
      [500, 0],
      [750, 0],
      [1_000, 0],
    ]);
  });

  it('converts regular percentages to route-relative distances', () => {
    const sequence = createSimulatorWaypointSequence(source, {
      mode: 'regular-percentage',
      intervalPercent: 20,
    });

    expect(sequence.waypoints).toHaveLength(6);
    expect(sequence.waypoints[3]).toEqual([600, 0]);
  });

  it('replays irregular intervals exactly for the same seed', () => {
    const configuration = {
      mode: 'irregular-distance' as const,
      meanIntervalMetres: 200,
      variationRatio: 0.5,
      seed: 12345,
    };

    const first = createSimulatorWaypointSequence(source, configuration);
    const second = createSimulatorWaypointSequence(source, configuration);

    expect(first.waypoints).toEqual(second.waypoints);
    expect(first.waypoints.at(-1)).toEqual([1_000, 0]);
    expect(first.waypoints.length).toBeGreaterThan(3);
  });

  it('does not duplicate the final waypoint after percentage rounding', () => {
    const longSource = {
      name: 'Floating-point percentage route',
      coordinates: [
        [0, 0],
        [46_000.000_000_01, 0],
      ],
    };
    const sequence = createSimulatorWaypointSequence(longSource, {
      mode: 'regular-percentage',
      intervalPercent: 10,
    });

    expect(sequence.waypoints).toHaveLength(11);
    expect(sequence.waypoints.at(-1)).toEqual([46_000.000_000_01, 0]);
    expect(sequence.waypoints.at(-2)).not.toEqual(sequence.waypoints.at(-1));
  });

  it('uses the GPX filename in single-file export names', () => {
    expect(routingSimulationExportBaseName(['Moléson.gpx'])).toBe(
      'via-helvetica-routing-simulation-moleson',
    );
  });

  it('keeps multi-file export names compact and source-aware', () => {
    expect(
      routingSimulationExportBaseName([
        'Romont.gpx',
        'Romont.gpx',
        'Nendaz.gpx',
        'Leysin - aller - retour.GPX',
      ]),
    ).toBe('via-helvetica-routing-simulation-romont-plus-2-gpx');
  });

  it('labels random scenarios with the reproducible seed', () => {
    expect(
      samplingConfigurationLabel({
        mode: 'irregular-distance',
        meanIntervalMetres: 800,
        variationRatio: 0.4,
        seed: 7,
      }),
    ).toBe('irregular 800 m ±40% seed 7');
  });
});
