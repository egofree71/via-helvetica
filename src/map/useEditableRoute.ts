/**
 * Business context: owns the complete editable-itinerary workflow around the
 * OpenLayers route display. It keeps immutable route history, serializes
 * swissTLM3D routing work, and exposes undoable semantic route mutations while
 * delegating pointer gesture lifecycles to a focused interaction hook. The root
 * application does not manage routing sessions or stale network responses.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import type { Coordinate } from 'ol/coordinate.js';
import type { TranslationKey } from '../i18n/translations';
import { isAbortedRequest } from '../network/abort';
import {
  DynamicRoutingNetworkLoader,
  RoutingAreaTooLargeError,
} from '../routing/dynamicRoutingNetwork';
import {
  connectRoutedSegmentEndpoint,
  createStraightRouteClosure,
  createStraightRouteStep,
  rebuildFixedRouteSection,
  rebuildRouteAfterWaypointDeletion,
  rebuildRouteAfterWaypointInsertion,
  rebuildRouteAfterWaypointMove,
  requestNetworkRouteSection,
} from '../routing/routeEditing';
import {
  assertNetworkRouteSectionDistance,
  RouteSectionTooLongError,
} from '../routing/routeSectionLimit';
import type { MapRuntime } from './mapRuntime';
import {
  useRouteInteractions,
  type RouteContextHint,
} from './useRouteInteractions';
import { updateRouteDisplay } from './route';
import {
  collectRouteCoordinates,
  getRouteState,
  reverseRouteState,
  routeStateMatches,
  type RouteHistory,
  type RouteState,
  type RouteStep,
} from './routeState';

/** Severity of a temporary route-editing message. */
export type RouteMessageType = 'info' | 'error';

/** Inputs required by the editable-route controller. */
export interface UseEditableRouteOptions {
  /** Shared OpenLayers runtime that owns the editable route display. */
  mapRuntimeRef: RefObject<MapRuntime | null>;
  /** Map container used to keep contextual guidance inside the viewport. */
  mapTargetRef: RefObject<HTMLDivElement | null>;
  /** Swiss locale used to format the rejected section distance. */
  locale: string;
  /** Typed interface translation helper with optional named substitutions. */
  t: (
    key: TranslationKey,
    parameters?: Record<string, string | number>,
  ) => string;
}

/** State and actions exposed to the application shell and route controls. */
export interface EditableRouteController {
  /** Complete immutable route history rendered by React controls. */
  routeHistory: RouteHistory;
  /** Flattened editable geometry including the optional loop closure. */
  routeCoordinates: Coordinate[];
  /** Whether map clicks currently create or reshape the editable route. */
  isRouteCreationActive: boolean;
  /** Whether new and rebuilt sections attempt swissTLM3D snapping. */
  isRouteSnapEnabled: boolean;
  /** Whether one serialized routing mutation is still pending. */
  isRouteOperationPending: boolean;
  /** Temporary route workflow message. */
  routeMessage: string;
  /** Severity associated with the temporary route message. */
  routeMessageType: RouteMessageType;
  /** Contextual mouse guidance for a waypoint or route section. */
  routeContextHint: RouteContextHint | null;
  /** Enters or leaves route creation mode. */
  toggleRouteCreation: () => void;
  /** Switches between network and straight section creation. */
  toggleRouteSnap: () => void;
  /** Restores the route state preceding the latest edit. */
  undoRoutePoint: () => void;
  /** Restores the route state removed by the latest undo. */
  redoRoutePoint: () => void;
  /** Reverses the exact stored route geometry. */
  reverseRoute: () => void;
  /** Creates or removes the dedicated loop-closing section. */
  toggleRouteLoop: () => void;
  /** Clears the editable route while keeping route creation active. */
  deleteRoute: () => void;
  /**
   * Exits editing and clears route history before a read-only itinerary becomes
   * current.
   */
  replaceWithReadOnlyItinerary: () => void;
  /** Displays an actionable route message for a bounded duration. */
  showTemporaryRouteMessage: (
    message: string,
    type?: RouteMessageType,
  ) => void;
  /** React render state indicating that a route drag owns the pointer. */
  isRoutePointerInteractionActive: boolean;
  /** Synchronous accessor used by imperative map pointer listeners. */
  isPointerInteractionActive: () => boolean;
}

