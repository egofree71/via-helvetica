/**
 * Business context: keeps one routing provider coherent for a Worker session.
 * Precomputed cells are the preferred provider when configured, but any
 * persistent binary-data or coverage failure switches the complete session to
 * a separate GeoAdmin engine instead of mixing representations in one graph.
 */
import type { Coordinate } from 'ol/coordinate.js';
import type { RoutedNetworkPath } from './networkRouter';
import { RoutingAreaTooLargeError } from './dynamicRoutingProtocol';

/** Minimal engine contract shared by binary and GeoAdmin implementations. */
export interface RoutingProviderEngine {
  /** Snaps one coordinate with the provider-owned caches. */
  snap(
    coordinate: Coordinate,
    signal: AbortSignal,
  ): Promise<Coordinate | null>;
  /** Routes one section with the provider-owned caches. */
  route(
    startCoordinate: Coordinate,
    endCoordinate: Coordinate,
    signal: AbortSignal,
  ): Promise<RoutedNetworkPath | null>;
  /** Cancels provider work and releases caches after a permanent switch. */
  dispose(): void;
}

/** Session callbacks for a one-way provider transition. */
export interface DynamicRoutingProviderSessionOptions {
  /** Preferred binary engine; omitted when the session starts on GeoAdmin. */
  primaryEngine?: RoutingProviderEngine;
  /** Independent GeoAdmin engine used initially or after fallback. */
  fallbackEngine: RoutingProviderEngine;
  /** Called once with the failure that triggered the permanent transition. */
  onFallbackActivated?: (error: unknown) => void;
}

/** Returns whether the caller intentionally cancelled the operation. */
function callerCancelled(signal: AbortSignal): boolean {
  return signal.aborted;
}

/**
 * Owns the active provider for one Worker lifetime.
 *
 * Construct one session with independent primary and fallback engines. The
 * session exposes only `snap()`, `route()`, and `dispose()` so graph ownership
 * cannot leak across providers.
 *
 * A failing binary operation is retried by the binary loader before reaching
 * this class. Remaining failures activate GeoAdmin once, dispose binary caches,
 * and repeat the complete snap or route operation on the fallback engine.
 */
export class DynamicRoutingProviderSession {
  /** Preferred engine until the first permanent provider failure. */
  private primaryEngine: RoutingProviderEngine | null;
  /** Session-long fallback whose graph never mixes with binary cells. */
  private readonly fallbackEngine: RoutingProviderEngine;
  /** Callback retained for the single transition. */
  private readonly onFallbackActivated?: (error: unknown) => void;

  /**
   * Creates one coherent provider session.
   * @param options - Independent engines and the optional transition callback.
   */
  constructor(options: DynamicRoutingProviderSessionOptions) {
    this.primaryEngine = options.primaryEngine ?? null;
    this.fallbackEngine = options.fallbackEngine;
    this.onFallbackActivated = options.onFallbackActivated;
  }

  /** Snaps with the current provider and repeats wholly on GeoAdmin if needed. */
  snap(
    coordinate: Coordinate,
    signal: AbortSignal,
  ): Promise<Coordinate | null> {
    return this.runWithFallback(
      (engine) => engine.snap(coordinate, signal),
      signal,
    );
  }

  /** Routes with the current provider and repeats wholly on GeoAdmin if needed. */
  route(
    startCoordinate: Coordinate,
    endCoordinate: Coordinate,
    signal: AbortSignal,
  ): Promise<RoutedNetworkPath | null> {
    return this.runWithFallback(
      (engine) => engine.route(startCoordinate, endCoordinate, signal),
      signal,
    );
  }

  /** Releases both engines when the Worker session itself ends. */
  dispose(): void {
    this.primaryEngine?.dispose();
    this.primaryEngine = null;
    this.fallbackEngine.dispose();
  }

  /**
   * Runs one complete operation without combining provider results.
   * @param operation - Snap or route invocation bound to caller arguments.
   * @param signal - Caller cancellation that must never activate fallback.
   * @returns The preferred result, or a fresh GeoAdmin result after transition.
   * @throws {RoutingAreaTooLargeError} Without provider switching because the
   * requested corridor violates a provider-independent safety limit.
   */
  private async runWithFallback<T>(
    operation: (engine: RoutingProviderEngine) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    const primary = this.primaryEngine;

    if (!primary) {
      return operation(this.fallbackEngine);
    }

    try {
      const result = await operation(primary);

      // Another concurrent request may have switched the session while this
      // operation was finishing. Repeating on GeoAdmin prevents a late binary
      // result from re-entering the session after that transition.
      if (this.primaryEngine !== primary) {
        return operation(this.fallbackEngine);
      }

      return result;
    } catch (error) {
      if (callerCancelled(signal)) {
        throw error;
      }

      if (this.primaryEngine !== primary) {
        return operation(this.fallbackEngine);
      }

      if (error instanceof RoutingAreaTooLargeError) {
        throw error;
      }

      this.primaryEngine = null;
      primary.dispose();
      this.onFallbackActivated?.(error);
      return operation(this.fallbackEngine);
    }
  }
}
