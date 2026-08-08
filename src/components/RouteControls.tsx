/**
 * Business context: renders the compact route-editing toolbar without taking
 * permanent space away from the map. It exposes route-mode state, undo/redo,
 * the straight-versus-network choice, route reversal, loop closure, and deletion.
 */
import { useI18n } from '../i18n/I18nContext';

/** Controlled state and actions for the route-editing toolbar. */
interface RouteControlsProps {
  /** Whether map clicks currently create route waypoints. */
  isActive: boolean;
  /**
   * Whether new and reshaped segments use swissTLM3D routing instead of
   * straight lines.
   */
  isSnapEnabled: boolean;
  /** Whether a snap or route request is currently in progress. */
  isBusy: boolean;
  /** Whether at least one complete route edit can be undone. */
  canUndo: boolean;
  /** Whether at least one previously undone route state can be restored. */
  canRedo: boolean;
  /** Whether the route contains enough waypoints to reverse direction. */
  canReverse: boolean;
  /** Whether the route contains enough waypoints to close or reopen its loop. */
  canToggleLoop: boolean;
  /** Whether a dedicated closing section currently returns to the first point. */
  isLoopClosed: boolean;
  /** Whether a current route exists and can be cleared. */
  canDelete: boolean;
  /** Enters or leaves route-creation mode. */
  onToggle: () => void;
  /** Restores the route state before the latest edit. */
  onUndo: () => void;
  /** Restores the latest undone route state. */
  onRedo: () => void;
  /**
   * Switches additions and route reshaping between network routing and direct
   * segments.
   */
  onToggleSnap: () => void;
  /** Reverses waypoint and segment order. */
  onReverse: () => void;
  /** Adds or removes the dedicated section back to the first waypoint. */
  onToggleLoop: () => void;
  /** Clears the complete route. */
  onDelete: () => void;
}

/**
 * Displays route controls and reflects active/busy states through accessible
 * button labels as well as visual styling.
 */
