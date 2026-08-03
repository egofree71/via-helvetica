/// <reference lib="webworker" />
/**
 * Business context: hosts the complete dynamic swissTLM3D routing pipeline in a
 * dedicated browser worker. Network requests, cell caches, graph construction,
 * snapping, and A* stay off the map's main thread; only plain route results
 * cross back to React.
 */
import { DynamicRoutingNetworkEngine } from './dynamicRoutingEngine';
import { DynamicRoutingProviderSession } from './dynamicRoutingProviderSession';
import {
  resolveRoutingConfiguration,
  shouldUseHikingEnrichment,
} from './routingConfig';
import {
  createPrecomputedBinaryRoutingCellLoader,
} from './precomputedBinaryRoutingData';
import type {
  RoutingWorkerRequest,
  RoutingWorkerResponse,
  RoutingWorkerNotice,
  SerializedRoutingWorkerError,
} from './dynamicRoutingProtocol';

/** Typed global scope used to exchange only protocol messages with the UI. */
const workerScope = self as unknown as DedicatedWorkerGlobalScope;
/** Per-request cancellation kept separate from provider-session ownership. */
const requestControllers = new Map<number, AbortController>();

/** Posts one non-blocking session notice to the main-thread route controller. */
function postNotice(notice: RoutingWorkerNotice): void {
  const response: RoutingWorkerResponse = {
    type: 'notice',
    notice,
  };
  workerScope.postMessage(response);
}

const routingConfiguration = resolveRoutingConfiguration(
  import.meta.env.DEV,
  import.meta.env.VITE_ROUTING_DATA_BASE_URL,
);
const geoAdminEngine = new DynamicRoutingNetworkEngine({
  initialHikingEnrichmentEnabled: shouldUseHikingEnrichment(
    import.meta.env.DEV,
  ),
  onHikingEnrichmentUnavailable: () =>
    postNotice('hiking-enrichment-unavailable'),
});
const binaryEngine =
  routingConfiguration.dataSource === 'precomputed-binary' &&
  routingConfiguration.precomputedBinaryBaseUrl
    ? new DynamicRoutingNetworkEngine({
        precomputedBinaryCellLoader:
          createPrecomputedBinaryRoutingCellLoader(
            routingConfiguration.precomputedBinaryBaseUrl,
          ),
        onCertifiedRoutingAttempt: import.meta.env.DEV
          ? (diagnostic) =>
              console.debug(
                '[Via Helvetica] Certified routing attempt:',
                diagnostic,
              )
          : undefined,
      })
    : undefined;
const routingSession = new DynamicRoutingProviderSession({
  primaryEngine: binaryEngine,
  fallbackEngine: geoAdminEngine,
  onFallbackActivated: (error) => {
    console.warn(
      '[Via Helvetica] Precomputed routing became unavailable; switching this Worker session to GeoAdmin.',
      error,
    );
    postNotice('precomputed-routing-unavailable');
  },
});

if (binaryEngine && routingConfiguration.precomputedBinaryBaseUrl) {
  const location = routingConfiguration.usesRemoteBinaryData
    ? 'remote'
    : 'local';
  console.info(
    `[Via Helvetica] Routing with ${location} precomputed binary Swiss graph cells from ${routingConfiguration.precomputedBinaryBaseUrl}.`,
  );
} else {
  console.info('[Via Helvetica] Routing with GeoAdmin swissTLM3D cells.');
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
              await routingSession.snap(request.coordinate, controller.signal),
            );
            break;
          case 'route':
            postSuccess(
              request.requestId,
              await routingSession.route(
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
