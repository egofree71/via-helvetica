/// <reference lib="webworker" />
/**
 * Business context: hosts the complete dynamic swissTLM3D routing pipeline in a
 * dedicated browser worker. Network requests, cell caches, graph construction,
 * snapping, and A* stay off the map's main thread; only plain route results
 * cross back to React.
 */
import { DynamicRoutingNetworkEngine } from './dynamicRoutingEngine';
import {
  resolveRoutingDataSource,
  shouldUseHikingEnrichment,
} from './routingConfig';
import {
  fetchPrecomputedBinaryGenevaRoutingCell,
} from './precomputedBinaryRoutingData';
import { fetchStaticGenevaRoutingCell } from './staticRoutingData';
import type {
  RoutingWorkerRequest,
  RoutingWorkerResponse,
  RoutingWorkerNotice,
  SerializedRoutingWorkerError,
} from './dynamicRoutingProtocol';

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
const requestControllers = new Map<number, AbortController>();

/** Posts one non-blocking session notice to the main-thread route controller. */
function postNotice(notice: RoutingWorkerNotice): void {
  const response: RoutingWorkerResponse = {
    type: 'notice',
    notice,
  };
  workerScope.postMessage(response);
}

const routingDataSource = resolveRoutingDataSource(import.meta.env.DEV);

const engine = new DynamicRoutingNetworkEngine({
  initialHikingEnrichmentEnabled:
    routingDataSource === 'geo-admin'
      ? shouldUseHikingEnrichment(import.meta.env.DEV)
      : true,
  onHikingEnrichmentUnavailable: () =>
    postNotice('hiking-enrichment-unavailable'),
  cellDataLoader:
    routingDataSource === 'static-geneva'
      ? fetchStaticGenevaRoutingCell
      : undefined,
  precomputedBinaryCellLoader:
    routingDataSource === 'precomputed-binary-geneva'
      ? fetchPrecomputedBinaryGenevaRoutingCell
      : undefined,
});

if (routingDataSource === 'static-geneva') {
  console.info('[Via Helvetica] Routing with static Geneva geometry cells.');
} else if (routingDataSource === 'precomputed-binary-geneva') {
  console.info(
    '[Via Helvetica] Routing with precomputed binary Geneva graph cells.',
  );
}

/** Converts unknown failures into structured-clone-safe error data. */
function serializeError(error: unknown): SerializedRoutingWorkerError {
  if (error instanceof Error || error instanceof DOMException) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return {
    name: 'Error',
    message: String(error),
  };
}

/** Posts one successful response without exposing worker-owned objects. */
function postSuccess(requestId: number, result: unknown): void {
  const response: RoutingWorkerResponse = {
    type: 'success',
    requestId,
    result,
  };
  workerScope.postMessage(response);
}

/** Posts one serialized failure to the main-thread facade. */
function postFailure(requestId: number, error: unknown): void {
  const response: RoutingWorkerResponse = {
    type: 'error',
    requestId,
    error: serializeError(error),
  };
  workerScope.postMessage(response);
}

workerScope.addEventListener(
  'message',
  (event: MessageEvent<RoutingWorkerRequest>) => {
    const request = event.data;

    if (request.type === 'cancel') {
      requestControllers.get(request.requestId)?.abort();
      return;
    }

    const controller = new AbortController();
    requestControllers.set(request.requestId, controller);

    void (async () => {
      try {
        switch (request.operation) {
          case 'snap':
            postSuccess(
              request.requestId,
              await engine.snap(request.coordinate, controller.signal),
            );
            break;
          case 'route':
            postSuccess(
              request.requestId,
              await engine.route(
                request.startCoordinate,
                request.endCoordinate,
                controller.signal,
              ),
            );
            break;
        }
      } catch (error) {
        postFailure(request.requestId, error);
      } finally {
        requestControllers.delete(request.requestId);
      }
    })();
  },
);
