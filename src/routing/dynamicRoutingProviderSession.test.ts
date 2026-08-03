/**
 * Business context: protects the one-way binary-to-GeoAdmin session fallback so
 * provider failures never produce a graph assembled from mixed representations.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Coordinate } from 'ol/coordinate.js';
import type { RoutedNetworkPath } from './networkRouter';
import { RoutingAreaTooLargeError } from './dynamicRoutingProtocol';
import { RoutingCoverageError } from './routingCoverage';
import {
  DynamicRoutingProviderSession,
  type RoutingProviderEngine,
} from './dynamicRoutingProviderSession';

function createEngine(overrides: Partial<RoutingProviderEngine> = {}) {
  const engine: RoutingProviderEngine = {
    snap: vi.fn().mockResolvedValue([1, 2] as Coordinate),
    route: vi.fn().mockResolvedValue({
      coordinates: [[1, 2], [3, 4]],
      snapDistanceStart: 0,
      snapDistanceEnd: 0,
    } satisfies RoutedNetworkPath),
    dispose: vi.fn(),
    ...overrides,
  };

  return engine;
}

describe('DynamicRoutingProviderSession', () => {
  it('uses the preferred engine while it remains healthy', async () => {
    const primary = createEngine();
    const fallback = createEngine();
    const session = new DynamicRoutingProviderSession({
      primaryEngine: primary,
      fallbackEngine: fallback,
    });

    await expect(
      session.snap([0, 0], new AbortController().signal),
    ).resolves.toEqual([1, 2]);
    expect(primary.snap).toHaveBeenCalledTimes(1);
    expect(fallback.snap).not.toHaveBeenCalled();
  });

  it('switches once and repeats the complete operation on GeoAdmin', async () => {
    const primary = createEngine({
      route: vi.fn().mockRejectedValue(new Error('R2 unavailable')),
    });
    const fallbackPath = {
      coordinates: [[10, 20], [30, 40]],
      snapDistanceStart: 0,
      snapDistanceEnd: 0,
    } satisfies RoutedNetworkPath;
    const fallback = createEngine({
      route: vi.fn().mockResolvedValue(fallbackPath),
    });
    const onFallbackActivated = vi.fn();
    const session = new DynamicRoutingProviderSession({
      primaryEngine: primary,
      fallbackEngine: fallback,
      onFallbackActivated,
    });
    const signal = new AbortController().signal;

    await expect(session.route([0, 0], [1, 1], signal)).resolves.toBe(
      fallbackPath,
    );
    await session.route([2, 2], [3, 3], signal);

    expect(primary.route).toHaveBeenCalledTimes(1);
    expect(primary.dispose).toHaveBeenCalledTimes(1);
    expect(fallback.route).toHaveBeenCalledTimes(2);
    expect(onFallbackActivated).toHaveBeenCalledTimes(1);
  });

  it('does not switch providers for caller cancellation', async () => {
    const controller = new AbortController();
    const primary = createEngine({
      snap: vi.fn().mockImplementation(async () => {
        controller.abort();
        throw new DOMException('Aborted', 'AbortError');
      }),
    });
    const fallback = createEngine();
    const onFallbackActivated = vi.fn();
    const session = new DynamicRoutingProviderSession({
      primaryEngine: primary,
      fallbackEngine: fallback,
      onFallbackActivated,
    });

    await expect(session.snap([0, 0], controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(fallback.snap).not.toHaveBeenCalled();
    expect(onFallbackActivated).not.toHaveBeenCalled();
  });

  it('uses GeoAdmin only for the current coverage miss', async () => {
    const primary = createEngine({
      snap: vi
        .fn()
        .mockRejectedValueOnce(
          new RoutingCoverageError('TestCoverageError', 'Outside coverage'),
        )
        .mockResolvedValueOnce([5, 6] as Coordinate),
    });
    const fallback = createEngine({
      snap: vi.fn().mockResolvedValue([3, 4] as Coordinate),
    });
    const onFallbackActivated = vi.fn();
    const session = new DynamicRoutingProviderSession({
      primaryEngine: primary,
      fallbackEngine: fallback,
      onFallbackActivated,
    });
    const signal = new AbortController().signal;

    await expect(session.snap([0, 0], signal)).resolves.toEqual([3, 4]);
    await expect(session.snap([1, 1], signal)).resolves.toEqual([5, 6]);

    expect(primary.snap).toHaveBeenCalledTimes(2);
    expect(fallback.snap).toHaveBeenCalledTimes(1);
    expect(primary.dispose).not.toHaveBeenCalled();
    expect(onFallbackActivated).not.toHaveBeenCalled();
  });

  it('preserves provider-independent corridor limits', async () => {
    const primary = createEngine({
      route: vi.fn().mockRejectedValue(new RoutingAreaTooLargeError()),
    });
    const fallback = createEngine();
    const session = new DynamicRoutingProviderSession({
      primaryEngine: primary,
      fallbackEngine: fallback,
    });

    await expect(
      session.route([0, 0], [1, 1], new AbortController().signal),
    ).rejects.toBeInstanceOf(RoutingAreaTooLargeError);
    expect(fallback.route).not.toHaveBeenCalled();
  });
});
