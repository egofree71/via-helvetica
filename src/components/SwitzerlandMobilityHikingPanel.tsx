/**
 * Business context: presents the public identity and Via Helvetica-calculated
 * planning figures for one selected SwitzerlandMobility hiking route. The compact
 * bottom panel also resolves paths shared by several named routes and exposes the
 * calculated elevation profile without reproducing private editorial content.
 */
import { useEffect, useId, useMemo, useState } from 'react';
import { useI18n } from '../i18n/I18nContext';
import type { TranslationKey } from '../i18n/translations';
import type {
  SwitzerlandMobilityHikingPanelStatus,
} from '../map/useSwitzerlandMobilityHikingSelection';
import type { SwitzerlandMobilityHikingRouteCandidate } from '../switzerlandMobility/hikingRoutes';
import RouteElevationProfile from './RouteElevationProfile';

/** Props required by the compact public-route information panel. */
interface SwitzerlandMobilityHikingPanelProps {
  /** Current chooser, loading, ready, or error state. */
  status: SwitzerlandMobilityHikingPanelStatus;
  /** Selects one route when several candidates share the clicked path. */
  onSelectCandidate: (
    candidate: SwitzerlandMobilityHikingRouteCandidate,
  ) => void;
  /** Receives profile distance while the pointer explores the chart. */
  onProfileHoverDistanceChange: (distanceMeters: number | null) => void;
  /** Cumulative distance selected by hovering the public route on the map. */
  routeHoverDistanceMeters: number | null;
  /** Clears the panel, pending request, vector highlight, and profile marker. */
  onClose: () => void;
}

/** Duration is rounded to five minutes because it remains a planning estimate. */
const DURATION_ROUNDING_MINUTES = 5;

/** Translation helper subset used by route heading construction. */
type Translate = (
  key: TranslationKey,
  parameters?: Record<string, string | number>,
) => string;

/** Returns the best public route name, then a localized numeric fallback. */
function routeName(
  candidate: SwitzerlandMobilityHikingRouteCandidate,
  t: Translate,
): string {
  if (candidate.routeName) {
    return candidate.routeName;
  }

  if (candidate.routeNumber) {
    return t('switzerlandMobilityHiking.routeNumber', {
      number: candidate.routeNumber,
    });
  }

  return t('switzerlandMobilityHiking.unnamedRoute');
}

/** Builds the subtitle shown below a public route name. */
function routeSubtitle(
  candidate: SwitzerlandMobilityHikingRouteCandidate,
  t: Translate,
): string | null {
  const stageLabel = candidate.stageNumber
    ? t('switzerlandMobilityHiking.stage', {
        number: candidate.stageNumber,
      })
    : null;

  if (candidate.stageNumber && candidate.sectionName) {
    return t('switzerlandMobilityHiking.stageSection', {
      number: candidate.stageNumber,
      section: candidate.sectionName,
    });
  }

  return stageLabel ?? candidate.sectionName;
}

/** Formats short geometry in metres and hiking routes in localized kilometres. */
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

/** Formats ascent or descent in whole metres. */
function formatElevation(
  elevationMeters: number,
  integerFormat: Intl.NumberFormat,
): string {
  return `${integerFormat.format(Math.round(elevationMeters))} m`;
}

/** Formats an approximate duration after rounding to the nearest five minutes. */
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

