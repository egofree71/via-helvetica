/**
 * Business context: exposes dynamic swissTLM3D routing to the editable-route
 * workflow while keeping all expensive work in a dedicated Web Worker. This
 * facade maps AbortSignals and typed method calls to structured-clone messages;
 * the UI receives only snapped coordinates and route geometry.
 */
import type { Coordinate } from 'ol/coordinate.js';
import type { RoutedNetworkPath } from './networkRouter';
import { RoutingCoverageError } from './routingCoverage';
import {
  RoutingAreaTooLargeError,
  type RoutingWorkerNotice,
  type RoutingWorkerRequest,
  type RoutingWorkerResponse,
  type SerializedRoutingWorkerError,
} from './dynamicRoutingProtocol';

export { createLocalCellKeys } from './routingGrid';
export { RoutingAreaTooLargeError } from './dynamicRoutingProtocol';

/** Promise callbacks retained until one worker response arrives. */
interface PendingWorkerRequest {
  /** Resolves the typed facade call. */
  resolve: (value: unknown) => void;
  /** Rejects cancellation, worker failure, or routing errors. */
  reject: (reason: unknown) => void;
  /** Removes the associated AbortSignal listener. */
  removeAbortListener?: () => void;
}

/** Receives non-blocking routing-session notices from the worker. */
export type RoutingNoticeListener = (notice: RoutingWorkerNotice) => void;

/** Creates the standard cancellation error expected by shared request handling. */
function createAbortError(): DOMException {
  return new DOMException('The routing operation was aborted.', 'AbortError');
}

/**
 * Reconstructs errors that callers inspect with `instanceof` or by name.
 * @param error - Structured-clone-safe failure returned by the worker.
 * @returns Main-thread Error or DOMException preserving the meaningful type.
 */
function deserializeError(error: SerializedRoutingWorkerError): Error {
  let result: Error;

  if (error.name === 'RoutingAreaTooLargeError') {
    result = new RoutingAreaTooLargeError(error.message);
  } else if (
    error.name === 'StaticRoutingCoverageError' ||
    error.name === 'PrecomputedRoutingCoverageError'
  ) {
    result = new RoutingCoverageError(error.name, error.message);
  } else if (error.name === 'AbortError') {
    result = new DOMException(error.message, 'AbortError');
  } else {
    result = new Error(error.message);
    result.name = error.name;
  }

  if (error.stack) {
    result.stack = error.stack;
  }

  return result;
}

/**
 * Main-thread client for the session-scoped routing worker.
 *
 * One instance should be retained for the editable-route lifetime so downloaded
 * cells and derived graph caches stay available between route mutations.
 */
export class DynamicRoutingNetworkLoader {
  private worker: Worker | null = null;
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<number, PendingWorkerRequest>();
  private readonly noticeListeners = new Set<RoutingNoticeListener>();
  /** Notices retained so a subscriber mounted just after Worker startup still receives them. */
  private readonly activeNotices = new Set<RoutingWorkerNotice>();
  private disposed = false;

  /**
   * Subscribes to non-blocking routing-session notices.
   * @param listener - Callback invoked for each worker notice.
   * @returns Cleanup function removing the listener.
   */
  subscribeToNotices(listener: RoutingNoticeListener): () => void {
    this.noticeListeners.add(listener);

    // React effects subscribe after render. Replaying an already received
    // session notice prevents a Worker-startup race from hiding degradation.
    for (const notice of this.activeNotices) {
      listener(notice);
    }

    return () => this.noticeListeners.delete(listener);
  }

  /**
   * Loads local cells and snaps one first waypoint inside the worker.
   * @param coordinate - User-selected coordinate in EPSG:2056.
   * @param signal - Route-session cancellation signal.
   * @returns Snapped coordinate, or `null` when no nearby network exists.
   */
  snap(
    coordinate: Coordinate,
    signal: AbortSignal,
  ): Promise<Coordinate | null> {
    return this.sendRequest<Coordinate | null>(
      {
        type: 'request',
        requestId: 0,
        operation: 'snap',
        coordinate,
      },
      signal,
    );
  }

