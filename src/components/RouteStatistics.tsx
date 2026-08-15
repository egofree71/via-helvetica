/**
 * Business context: presents the essential planning figures for whichever
 * itinerary is currently active: an editable route, imported GPX, or selected
 * SwitzerlandMobility hiking route. It can reveal the elevation profile above
 * the compact bar and expose a contextual itinerary action without reducing the
 * map to a permanent panel.
 */
import { useId, useMemo, useState } from 'react';
import { useI18n } from '../i18n/I18nContext';
import type {
  RouteElevationPoint,
  RouteElevationStatus,
} from '../metrics/routeMetrics';
import penIconUrl from '../assets/pen.svg';
import RouteElevationProfile from './RouteElevationProfile';

/** Optional contextual action displayed beside the compact statistics bar. */
interface RouteStatisticsAction {
  /** Accessible label and tooltip for the action. */
  label: string;
  /** Runs the contextual itinerary action. */
  onClick: () => void;
}

/** Values displayed by the route statistics bar. */
interface RouteStatisticsProps {
  /** Horizontal route length in metres. */
  distanceMeters: number;
  /** Elevation-profile loading state. */
  elevationStatus: RouteElevationStatus;
  /** Total climb in metres when elevation data is ready. */
  ascentMeters: number | null;
  /** Total descent in metres when elevation data is ready. */
  descentMeters: number | null;
  /** Estimated walking time in minutes when elevation data is ready. */
  durationMinutes: number | null;
  /** Ordered samples used to draw the optional elevation profile. */
  elevationPoints: RouteElevationPoint[];
  /** Receives profile distance while the pointer explores the chart. */
  onProfileHoverDistanceChange?: (distanceMeters: number | null) => void;
  /** Cumulative distance selected by hovering the route on the map. */
  routeHoverDistanceMeters?: number | null;
  /** Contextual action shown only when the current itinerary offers one. */
  editAction?: RouteStatisticsAction | null;
}

/** Duration is rounded to five minutes because it is an indicative estimate. */
const DURATION_ROUNDING_MINUTES = 5;

/** Formats metres as metres for short lines and kilometres for hiking routes. */
function formatDistance(
  distanceMeters: number,
  integerFormat: Intl.NumberFormat,
  distanceFormat: Intl.NumberFormat,
): string {
  if (distanceMeters < 1_000) {
    return `${integerFormat.format(Math.round(distanceMeters))} m`;
  }

  return `${distanceFormat.format(distanceMeters / 1_000)} km`;
}

/** Formats an altitude difference in whole metres. */
function formatElevation(
  elevationMeters: number,
  integerFormat: Intl.NumberFormat,
): string {
  return `${integerFormat.format(Math.round(elevationMeters))} m`;
}

/** Formats approximate walking time after rounding to the nearest five minutes. */
function formatDuration(
  durationMinutes: number,
  integerFormat: Intl.NumberFormat,
  hourUnit: string,
  minuteUnit: string,
): string {
  const roundedMinutes = Math.max(
    DURATION_ROUNDING_MINUTES,
    Math.round(durationMinutes / DURATION_ROUNDING_MINUTES) *
      DURATION_ROUNDING_MINUTES,
  );
  const hours = Math.floor(roundedMinutes / 60);
  const minutes = roundedMinutes % 60;

  if (hours === 0) {
    return `≈ ${integerFormat.format(minutes)} ${minuteUnit}`;
  }

  if (minutes === 0) {
    return `≈ ${integerFormat.format(hours)} ${hourUnit}`;
  }

  return `≈ ${integerFormat.format(hours)} ${hourUnit} ${String(minutes).padStart(2, '0')}`;
}

/** Uses an ellipsis while loading and a dash if altitude lookup failed. */
function pendingValue(status: RouteElevationStatus): string {
  return status === 'loading' ? '…' : '—';
}

