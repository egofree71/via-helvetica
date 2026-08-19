/**
 * Regression tests protect the buffered viewport contract independently from
 * React and provider requests. The exact buffer factor is intentional product
 * tuning, while coverage reuse must remain strict about scale context.
 */
import { describe, expect, it } from 'vitest';
import {
  createPublicTransportStopsViewportCoverage,
  publicTransportStopsCoverageContainsViewport,
  publicTransportStopsCoverageKeepsPrefetchMargin,
} from './publicTransportStopsViewport';

describe('public-transport stop viewport coverage', () => {
  it('adds a 25-percent navigation margin on every side', () => {
    const coverage = createPublicTransportStopsViewportCoverage(
      [100, 200, 500, 400],
      21,
      [800, 400],
    );

    expect(coverage.requestExtent).toEqual([0, 150, 600, 450]);
  });

  it('reuses loaded coverage for nearby pans at the same scale', () => {
    const coverage = createPublicTransportStopsViewportCoverage(
      [100, 200, 500, 400],
      21,
      [800, 400],
    );

    expect(
      publicTransportStopsCoverageContainsViewport(
        coverage,
        [150, 210, 550, 410],
        21,
        [800, 400],
      ),
    ).toBe(true);
  });

  it('reloads after leaving the buffered envelope', () => {
    const coverage = createPublicTransportStopsViewportCoverage(
      [100, 200, 500, 400],
      21,
      [800, 400],
    );

    expect(
      publicTransportStopsCoverageContainsViewport(
        coverage,
        [250, 210, 650, 410],
        21,
        [800, 400],
      ),
    ).toBe(false);
  });

  it('refreshes a local catalog before the visible viewport reaches the buffer edge', () => {
    const coverage = createPublicTransportStopsViewportCoverage(
      [100, 200, 500, 400],
      21,
      [800, 400],
    );
    const pannedViewport: [number, number, number, number] = [
      180,
      200,
      580,
      400,
    ];

    // The visible map still fits, but its right-side preload reserve is gone.
    expect(
      publicTransportStopsCoverageContainsViewport(
        coverage,
        pannedViewport,
        21,
        [800, 400],
      ),
    ).toBe(true);
    expect(
      publicTransportStopsCoverageKeepsPrefetchMargin(
        coverage,
        pannedViewport,
        21,
        [800, 400],
      ),
    ).toBe(false);
  });

  it('keeps the local preload reserve for smaller pans', () => {
    const coverage = createPublicTransportStopsViewportCoverage(
      [100, 200, 500, 400],
      21,
      [800, 400],
    );

    expect(
      publicTransportStopsCoverageKeepsPrefetchMargin(
        coverage,
        [150, 200, 550, 400],
        21,
        [800, 400],
      ),
    ).toBe(true);
  });

  it('invalidates reuse when zoom or canvas size changes', () => {
    const coverage = createPublicTransportStopsViewportCoverage(
      [100, 200, 500, 400],
      21,
      [800, 400],
    );

    expect(
      publicTransportStopsCoverageContainsViewport(
        coverage,
        [150, 210, 550, 410],
        22,
        [800, 400],
      ),
    ).toBe(false);
    expect(
      publicTransportStopsCoverageContainsViewport(
        coverage,
        [150, 210, 550, 410],
        21,
        [900, 400],
      ),
    ).toBe(false);
  });
});