export default function RouteControls({
  isActive,
  isSnapEnabled,
  isBusy,
  canUndo,
  canRedo,
  canReverse,
  canToggleLoop,
  isLoopClosed,
  canDelete,
  onToggle,
  onUndo,
  onRedo,
  onToggleSnap,
  onReverse,
  onToggleLoop,
  onDelete,
}: RouteControlsProps) {
  const { t } = useI18n();
  const toggleLabel = isActive
    ? t('route.exitCreation')
    : t('route.create');

  const snapLabel = isSnapEnabled
    ? t('route.followPaths')
    : t('route.straightSegments');
  const loopLabel = isLoopClosed
    ? t('route.openLoop')
    : t('route.closeLoop');

  return (
    <div
      className="route-controls"
      role="toolbar"
      aria-label={t('route.toolbar')}
      aria-busy={isBusy}
    >
      {isActive && (
        <div className="route-action-controls">
          <button
            type="button"
            className="map-control-button map-control-button--route-action"
            aria-label={t('route.undoChange')}
            title={t('route.undo')}
            disabled={!canUndo}
            onClick={onUndo}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M9 7 4 12l5 5" />
              <path d="M5 12h8a6 6 0 0 1 6 6" />
            </svg>
          </button>

          <button
            type="button"
            className="map-control-button map-control-button--route-action"
            aria-label={t('route.redoChange')}
            title={t('route.redo')}
            disabled={!canRedo}
            onClick={onRedo}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="m15 7 5 5-5 5" />
              <path d="M19 12h-8a6 6 0 0 0-6 6" />
            </svg>
          </button>

          <button
            type="button"
            className={[
              'map-control-button',
              'map-control-button--route-action',
              isSnapEnabled
                ? 'map-control-button--route-active'
                : '',
            ]
              .filter(Boolean)
              .join(' ')}
            aria-label={snapLabel}
            aria-pressed={isSnapEnabled}
            title={snapLabel}
            disabled={isBusy}
            onClick={onToggleSnap}
          >
            <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
              <path
                fill="currentColor"
                stroke="none"
                d="M21.345 2.672v14.914c0 2.952-2.393 5.345-5.345 5.345-2.953 0-5.345-2.393-5.345-5.345v-14.914h-6.384v14.928c0 6.478 5.251 11.729 11.729 11.729s11.729-5.251 11.729-11.729v-14.928h-6.384zM26.663 3.738v3.199h-4.251v-3.199h4.251zM9.589 3.738v3.199h-4.251v-3.199h4.251z"
              />
            </svg>
          </button>

          <button
            type="button"
            className="map-control-button map-control-button--route-action"
            aria-label={t('route.reverse')}
            title={t('route.reverse')}
            disabled={!canReverse}
            onClick={onReverse}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M5 7h12" />
              <path d="m14 4 4 3-4 3" />
              <path d="M19 17H7" />
              <path d="m10 14-4 3 4 3" />
            </svg>
          </button>

          <button
            type="button"
            className={[
              'map-control-button',
              'map-control-button--route-action',
              isLoopClosed ? 'map-control-button--route-active' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            aria-label={loopLabel}
            aria-pressed={isLoopClosed}
            title={loopLabel}
            disabled={!canToggleLoop}
            onClick={onToggleLoop}
          >
            <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
              <path
                fill="currentColor"
                stroke="none"
                d="M20 14a1 1 0 0 1-.7-.3l-4-4a1 1 0 0 1 0-1.4l4-4a1 1 0 0 1 1.4 1.4L17.4 9l3.3 3.3A1 1 0 0 1 20 14Z"
              />
              <path
                fill="currentColor"
                stroke="none"
                d="M22 24H10a8 8 0 0 1 0-16h2a1 1 0 0 1 0 2h-2a6 6 0 0 0 0 12h12a6 6 0 0 0 0-12h-6a1 1 0 0 1 0-2h6a8 8 0 0 1 0 16Z"
              />
            </svg>
          </button>

          <button
            type="button"
            className="map-control-button map-control-button--route-action"
            aria-label={t('route.delete')}
            title={t('route.delete')}
            disabled={!canDelete}
            onClick={onDelete}
          >
            <svg viewBox="0 0 512 512" aria-hidden="true" focusable="false">
              <path
                fill="currentColor"
                stroke="none"
                d="M88.594 464.731C90.958 491.486 113.368 512 140.234 512h231.523c26.858 0 49.276-20.514 51.641-47.269l25.642-335.928H62.952l25.642 335.928zm332.253-309.801-23.474 307.496c-1.182 13.37-12.195 23.448-25.616 23.448H140.234c-13.42 0-24.434-10.078-25.591-23.132L91.145 154.93h329.702z"
              />
              <path
                fill="currentColor"
                stroke="none"
                d="M182.954 435.339c5.877-.349 10.35-5.4 9.992-11.269l-10.137-202.234c-.358-5.876-5.401-10.349-11.278-9.992-5.877.357-10.35 5.409-9.993 11.277l10.137 202.234c.358 5.876 5.41 10.341 11.279 9.984zM256 435.364c5.885 0 10.656-4.763 10.656-10.648V222.474c0-5.885-4.771-10.648-10.656-10.648s-10.657 4.763-10.657 10.648v202.242c0 5.885 4.771 10.648 10.657 10.648zM329.046 435.339c5.878.357 10.921-4.108 11.278-9.984l10.129-202.234c.348-5.868-4.116-10.92-9.993-11.277-5.877-.357-10.92 4.116-11.277 9.992L319.054 424.07c-.357 5.868 4.116 10.92 9.992 11.269z"
              />
              <path
                fill="currentColor"
                stroke="none"
                d="M439.115 64.517s-34.078-5.664-43.34-8.479c-8.301-2.526-80.795-13.566-80.795-13.566l-2.722-19.297C310.388 9.857 299.484 0 286.642 0H225.34c-12.825 0-23.728 9.857-25.616 23.175l-2.721 19.297s-72.469 11.039-80.778 13.566c-9.261 2.815-43.357 8.479-43.357 8.479C62.544 67.365 55.332 77.172 55.332 88.38v21.926h401.336V88.38c0-11.208-7.212-21.015-17.553-23.863zM276.318 38.824h-40.636c-3.606 0-6.532-2.925-6.532-6.532s2.926-6.532 6.532-6.532h40.636c3.606 0 6.532 2.925 6.532 6.532s-2.926 6.532-6.532 6.532z"
              />
            </svg>
          </button>
        </div>
      )}

      <button
        type="button"
        className={[
          'map-control-button',
          'map-control-button--route-toggle',
          isActive ? 'map-control-button--route-active' : '',
          isBusy ? 'map-control-button--route-loading' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        aria-label={toggleLabel}
        aria-pressed={isActive}
        aria-busy={isBusy}
        title={toggleLabel}
        onClick={onToggle}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <circle cx="5.8" cy="17.8" r="2.1" />
          <circle cx="18.2" cy="6.2" r="2.1" />
          <path
            className="route-icon-line"
            d="M8.7 16.7h6a2.4 2.4 0 0 0 0-4.8h-4.2a2.4 2.4 0 0 1 0-4.8h4.7"
          />
        </svg>
      </button>
    </div>
  );
}
