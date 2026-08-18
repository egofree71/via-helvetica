/**
 * Business context: presents exact coordinates for one desktop right-click in
 * the same compact lower-map region used by ambiguity choices. Coordinates are
 * immediately useful even if the optional terrain-height request fails.
 */
import { useEffect } from 'react';
import { useI18n } from '../i18n/I18nContext';
import type { MapPositionInspection } from '../map/useMapPositionInspection';

/** Props for the temporary desktop map-position panel. */
interface MapPositionPanelProps {
  /** Exact point plus asynchronous altitude state. */
  inspection: MapPositionInspection;
  /** Clears the panel, marker, and pending height request. */
  onClose: () => void;
}

/** Formats one rounded Swiss coordinate with the customary apostrophe grouping. */
function formatSwissInteger(value: number): string {
  const rounded = Math.round(value);
  const sign = rounded < 0 ? '-' : '';
  const digits = String(Math.abs(rounded));
  return `${sign}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, "'")}`;
}

/** Displays WGS 84 in the latitude, longitude order familiar to map users. */
export function formatWgs84MapPosition(coordinate: number[]): string {
  return `${coordinate[1].toFixed(5)}, ${coordinate[0].toFixed(5)}`;
}

/** Displays native LV95 easting/northing rounded to the nearest metre. */
export function formatLv95MapPosition(coordinate: number[]): string {
  return `${formatSwissInteger(coordinate[0])}, ${formatSwissInteger(coordinate[1])}`;
}

/** Copies one displayed coordinate without adding hidden labels or metadata. */
async function copyCoordinate(value: string): Promise<void> {
  if (!navigator.clipboard?.writeText) {
    throw new Error('Clipboard API is unavailable.');
  }

  await navigator.clipboard.writeText(value);
}

/** Small copy glyph reused by the two coordinate rows. */
function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="7" y="7" width="12" height="13" rx="1.5" />
      <path d="M5 17H4.5A1.5 1.5 0 0 1 3 15.5v-11A1.5 1.5 0 0 1 4.5 3h11A1.5 1.5 0 0 1 17 4.5V5" />
    </svg>
  );
}

/** Compact bottom-centred position panel shown only after a desktop right-click. */
export default function MapPositionPanel({
  inspection,
  onClose,
}: MapPositionPanelProps) {
  const { t } = useI18n();
  const wgs84Text = formatWgs84MapPosition(inspection.wgs84Coordinate);
  const lv95Text = formatLv95MapPosition(inspection.coordinate);
  let elevationText = t('mapPosition.altitudeUnavailable');

  if (inspection.elevationStatus === 'loading') {
    elevationText = t('mapPosition.altitudeLoading');
  } else if (
    inspection.elevationStatus === 'ready' &&
    inspection.elevationMeters !== null
  ) {
    elevationText = `${Math.round(inspection.elevationMeters)} m`;
  }

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  const requestCopy = (value: string) => {
    void copyCoordinate(value).catch((error: unknown) => {
      console.error('Unable to copy map coordinates.', error);
    });
  };

  return (
    <div className="map-position-summary">
      <section
        className="map-information-choice-panel map-position-panel"
        role="dialog"
        aria-label={t('mapPosition.title')}
      >
        <header className="map-information-choice-panel-header">
          <div className="map-information-choice-heading">
            <strong>{t('mapPosition.title')}</strong>
          </div>
          <button
            type="button"
            className="map-information-choice-close"
            aria-label={t('mapPosition.close')}
            title={t('mapPosition.close')}
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="map-position-content">
          <div className="map-position-row">
            <button
              type="button"
              className="map-position-copy"
              aria-label={t('mapPosition.copyWgs84')}
              title={t('mapPosition.copyWgs84')}
              onClick={() => requestCopy(wgs84Text)}
            >
              <CopyIcon />
            </button>
            <div className="map-position-value">
              <span>{t('mapPosition.wgs84')}</span>
              <strong>{wgs84Text}</strong>
            </div>
          </div>

          <div className="map-position-row">
            <button
              type="button"
              className="map-position-copy"
              aria-label={t('mapPosition.copyLv95')}
              title={t('mapPosition.copyLv95')}
              onClick={() => requestCopy(lv95Text)}
            >
              <CopyIcon />
            </button>
            <div className="map-position-value">
              <span>{t('mapPosition.lv95')}</span>
              <strong>{lv95Text}</strong>
            </div>
          </div>

          <div className="map-position-row map-position-row--altitude">
            <span className="map-position-altitude-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" focusable="false">
                <path d="M3.5 18.5h17" />
                <path d="m4.5 16 4.1-5 3.2 3.2 3.5-7 4.2 8.8" />
              </svg>
            </span>
            <div className="map-position-value">
              <span>{t('mapPosition.altitude')}</span>
              <strong aria-live="polite">{elevationText}</strong>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