  /**
   * Routes one section through the worker-owned corridor graph.
   * @param startCoordinate - Existing route endpoint in EPSG:2056.
   * @param endCoordinate - Newly selected destination in EPSG:2056.
   * @param signal - Route-session cancellation signal.
   * @returns Routed plain-data path, or `null` for a straight fallback.
   */
  route(
    startCoordinate: Coordinate,
    endCoordinate: Coordinate,
    signal: AbortSignal,
  ): Promise<RoutedNetworkPath | null> {
    return this.sendRequest<RoutedNetworkPath | null>(
      {
        type: 'request',
        requestId: 0,
        operation: 'route',
        startCoordinate,
        endCoordinate,
      },
      signal,
    );
  }

  /** Terminates the worker and rejects requests that can no longer complete. */
  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.worker?.terminate();
    this.worker = null;

    const error = createAbortError();

    for (const pending of this.pendingRequests.values()) {
      pending.removeAbortListener?.();
      pending.reject(error);
    }

    this.pendingRequests.clear();
    this.noticeListeners.clear();
    this.activeNotices.clear();
  }

  /** Lazily creates the worker so pure grid tests do not require the Worker API. */
  private getWorker(): Worker {
    if (this.disposed) {
      throw new Error('The dynamic routing worker has been disposed.');
    }

    if (this.worker) {
      return this.worker;
    }

    const worker = new Worker(
      new URL('./dynamicRoutingWorker.ts', import.meta.url),
      { type: 'module', name: 'via-helvetica-routing' },
    );
    worker.addEventListener('message', this.handleMessage);
    worker.addEventListener('error', this.handleWorkerFailure);
    worker.addEventListener('messageerror', this.handleWorkerFailure);
    this.worker = worker;
    return worker;
  }

  /**
   * Sends one typed operation and bridges optional main-thread cancellation.
   * @param request - Structured-clone-safe operation with a placeholder request ID.
   * @param signal - Optional caller signal mirrored by a worker cancel message.
   * @returns Promise resolved or rejected by the matching worker response.
   */
  private sendRequest<T>(
    request: RoutingWorkerRequest,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(createAbortError());
    }

    let worker: Worker;

    try {
      worker = this.getWorker();
    } catch (error) {
      return Promise.reject(error);
    }

    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    const message = { ...request, requestId } as RoutingWorkerRequest;

    return new Promise<T>((resolve, reject) => {
      const pending: PendingWorkerRequest = {
        resolve: (value) => resolve(value as T),
        reject,
      };

      if (signal) {
        const handleAbort = () => {
          if (!this.pendingRequests.delete(requestId)) {
            return;
          }

          worker.postMessage({ type: 'cancel', requestId } satisfies RoutingWorkerRequest);
          pending.removeAbortListener?.();
          reject(createAbortError());
        };

        signal.addEventListener('abort', handleAbort, { once: true });
        pending.removeAbortListener = () =>
          signal.removeEventListener('abort', handleAbort);
      }

      this.pendingRequests.set(requestId, pending);

      try {
        worker.postMessage(message);
      } catch (error) {
        this.pendingRequests.delete(requestId);
        pending.removeAbortListener?.();
        reject(error);
      }
    });
  }

  /** Resolves or rejects the matching facade promise. */
  private readonly handleMessage = (
    event: MessageEvent<RoutingWorkerResponse>,
  ): void => {
    const response = event.data;

    if (response.type === 'notice') {
      if (this.activeNotices.has(response.notice)) {
        return;
      }

      this.activeNotices.add(response.notice);

      for (const listener of this.noticeListeners) {
        listener(response.notice);
      }
      return;
    }

    const pending = this.pendingRequests.get(response.requestId);

    if (!pending) {
      return;
    }

    this.pendingRequests.delete(response.requestId);
    pending.removeAbortListener?.();

    if (response.type === 'success') {
      pending.resolve(response.result);
    } else {
      pending.reject(deserializeError(response.error));
    }
  };

  /** Rejects active work and recreates a clean worker on the next request. */
  private readonly handleWorkerFailure = (event: Event): void => {
    const failedWorker = this.worker;
    failedWorker?.terminate();
    this.worker = null;
    const error =
      event instanceof ErrorEvent && event.error instanceof Error
        ? event.error
        : new Error('The dynamic routing worker failed unexpectedly.');

    for (const pending of this.pendingRequests.values()) {
      pending.removeAbortListener?.();
      pending.reject(error);
    }

    this.pendingRequests.clear();
  };
}