/** Compact bottom panel for public route identity, overlap choice, and metrics. */
export default function SwitzerlandMobilityHikingPanel({
  status,
  onSelectCandidate,
  onProfileHoverDistanceChange,
  routeHoverDistanceMeters,
  onClose,
}: SwitzerlandMobilityHikingPanelProps) {
  const { locale, t } = useI18n();
  const [isProfileVisible, setIsProfileVisible] = useState(false);
  const profileId = useId();
  const integerFormat = useMemo(
    () => new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }),
    [locale],
  );
  const distanceFormat = useMemo(
    () => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }),
    [locale],
  );
  const candidate =
    status.state === 'choices'
      ? null
      : status.state === 'ready'
        ? status.route
        : status.candidate;
  const profileRouteKey =
    status.state === 'ready'
      ? String(status.route.featureId)
      : status.state;
  const hasProfile =
    status.state === 'ready' &&
    status.elevationStatus === 'ready' &&
    status.elevation !== null &&
    status.elevation.points.length >= 2;
  const profileButtonLabel = hasProfile
    ? isProfileVisible
      ? t('profile.hide')
      : t('profile.show')
    : status.state === 'ready' && status.elevationStatus === 'loading'
      ? t('profile.loading')
      : t('profile.unavailable');
  const candidateSubtitle = candidate ? routeSubtitle(candidate, t) : null;

  // A new stage must never inherit an expanded chart or marker position from
  // the previously selected public route, even if both use the same panel.
  useEffect(() => {
    setIsProfileVisible(false);
    onProfileHoverDistanceChange(null);
  }, [onProfileHoverDistanceChange, profileRouteKey]);

  const toggleProfile = () => {
    if (isProfileVisible) {
      onProfileHoverDistanceChange(null);
    }

    setIsProfileVisible((isVisible) => !isVisible);
  };

  return (
    <div
      className={[
        'switzerland-mobility-hiking-summary',
        status.state === 'ready'
          ? 'switzerland-mobility-hiking-summary--selected'
          : status.state === 'choices'
            ? 'switzerland-mobility-hiking-summary--choices'
            : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {status.state === 'ready' &&
        isProfileVisible &&
        hasProfile && (
          <RouteElevationProfile
            id={profileId}
            points={status.elevation!.points}
            onHoverDistanceChange={onProfileHoverDistanceChange}
            externalHoverDistanceMeters={routeHoverDistanceMeters}
          />
        )}

      <section
        className={[
          'switzerland-mobility-hiking-panel',
          status.state === 'choices'
            ? 'switzerland-mobility-hiking-panel--choices'
            : '',
        ]
          .filter(Boolean)
          .join(' ')}
        aria-label={t('switzerlandMobilityHiking.panelAria')}
        aria-live="polite"
      >
        <header className="switzerland-mobility-hiking-panel-header">
          <div className="switzerland-mobility-hiking-panel-heading">
            <strong>
              {status.state === 'choices'
                ? t('switzerlandMobilityHiking.multipleTitle')
                : candidate
                  ? routeName(candidate, t)
                  : t('switzerlandMobilityHiking.unnamedRoute')}
            </strong>
            {candidateSubtitle && <span>{candidateSubtitle}</span>}
          </div>

          <div className="switzerland-mobility-hiking-panel-actions">
            <button
              type="button"
              className="switzerland-mobility-hiking-panel-close"
              aria-label={t('switzerlandMobilityHiking.close')}
              title={t('switzerlandMobilityHiking.close')}
              onClick={onClose}
            >
              ×
            </button>
          </div>
        </header>

        {status.state === 'choices' && (
          <div className="switzerland-mobility-hiking-route-choices">
            <p>{t('switzerlandMobilityHiking.multipleHint')}</p>
            <div>
              {status.candidates.map((routeCandidate) => {
                const subtitle = routeSubtitle(routeCandidate, t);

                return (
                  <button
                    type="button"
                    key={String(routeCandidate.featureId)}
                    onClick={() => onSelectCandidate(routeCandidate)}
                  >
                    <strong>{routeName(routeCandidate, t)}</strong>
                    {subtitle && <span>{subtitle}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {status.state === 'loading' && (
          <p className="switzerland-mobility-hiking-panel-status">
            {t('switzerlandMobilityHiking.loading')}
          </p>
        )}

        {status.state === 'error' && (
          <p
            className={[
              'switzerland-mobility-hiking-panel-status',
              'switzerland-mobility-hiking-panel-status--error',
            ].join(' ')}
          >
            {t('switzerlandMobilityHiking.loadError')}
          </p>
        )}

        {status.state === 'ready' && (
          <div className="switzerland-mobility-hiking-metrics">
            <div className="switzerland-mobility-hiking-metric-values">
              <div className="route-statistics-item">
                <span className="route-statistics-label">
                  {t('statistics.distance')}
                </span>
                <strong>
                  {formatDistance(
                    status.distanceMeters,
                    integerFormat,
                    distanceFormat,
                  )}
                </strong>
              </div>

              <div className="route-statistics-item">
                <span className="route-statistics-label">
                  {t('statistics.ascent')}
                </span>
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
                  {status.elevation
                    ? formatElevation(
                        status.elevation.ascentMeters,
                        integerFormat,
                      )
                    : status.elevationStatus === 'loading'
                      ? '…'
                      : '—'}
                </strong>
              </div>

              <div className="route-statistics-item">
                <span className="route-statistics-label">
                  {t('statistics.descent')}
                </span>
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
                  {status.elevation
                    ? formatElevation(
                        status.elevation.descentMeters,
                        integerFormat,
                      )
                    : status.elevationStatus === 'loading'
                      ? '…'
                      : '—'}
                </strong>
              </div>

              <div
                className="route-statistics-item"
                title={t('statistics.durationTitle')}
              >
                <span className="route-statistics-label">
                  {t('statistics.duration')}
                </span>
                <strong>
                  {status.durationMinutes !== null
                    ? formatDuration(
                        status.durationMinutes,
                        integerFormat,
                        t('units.hourShort'),
                        t('units.minuteShort'),
                      )
                    : status.elevationStatus === 'loading'
                      ? '…'
                      : '—'}
                </strong>
              </div>

              {status.elevationStatus === 'error' && (
                <span className="switzerland-mobility-hiking-elevation-error">
                  {t('switzerlandMobilityHiking.elevationUnavailable')}
                </span>
              )}
            </div>

            <button
              type="button"
              className={[
                'route-profile-toggle',
                'switzerland-mobility-hiking-profile-toggle',
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
              onClick={toggleProfile}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M3.5 18.5h17" />
                <path d="m4.5 16 4.1-5 3.2 3.2 3.5-7 4.2 8.8" />
              </svg>
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