/** Parameters for one serialized asynchronous route mutation. */
interface AsyncRouteMutationOptions {
  /** Immutable state captured before routing starts. */
  expectedState: RouteState;
  /** Context recorded when an unexpected routing failure is logged. */
  errorContext: string;
  /** Restores the committed display when a drag recalculation fails. */
  restoreDisplayOnError?: boolean;
  /** Builds the next immutable state from the shared routing loader. */
  calculate: (
    loader: DynamicRoutingNetworkLoader,
    signal: AbortSignal,
  ) => Promise<RouteState>;
}

/** Pair of intended LV95 endpoints checked before a network-backed edit. */
type RouteSectionEndpoints = readonly [Coordinate, Coordinate];

/** Duration in milliseconds for actionable route errors before auto-dismissal. */
const ROUTE_MESSAGE_DURATION_MS = 7_000;

/** Creates the empty immutable history used before any read-only itinerary. */
function createEmptyRouteHistory(): RouteHistory {
  return {
    steps: [],
    closure: null,
    undoStates: [],
    redoStates: [],
  };
}

/**
 * Coordinates editable route history, OpenLayers interactions, and dynamic
 * swissTLM3D requests as one application capability.
 *
 * @param options - Shared map runtime and cross-workflow callbacks.
 * @returns Render state and stable actions consumed by the application shell.
 */
