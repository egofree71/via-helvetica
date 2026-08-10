/**
 * Business context: protects zoom-aware waypoint decluttering so long editable
 * routes keep all anchors in state while only screen-distinct handles remain
 * visible and selectable at broad map scales.
 */
import { describe, expect, it } from 'vitest';
import type { RouteStep } from './routeState';
import { selectVisibleRouteWaypointIndexes } from './routeDisplay';

function createSteps(count: number, spacingMeters: number): RouteStep[] {
  return Array.from({ length: count }, (_value, index) => ({
    waypoint: [index * spacingMeters, 0],
    section:
      index === 0
        ? null
        : {
            origin: 'generated' as const,
            mode: 'straight' as const,
            coordinates: [
              [(index - 1) * spacingMeters, 0],
              [index * spacingMeters, 0],
            ],
          },
  }));
}

describe('selectVisibleRouteWaypointIndexes', () => {
  it('keeps all kilometre-spaced anchors visible at detailed planning scales', () => {
    const steps = createSteps(101, 1_000);

    expect(selectVisibleRouteWaypointIndexes(steps, 2)).toHaveLength(101);
  });

  it('keeps small manually shaped routes fully visible even at broad scales', () => {
    const steps = createSteps(12, 100);

    expect(selectVisibleRouteWaypointIndexes(steps, 200)).toHaveLength(12);
  });

  it('declutters dense handles at broad scales while preserving both endpoints', () => {
    const steps = createSteps(101, 1_000);
    const visibleIndexes = selectVisibleRouteWaypointIndexes(steps, 200);

    expect(visibleIndexes.length).toBeLessThan(25);
    expect(visibleIndexes[0]).toBe(0);
    expect(visibleIndexes.at(-1)).toBe(100);
  });

  it('uses wider handle spacing on regional views than on detailed views', () => {
    const steps = createSteps(101, 1_000);
    const detailedIndexes = selectVisibleRouteWaypointIndexes(steps, 10);
    const regionalIndexes = selectVisibleRouteWaypointIndexes(steps, 30);

    expect(detailedIndexes).toHaveLength(101);
    expect(regionalIndexes.length).toBeLessThan(detailedIndexes.length);
    expect(regionalIndexes[0]).toBe(0);
    expect(regionalIndexes.at(-1)).toBe(100);
  });

  it('keeps the active dragged waypoint visible even when it is near another handle', () => {
    const steps = createSteps(20, 100);
    const visibleIndexes = selectVisibleRouteWaypointIndexes(steps, 10, 7);

    expect(visibleIndexes).toContain(7);
    expect(visibleIndexes).toContain(0);
    expect(visibleIndexes).toContain(19);
  });

  it('avoids showing spatially overlapping handles from separate route passes', () => {
    const steps = createSteps(22, 100);

    // A later pass comes back within roughly 11 px of waypoint 10. The route is
    // long enough for decluttering to be active, so the later handle must yield
    // to the already visible one even though their route indexes are far apart.
    steps[15] = {
      ...steps[15],
      waypoint: [1_010, 5],
    };

    const visibleIndexes = selectVisibleRouteWaypointIndexes(steps, 1);

    expect(visibleIndexes).toContain(10);
    expect(visibleIndexes).not.toContain(15);
    expect(visibleIndexes).toHaveLength(21);
  });
});