/** Compact summary with a toggle for the elevation-profile panel. */
export default function RouteStatistics({
  distanceMeters,
  elevationStatus,
  ascentMeters,
  descentMeters,
  durationMinutes,
  elevationPoints,
  onProfileHoverDistanceChange,
  routeHoverDistanceMeters = null,
  editAction = null,
}: RouteStatisticsProps) {
  const { locale, t } = useI18n();
  const [isProfileVisible, setIsProfileVisible] = useState(false);
  const profileId = useId();
  const integerFormat = useMemo(
    () => new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }),
    [locale],
  );
  const distanceFormat = useMemo(
    () =>
      new Intl.NumberFormat(locale, {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }),
    [locale],
  );
  const hasElevation =
    elevationStatus === 'ready' &&
    ascentMeters !== null &&
    descentMeters !== null &&
    durationMinutes !== null;
  const hasProfile =
    elevationStatus === 'ready' && elevationPoints.length >= 2;
  const unavailableValue = pendingValue(elevationStatus);
  const profileButtonLabel = hasProfile
    ? isProfileVisible
      ? t('profile.hide')
      : t('profile.show')
    : elevationStatus === 'loading'
      ? t('profile.loading')
      : t('profile.unavailable');

  return (
    <div className="route-summary">
      {isProfileVisible && hasProfile && (
        <RouteElevationProfile
          id={profileId}
          points={elevationPoints}
          onHoverDistanceChange={onProfileHoverDistanceChange}
          externalHoverDistanceMeters={routeHoverDistanceMeters}
        />
      )}

      <div className="route-statistics-row">
        <section
          className="route-statistics"
          aria-label={t('statistics.aria')}
          aria-busy={elevationStatus === 'loading'}
        >
          <div className="route-statistics-item">
            <span className="route-statistics-label">{t('statistics.distance')}</span>
            <strong>
              {formatDistance(distanceMeters, integerFormat, distanceFormat)}
            </strong>
          </div>

          <div className="route-statistics-item">
            <span className="route-statistics-label">{t('statistics.ascent')}</span>
            <svg
              className="route-statistics-direction-icon"
              viewBox="0 0 12 14"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M6 12V2" />
              <path d="m2.5 5.5 3.5-3.5 3.5 3.5" />
            </svg>
            <strong>
              {hasElevation
                ? formatElevation(ascentMeters, integerFormat)
                : unavailableValue}
            </strong>
          </div>

          <div className="route-statistics-item">
            <span className="route-statistics-label">{t('statistics.descent')}</span>
            <svg
              className="route-statistics-direction-icon"
              viewBox="0 0 12 14"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M6 2v10" />
              <path d="m2.5 8.5 3.5 3.5 3.5-3.5" />
            </svg>
            <strong>
              {hasElevation
                ? formatElevation(descentMeters, integerFormat)
                : unavailableValue}
            </strong>
          </div>

          <div
            className="route-statistics-item"
            title={t('statistics.durationTitle')}
          >
            <span className="route-statistics-label">{t('statistics.duration')}</span>
            <strong>
              {hasElevation
                ? formatDuration(
                    durationMinutes,
                    integerFormat,
                    t('units.hourShort'),
                    t('units.minuteShort'),
                  )
                : unavailableValue}
            </strong>
          </div>

          <button
            type="button"
            className={[
              'route-profile-toggle',
              isProfileVisible && hasProfile
                ? 'route-profile-toggle--active'
                : '',
            ]
              .filter(Boolean)
              .join(' ')}
            aria-label={profileButtonLabel}
            aria-expanded={isProfileVisible && hasProfile}
            aria-controls={profileId}
            title={profileButtonLabel}
            disabled={!hasProfile}
            onClick={() => setIsProfileVisible((isVisible) => !isVisible)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M3.5 18.5h17" />
              <path d="m4.5 16 4.1-5 3.2 3.2 3.5-7 4.2 8.8" />
            </svg>
          </button>
        </section>

        {editAction && (
          <button
            type="button"
            className="map-control-button route-summary-edit-button"
            aria-label={editAction.label}
            title={editAction.label}
            onClick={editAction.onClick}
          >
            <img src={penIconUrl} alt="" aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}