export function useEditableRoute(
  options: UseEditableRouteOptions,
): EditableRouteController {
  const routeMessageTimerRef = useRef<number | null>(null);
  const routeHistoryRef = useRef<RouteHistory>(createEmptyRouteHistory());
  const routeCreationActiveRef = useRef(false);
  const routeCreationSessionRef = useRef(0);
  const routeOperationPendingRef = useRef(false);
  const routingLoaderRef = useRef<DynamicRoutingNetworkLoader | null>(null);
  const routingAbortControllerRef = useRef<AbortController | null>(null);
  /** Latest translation helper read by the long-lived routing notice listener. */
  const translationRef = useRef(options.t);
  translationRef.current = options.t;

  const [isRouteCreationActive, setIsRouteCreationActive] = useState(false);
  const [isRouteSnapEnabled, setIsRouteSnapEnabled] = useState(true);
  const [isRouteOperationPending, setIsRouteOperationPending] =
    useState(false);
  const [routeMessage, setRouteMessage] = useState('');
  const [routeMessageType, setRouteMessageType] =
    useState<RouteMessageType>('info');
  const [routeHistory, setRouteHistory] = useState<RouteHistory>(
    routeHistoryRef.current,
  );

  const routeCoordinates = useMemo(
    () => collectRouteCoordinates(routeHistory.steps, routeHistory.closure),
    [routeHistory.steps, routeHistory.closure],
  );
  const sectionDistanceFormat = useMemo(
    () =>
      new Intl.NumberFormat(options.locale, {
        minimumFractionDigits: 0,
        maximumFractionDigits: 1,
      }),
    [options.locale],
  );

  const clearRouteMessageTimer = useCallback(() => {
    if (routeMessageTimerRef.current !== null) {
      window.clearTimeout(routeMessageTimerRef.current);
      routeMessageTimerRef.current = null;
    }
  }, []);

  const clearRouteMessage = useCallback(() => {
    clearRouteMessageTimer();
    setRouteMessage('');
  }, [clearRouteMessageTimer]);

  const showTemporaryRouteMessage = useCallback(
    (message: string, type: RouteMessageType = 'info') => {
      clearRouteMessageTimer();
      setRouteMessageType(type);
      setRouteMessage(message);

      routeMessageTimerRef.current = window.setTimeout(() => {
        setRouteMessage('');
        routeMessageTimerRef.current = null;
      }, ROUTE_MESSAGE_DURATION_MS);
    },
    [clearRouteMessageTimer],
  );

  /** Shows the same actionable message for preflight and defensive failures. */
  const showRouteSectionTooLongMessage = useCallback(
    (error: RouteSectionTooLongError) => {
      showTemporaryRouteMessage(
        options.t('route.sectionTooLong', {
          distance: sectionDistanceFormat.format(error.distanceMeters / 1_000),
          maximum: sectionDistanceFormat.format(
            error.maximumDistanceMeters / 1_000,
          ),
        }),
        'error',
      );
    },
    [options.t, sectionDistanceFormat, showTemporaryRouteMessage],
  );

  /**
   * Rejects an ambiguous network edit synchronously, before pending UI state or
   * Worker creation. The routing functions repeat the same check defensively so
   * future callers cannot bypass the product rule.
   */
  const rejectOverlongNetworkSections = useCallback(
    (sections: readonly RouteSectionEndpoints[]): boolean => {
      try {
        for (const [startCoordinate, endCoordinate] of sections) {
          assertNetworkRouteSectionDistance(startCoordinate, endCoordinate);
        }
      } catch (error) {
        if (error instanceof RouteSectionTooLongError) {
          showRouteSectionTooLongMessage(error);
          return true;
        }

        throw error;
      }

      return false;
    },
    [showRouteSectionTooLongMessage],
  );

  /** Keeps the synchronous ref and React render state on one history object. */
  const commitRouteHistory = useCallback(
    (history: RouteHistory) => {
      routeHistoryRef.current = history;
      setRouteHistory(history);
    },
    [],
  );

  /** Records one complete route mutation and clears obsolete redo states. */
  const commitRouteMutation = useCallback(
    (nextState: RouteState) => {
      const currentHistory = routeHistoryRef.current;

      commitRouteHistory({
        ...nextState,
        undoStates: [
          ...currentHistory.undoStates,
          getRouteState(currentHistory),
        ],
        redoStates: [],
      });
    },
    [commitRouteHistory],
  );

  /** Commits a routed result only while its captured state and session survive. */
  const commitAsyncRouteMutation = useCallback(
    (expectedState: RouteState, nextState: RouteState): boolean => {
      const currentHistory = routeHistoryRef.current;

      if (
        !routeStateMatches(currentHistory, expectedState) ||
        !routeCreationActiveRef.current
      ) {
        return false;
      }

      commitRouteMutation(nextState);
      return true;
    },
    [commitRouteMutation],
  );

  /** Restores the exact committed geometry after a rejected drag preview. */
  const restoreCommittedRouteDisplay = useCallback(() => {
    const display = options.mapRuntimeRef.current?.routeDisplay;

    if (display) {
      updateRouteDisplay(
        display,
        routeHistoryRef.current.steps,
        routeHistoryRef.current.closure,
      );
    }
  }, [options.mapRuntimeRef]);

  /**
   * Serializes one network-backed edit and rejects late results after mode,
   * history, or session changes.
   */
  const runAsyncRouteMutation = useCallback(
    (mutation: AsyncRouteMutationOptions) => {
      const routeCreationSession = routeCreationSessionRef.current;
      routeOperationPendingRef.current = true;
      setIsRouteOperationPending(true);

      const abortController = new AbortController();
      routingAbortControllerRef.current = abortController;

      void (async () => {
        clearRouteMessage();

        try {
          const routingLoader = routingLoaderRef.current;

          if (!routingLoader) {
            throw new Error('The dynamic routing loader is unavailable.');
          }

          const nextState = await mutation.calculate(
            routingLoader,
            abortController.signal,
          );

          if (
            routeCreationSessionRef.current !== routeCreationSession ||
            !routeStateMatches(
              routeHistoryRef.current,
              mutation.expectedState,
            )
          ) {
            return;
          }

          commitAsyncRouteMutation(mutation.expectedState, nextState);
        } catch (error) {
          if (isAbortedRequest(error, abortController.signal)) {
            return;
          }

          if (routeCreationSessionRef.current !== routeCreationSession) {
            return;
          }

          if (mutation.restoreDisplayOnError) {
            restoreCommittedRouteDisplay();
          }

          if (error instanceof RouteSectionTooLongError) {
            showRouteSectionTooLongMessage(error);
            return;
          }

          if (error instanceof RoutingAreaTooLargeError) {
            showTemporaryRouteMessage(
              options.t('route.areaTooLarge'),
              'error',
            );
            return;
          }

          console.error(mutation.errorContext, error);
          showTemporaryRouteMessage(
            options.t('route.networkLoadError'),
            'error',
          );
        } finally {
          // A superseded operation must not clear the busy state owned by its replacement.
          if (routingAbortControllerRef.current === abortController) {
            routingAbortControllerRef.current = null;
            routeOperationPendingRef.current = false;
            setIsRouteOperationPending(false);
          }

          if (routeCreationSessionRef.current !== routeCreationSession) {
            clearRouteMessage();
          }
        }
      })();
    },
    [
      clearRouteMessage,
      commitAsyncRouteMutation,
      options.t,
      restoreCommittedRouteDisplay,
      showRouteSectionTooLongMessage,
      showTemporaryRouteMessage,
    ],
  );

  const appendRouteStep = useCallback(
    (expectedState: RouteState, step: RouteStep): boolean =>
      commitAsyncRouteMutation(expectedState, {
        steps: [...expectedState.steps, step],
        closure: null,
      }),
    [commitAsyncRouteMutation],
  );

  const getCurrentRouteState = useCallback(
    () => getRouteState(routeHistoryRef.current),
    [],
  );

  const isOperationPending = useCallback(
    () => routeOperationPendingRef.current,
    [],
  );

  const isEditingActive = useCallback(
    () => routeCreationActiveRef.current,
    [],
  );

  /** Creates one straight or network-backed endpoint from the current route end. */
  const appendRouteEndpoint = useCallback(
    (expectedState: RouteState, clickedCoordinate: Coordinate) => {
      const previousStep =
        expectedState.steps[expectedState.steps.length - 1];

      if (!isRouteSnapEnabled) {
        appendRouteStep(
          expectedState,
          createStraightRouteStep(previousStep, clickedCoordinate),
        );
        return;
      }

      if (
        previousStep &&
        rejectOverlongNetworkSections([
          [previousStep.waypoint, clickedCoordinate],
        ])
      ) {
        return;
      }

      runAsyncRouteMutation({
        expectedState,
        errorContext: 'Unable to load or route on swissTLM3D.',
        calculate: async (routingLoader, signal) => {
          let step: RouteStep;

          if (!previousStep) {
            const snappedCoordinate = await routingLoader.snap(
              clickedCoordinate,
              signal,
            );

            step = snappedCoordinate
              ? {
                  waypoint: [...snappedCoordinate],
                  segment: null,
                  mode: 'network',
                }
              : createStraightRouteStep(undefined, clickedCoordinate);
          } else {
            const routedPath = await requestNetworkRouteSection(
              previousStep.waypoint,
              clickedCoordinate,
              routingLoader,
              signal,
            );

            if (!routedPath || routedPath.coordinates.length < 2) {
              step = createStraightRouteStep(
                previousStep,
                clickedCoordinate,
              );
            } else {
              const segment = routedPath.coordinates.map(
                (coordinate): Coordinate => [...coordinate],
              );

              // A preceding straight section may end slightly off-network.
              // Preserve visual continuity without changing the snapped target.
              connectRoutedSegmentEndpoint(
                segment,
                previousStep.waypoint,
                'start',
              );

              step = {
                waypoint: [...segment[segment.length - 1]],
                segment,
                mode: 'network',
              };
            }
          }

          return {
            steps: [...expectedState.steps, step],
            closure: null,
          };
        },
      });
    },
    [
      appendRouteStep,
      isRouteSnapEnabled,
      rejectOverlongNetworkSections,
      runAsyncRouteMutation,
    ],
  );

  const undoRoutePoint = useCallback(() => {
    if (routeOperationPendingRef.current) {
      return;
    }

    const currentHistory = routeHistoryRef.current;

    if (currentHistory.undoStates.length === 0) {
      return;
    }

    const previousState =
      currentHistory.undoStates[currentHistory.undoStates.length - 1];

    commitRouteHistory({
      ...previousState,
      undoStates: currentHistory.undoStates.slice(0, -1),
      redoStates: [
        ...currentHistory.redoStates,
        getRouteState(currentHistory),
      ],
    });
  }, [commitRouteHistory]);

  const redoRoutePoint = useCallback(() => {
    if (routeOperationPendingRef.current) {
      return;
    }

    const currentHistory = routeHistoryRef.current;

    if (currentHistory.redoStates.length === 0) {
      return;
    }

    const restoredState =
      currentHistory.redoStates[currentHistory.redoStates.length - 1];

    commitRouteHistory({
      ...restoredState,
      undoStates: [
        ...currentHistory.undoStates,
        getRouteState(currentHistory),
      ],
      redoStates: currentHistory.redoStates.slice(0, -1),
    });
  }, [commitRouteHistory]);

  const reverseRoute = useCallback(() => {
    if (routeOperationPendingRef.current) {
      return;
    }

    const currentHistory = routeHistoryRef.current;

    if (currentHistory.steps.length < 2) {
      return;
    }

    commitRouteMutation(reverseRouteState(getRouteState(currentHistory)));
  }, [commitRouteMutation]);

  const toggleRouteLoop = useCallback(() => {
    const currentHistory = routeHistoryRef.current;

    if (
      routeOperationPendingRef.current ||
      currentHistory.steps.length < 2
    ) {
      return;
    }

    const expectedState = getRouteState(currentHistory);

    if (expectedState.closure) {
      commitRouteMutation({
        steps: expectedState.steps,
        closure: null,
      });
      return;
    }

    if (!isRouteSnapEnabled) {
      commitRouteMutation({
        steps: expectedState.steps,
        closure: createStraightRouteClosure(expectedState.steps),
      });
      return;
    }

    const firstStep = expectedState.steps[0];
    const lastStep = expectedState.steps[expectedState.steps.length - 1];

    if (
      !firstStep ||
      !lastStep ||
      rejectOverlongNetworkSections([
        [lastStep.waypoint, firstStep.waypoint],
      ])
    ) {
      return;
    }

    runAsyncRouteMutation({
      expectedState,
      errorContext: 'Unable to close the route loop.',
      calculate: async (routingLoader, signal) => {
        return {
          steps: expectedState.steps,
          closure: await rebuildFixedRouteSection(
            lastStep.waypoint,
            firstStep.waypoint,
            'network',
            routingLoader,
            signal,
          ),
        };
      },
    });
  }, [
    commitRouteMutation,
    isRouteSnapEnabled,
    rejectOverlongNetworkSections,
    runAsyncRouteMutation,
  ]);

  const deleteRoute = useCallback(() => {
    if (
      routeOperationPendingRef.current ||
      routeHistoryRef.current.steps.length === 0
    ) {
      return;
    }

    commitRouteHistory(createEmptyRouteHistory());
    clearRouteMessage();
  }, [clearRouteMessage, commitRouteHistory]);

  /** Recalculates the one or two sections touching a released waypoint. */
  const moveRouteWaypoint = useCallback(
    (
      expectedState: RouteState,
      waypointIndex: number,
      targetCoordinate: Coordinate,
    ) => {
      if (
        routeOperationPendingRef.current ||
        !routeStateMatches(routeHistoryRef.current, expectedState)
      ) {
        restoreCommittedRouteDisplay();
        return;
      }

      if (isRouteSnapEnabled) {
        const previousStep = expectedState.steps[waypointIndex - 1];
        const nextStep = expectedState.steps[waypointIndex + 1];
        const sections: RouteSectionEndpoints[] = [];

        if (previousStep) {
          sections.push([previousStep.waypoint, targetCoordinate]);
        }

        if (nextStep) {
          sections.push([targetCoordinate, nextStep.waypoint]);
        }

        if (expectedState.closure && waypointIndex === 0) {
          const lastStep = expectedState.steps[expectedState.steps.length - 1];

          if (lastStep) {
            sections.push([lastStep.waypoint, targetCoordinate]);
          }
        } else if (
          expectedState.closure &&
          waypointIndex === expectedState.steps.length - 1
        ) {
          const firstStep = expectedState.steps[0];

          if (firstStep) {
            sections.push([targetCoordinate, firstStep.waypoint]);
          }
        }

        if (rejectOverlongNetworkSections(sections)) {
          restoreCommittedRouteDisplay();
          return;
        }
      }

      runAsyncRouteMutation({
        expectedState,
        errorContext: 'Unable to recalculate the moved route waypoint.',
        restoreDisplayOnError: true,
        calculate: (routingLoader, signal) =>
          rebuildRouteAfterWaypointMove(
            expectedState,
            waypointIndex,
            targetCoordinate,
            isRouteSnapEnabled ? 'network' : 'straight',
            routingLoader,
            signal,
          ),
      });
    },
    [
      isRouteSnapEnabled,
      rejectOverlongNetworkSections,
      restoreCommittedRouteDisplay,
      runAsyncRouteMutation,
    ],
  );

  /** Inserts one waypoint into a dragged route section as one undoable edit. */
  const insertRouteWaypoint = useCallback(
    (
      expectedState: RouteState,
      stepIndex: number,
      targetCoordinate: Coordinate,
    ) => {
      if (
        routeOperationPendingRef.current ||
        !routeStateMatches(routeHistoryRef.current, expectedState)
      ) {
        restoreCommittedRouteDisplay();
        return;
      }

      if (isRouteSnapEnabled) {
        const isClosureSection =
          stepIndex === expectedState.steps.length &&
          expectedState.closure !== null;
        const previousStep = isClosureSection
          ? expectedState.steps[expectedState.steps.length - 1]
          : expectedState.steps[stepIndex - 1];
        const destinationStep = isClosureSection
          ? expectedState.steps[0]
          : expectedState.steps[stepIndex];

        if (
          previousStep &&
          destinationStep &&
          rejectOverlongNetworkSections([
            [previousStep.waypoint, targetCoordinate],
            [targetCoordinate, destinationStep.waypoint],
          ])
        ) {
          restoreCommittedRouteDisplay();
          return;
        }
      }

      runAsyncRouteMutation({
        expectedState,
        errorContext: 'Unable to insert the dragged route waypoint.',
        restoreDisplayOnError: true,
        calculate: (routingLoader, signal) =>
          rebuildRouteAfterWaypointInsertion(
            expectedState,
            stepIndex,
            targetCoordinate,
            isRouteSnapEnabled ? 'network' : 'straight',
            routingLoader,
            signal,
          ),
      });
    },
    [
      isRouteSnapEnabled,
      rejectOverlongNetworkSections,
      restoreCommittedRouteDisplay,
      runAsyncRouteMutation,
    ],
  );

  /** Deletes one clicked waypoint as a single undoable route edit. */
  const deleteRouteWaypoint = useCallback(
    (expectedState: RouteState, waypointIndex: number) => {
      if (
        routeOperationPendingRef.current ||
        !routeStateMatches(routeHistoryRef.current, expectedState)
      ) {
        restoreCommittedRouteDisplay();
        return;
      }

      if (isRouteSnapEnabled) {
        const { steps, closure } = expectedState;
        let replacementSection: RouteSectionEndpoints | null = null;

        if (
          steps.length > 2 &&
          waypointIndex > 0 &&
          waypointIndex < steps.length - 1
        ) {
          replacementSection = [
            steps[waypointIndex - 1].waypoint,
            steps[waypointIndex + 1].waypoint,
          ];
        } else if (closure && steps.length > 2 && waypointIndex === 0) {
          replacementSection = [
            steps[steps.length - 1].waypoint,
            steps[1].waypoint,
          ];
        } else if (
          closure &&
          steps.length > 2 &&
          waypointIndex === steps.length - 1
        ) {
          replacementSection = [
            steps[steps.length - 2].waypoint,
            steps[0].waypoint,
          ];
        }

        if (
          replacementSection &&
          rejectOverlongNetworkSections([replacementSection])
        ) {
          restoreCommittedRouteDisplay();
          return;
        }
      }

      runAsyncRouteMutation({
        expectedState,
        errorContext: 'Unable to delete the route waypoint.',
        restoreDisplayOnError: true,
        calculate: (routingLoader, signal) =>
          rebuildRouteAfterWaypointDeletion(
            expectedState,
            waypointIndex,
            isRouteSnapEnabled ? 'network' : 'straight',
            routingLoader,
            signal,
          ),
      });
    },
    [
      isRouteSnapEnabled,
      rejectOverlongNetworkSections,
      restoreCommittedRouteDisplay,
      runAsyncRouteMutation,
    ],
  );

  const toggleRouteCreation = useCallback(() => {
    const nextState = !routeCreationActiveRef.current;

    routeCreationActiveRef.current = nextState;
    routeCreationSessionRef.current += 1;

    if (nextState) {
      // A fresh route starts in the expected network mode, while reopening an
      // existing editable route preserves the user's current choice.
      if (routeHistoryRef.current.steps.length === 0) {
        setIsRouteSnapEnabled(true);
      }
    } else {
      routingAbortControllerRef.current?.abort();
      routingAbortControllerRef.current = null;
      routeOperationPendingRef.current = false;
      setIsRouteOperationPending(false);
      clearRouteMessage();
    }

    setIsRouteCreationActive(nextState);
  }, [clearRouteMessage]);

  const toggleRouteSnap = useCallback(() => {
    setIsRouteSnapEnabled((enabled) => !enabled);
  }, []);

  const replaceWithReadOnlyItinerary = useCallback(() => {
    routingAbortControllerRef.current?.abort();
    routingAbortControllerRef.current = null;
    routeOperationPendingRef.current = false;
    routeCreationActiveRef.current = false;
    routeCreationSessionRef.current += 1;
    setIsRouteOperationPending(false);
    setIsRouteCreationActive(false);
    commitRouteHistory(createEmptyRouteHistory());
    clearRouteMessage();
  }, [clearRouteMessage, commitRouteHistory]);

  const {
    routeContextHint,
    isInteractionActive: isRoutePointerInteractionActive,
    isPointerInteractionActive,
  } = useRouteInteractions({
    mapRuntimeRef: options.mapRuntimeRef,
    mapTargetRef: options.mapTargetRef,
    isActive: isRouteCreationActive,
    isEditingActive,
    isOperationPending,
    getCurrentRouteState,
    onAppendEndpoint: appendRouteEndpoint,
    onMoveWaypoint: moveRouteWaypoint,
    onInsertWaypoint: insertRouteWaypoint,
    onDeleteWaypoint: deleteRouteWaypoint,
  });

  // OpenLayers features are a projection of immutable history, never the source
  // of truth for route edits or undo/redo.
  useEffect(() => {
    const routeDisplay = options.mapRuntimeRef.current?.routeDisplay;

    if (!routeDisplay) {
      return;
    }

    updateRouteDisplay(
      routeDisplay,
      routeHistory.steps,
      routeHistory.closure,
    );
  }, [options.mapRuntimeRef, routeHistory.closure, routeHistory.steps]);

  useEffect(() => {
    // The Worker and its notice subscription belong to the same effect lifetime.
    // React Strict Mode intentionally runs setup, cleanup, then setup again in
    // development; recreating both here prevents a fresh Worker from losing its
    // listener after that lifecycle check.
    const routingLoader = new DynamicRoutingNetworkLoader();
    routingLoaderRef.current = routingLoader;

    const unsubscribeFromNotices = routingLoader.subscribeToNotices((notice) => {
      if (notice === 'hiking-enrichment-unavailable') {
        showTemporaryRouteMessage(
          translationRef.current('route.hikingEnrichmentUnavailable'),
        );
      }
    });

    return () => {
      clearRouteMessageTimer();
      routingAbortControllerRef.current?.abort();
      unsubscribeFromNotices();
      routingLoader.dispose();

      if (routingLoaderRef.current === routingLoader) {
        routingLoaderRef.current = null;
      }
    };
  }, [clearRouteMessageTimer, showTemporaryRouteMessage]);

  return {
    routeHistory,
    routeCoordinates,
    isRouteCreationActive,
    isRouteSnapEnabled,
    isRouteOperationPending,
    routeMessage,
    routeMessageType,
    routeContextHint,
    isRoutePointerInteractionActive,
    toggleRouteCreation,
    toggleRouteSnap,
    undoRoutePoint,
    redoRoutePoint,
    reverseRoute,
    toggleRouteLoop,
    deleteRoute,
    replaceWithReadOnlyItinerary,
    showTemporaryRouteMessage,
    isPointerInteractionActive,
  };
}
