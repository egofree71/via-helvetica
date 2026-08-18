/**
 * Business context: keeps a selected passenger stop tied to practical trip
 * planning. The panel identifies the stop and its transport modes, loads the
 * next departures from transport.opendata.ch, and still offers direct hand-off
 * links to the official SBB/CFF/FFS timetable.
 */
import { useEffect, useMemo, useState } from 'react';
import boatIconUrl from '../assets/public-transport-stops/boat.svg';
import busIconUrl from '../assets/public-transport-stops/bus.svg';
import cableCarIconUrl from '../assets/public-transport-stops/cable-car.svg';
import chairliftIconUrl from '../assets/public-transport-stops/chairlift.svg';
import funicularIconUrl from '../assets/public-transport-stops/funicular.svg';
import trainIconUrl from '../assets/public-transport-stops/train.svg';
import tramIconUrl from '../assets/public-transport-stops/tram.svg';
import { useI18n } from '../i18n/I18nContext';
import type { Language } from '../i18n/translations';
import {
  loadStationBoard,
  type StationBoardDeparture,
} from '../transport/stationBoard';
import type {
  PublicTransportMode,
  PublicTransportStop,
} from '../transport/publicTransportStops';

/** Temporary public-transport panel shown after a rendered stop is clicked. */
export type PublicTransportStopPopupStatus =
  | {
      /** Several loaded stops share the visual footprint of the clicked symbol. */
      state: 'choices';
      /** Clicked visible stop first, followed by hidden declutter neighbours. */
      stops: PublicTransportStop[];
    }
  | {
      /** One concrete stop has been selected for timetable inspection. */
      state: 'stop';
      /** Stop whose departures and official timetable links are displayed. */
      stop: PublicTransportStop;
    };

/** Choice/detail state and callbacks for the temporary stop panel. */
interface PublicTransportStopPopupProps {
  /** Current overlap chooser or concrete stop detail state. */
  status: PublicTransportStopPopupStatus;
  /** Resolves the chooser to one concrete stop. */
  onSelectStop: (stop: PublicTransportStop) => void;
  /** Dismisses the panel and its map selection halo. */
  onClose: () => void;
}

/** Concrete selected-stop detail state. */
interface PublicTransportStopDetailsProps {
  /** Stop feature already loaded and filtered by the vector overlay. */
  stop: PublicTransportStop;
  /** Dismisses the panel and its map selection halo. */
  onClose: () => void;
}

/** Loading state for the independently fetched stationboard. */
type StationBoardStatus = 'loading' | 'ready' | 'error';

/** Departures sharing one Swiss local calendar date. */
interface DepartureDateGroup {
  /** Stable calendar key used for React rendering. */
  dateKey: string;
  /** Localized date heading shown above the departures. */
  dateLabel: string;
  /** Chronologically sorted departures for that date. */
  departures: StationBoardDeparture[];
}

/** Timetable times belong to the Swiss public-transport service area. */
const SWISS_TIME_ZONE = 'Europe/Zurich';

/** Translation keys for normalized public-transport categories. */
const MODE_LABEL_KEYS: Record<
  PublicTransportMode,
  | 'transportStops.mode.train'
  | 'transportStops.mode.metro'
  | 'transportStops.mode.tram'
  | 'transportStops.mode.bus'
  | 'transportStops.mode.boat'
  | 'transportStops.mode.cableCar'
  | 'transportStops.mode.chairlift'
  | 'transportStops.mode.funicular'
> = {
  train: 'transportStops.mode.train',
  metro: 'transportStops.mode.metro',
  tram: 'transportStops.mode.tram',
  bus: 'transportStops.mode.bus',
  boat: 'transportStops.mode.boat',
  cableCar: 'transportStops.mode.cableCar',
  chairlift: 'transportStops.mode.chairlift',
  funicular: 'transportStops.mode.funicular',
};

/** SVG pictograms shared with the stop markers for immediate visual recognition. */
const MODE_ICON_URLS: Record<PublicTransportMode, string> = {
  train: trainIconUrl,
  // Metro has its own translated label but shares the clear railway symbol.
  metro: trainIconUrl,
  tram: tramIconUrl,
  bus: busIconUrl,
  boat: boatIconUrl,
  cableCar: cableCarIconUrl,
  chairlift: chairliftIconUrl,
  funicular: funicularIconUrl,
};

/** Manual SBB deep-link location parameters documented for timetable forms. */
type SbbLocationParameter = 'von' | 'nach';

/** Builds a localized official timetable URL with one prefilled stop field. */
function createSbbTimetableUrl(
  language: Language,
  parameter: SbbLocationParameter,
  stopName: string,
): string {
  const url = new URL(`https://www.sbb.ch/${language}`);
  url.searchParams.set(parameter, stopName);
  return url.toString();
}

/** Returns the predicted departure when available, otherwise the scheduled one. */
function getDisplayedDepartureTime(
  departure: StationBoardDeparture,
): string {
  return departure.estimatedDeparture ?? departure.plannedDeparture;
}

/** Builds a stable YYYY-MM-DD key in the Swiss time zone. */
function createDepartureDateKey(
  departureTime: string,
  dateKeyFormatter: Intl.DateTimeFormat,
): string {
  const parts = dateKeyFormatter.formatToParts(new Date(departureTime));
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;

  return year && month && day
    ? `${year}-${month}-${day}`
    : departureTime;
}

/** Renders a compact stop panel with departures and official timetable links. */
function PublicTransportStopDetails({
  stop,
  onClose,
}: PublicTransportStopDetailsProps) {
  const { language, locale, t } = useI18n();
  const [stationBoardStatus, setStationBoardStatus] =
    useState<StationBoardStatus>('loading');
  const [departures, setDepartures] = useState<StationBoardDeparture[]>([]);
  const [confirmedModes, setConfirmedModes] =
    useState<PublicTransportMode[]>([]);
  const displayedModes =
    stationBoardStatus === 'loading'
      ? stop.modes.slice(0, 1)
      : stationBoardStatus === 'ready' && confirmedModes.length > 0
        ? confirmedModes
        : stop.modes;
  const modeLabels = displayedModes.map((mode) => t(MODE_LABEL_KEYS[mode]));
  const departureUrl = createSbbTimetableUrl(
    language,
    'von',
    stop.name,
  );
  const destinationUrl = createSbbTimetableUrl(
    language,
    'nach',
    stop.name,
  );
  const timeFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: SWISS_TIME_ZONE,
      }),
    [locale],
  );
  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        weekday: 'long',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        timeZone: SWISS_TIME_ZONE,
      }),
    [locale],
  );
  const dateKeyFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat('en-CA', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        timeZone: SWISS_TIME_ZONE,
      }),
    [],
  );
  const hasDelayedDepartures = departures.some(
    (departure) => departure.delayMinutes !== null,
  );
  const departureDateGroups = useMemo<DepartureDateGroup[]>(() => {
    const groups: DepartureDateGroup[] = [];

    for (const departure of departures) {
      const departureTime = getDisplayedDepartureTime(departure);
      const departureDate = new Date(departureTime);
      const dateKey = createDepartureDateKey(
        departureTime,
        dateKeyFormatter,
      );
      const previousGroup = groups[groups.length - 1];

      if (previousGroup?.dateKey === dateKey) {
        previousGroup.departures.push(departure);
        continue;
      }

      groups.push({
        dateKey,
        dateLabel: dateFormatter.format(departureDate),
        departures: [departure],
      });
    }

    return groups;
  }, [dateFormatter, dateKeyFormatter, departures]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  useEffect(() => {
    const controller = new AbortController();
    setStationBoardStatus('loading');
    setDepartures([]);
    setConfirmedModes([]);

    void loadStationBoard(stop.stationId, controller.signal)
      .then((result) => {
        setDepartures(result.departures);
        setConfirmedModes(result.modes);
        setStationBoardStatus('ready');
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }

        console.error('Unable to load public-transport departures.', error);
        setStationBoardStatus('error');
      });

    return () => controller.abort();
  }, [stop.id, stop.stationId]);

  return (
    <aside
      className="map-information-popup public-transport-stop-popup"
      role="dialog"
      aria-label={stop.name}
    >
      <header className="map-information-popup-header">
        <div className="public-transport-stop-heading">
          <strong>{stop.name}</strong>
          {displayedModes.length > 0 && (
            <div className="public-transport-stop-modes">
              {displayedModes.map((mode, index) => (
                <img
                  key={mode}
                  src={MODE_ICON_URLS[mode]}
                  alt={modeLabels[index]}
                  title={modeLabels[index]}
                />
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          className="map-information-popup-close"
          aria-label={t('transportStops.close')}
          title={t('transportStops.close')}
          onClick={onClose}
        >
          ×
        </button>
      </header>

      <div className="map-information-popup-body">
        <section
          className="public-transport-departures"
          aria-labelledby="public-transport-departures-title"
          aria-live="polite"
        >
          <h2 id="public-transport-departures-title">
            {t('transportStops.departures')}
          </h2>

          {stationBoardStatus === 'loading' && (
            <p className="public-transport-departures-status">
              {t('transportStops.departuresLoading')}
            </p>
          )}

          {stationBoardStatus === 'error' && (
            <p className="public-transport-departures-status map-information-popup-error">
              {t('transportStops.departuresError')}
            </p>
          )}

          {stationBoardStatus === 'ready' && departures.length === 0 && (
            <p className="public-transport-departures-status">
              {t('transportStops.noDepartures')}
            </p>
          )}

          {stationBoardStatus === 'ready' && departures.length > 0 && (
            <div className="public-transport-departure-groups">
              {departureDateGroups.map((group) => (
                <section
                  className="public-transport-departure-group"
                  key={group.dateKey}
                >
                  <h3>{group.dateLabel}</h3>
                  <ol
                    className={
                      hasDelayedDepartures
                        ? 'public-transport-departure-list public-transport-departure-list--with-delay'
                        : 'public-transport-departure-list'
                    }
                  >
                    {group.departures.map((departure) => (
                      <li key={departure.id}>
                        <span
                          className="public-transport-departure-line"
                          title={departure.line}
                        >
                          {departure.line}
                        </span>
                        <span className="public-transport-departure-destination">
                          {departure.destination}
                        </span>
                        <time
                          dateTime={getDisplayedDepartureTime(departure)}
                          className={
                            departure.delayMinutes !== null
                              ? 'public-transport-departure-time public-transport-departure-time--delayed'
                              : 'public-transport-departure-time'
                          }
                        >
                          {timeFormatter.format(
                            new Date(getDisplayedDepartureTime(departure)),
                          )}
                        </time>
                        {departure.delayMinutes !== null && (
                          <span
                            className="public-transport-departure-delay"
                            title={t('transportStops.delayTitle')}
                          >
                            +{departure.delayMinutes}{' '}
                            {t('units.minuteShort')}
                          </span>
                        )}
                      </li>
                    ))}
                  </ol>
                </section>
              ))}
            </div>
          )}
        </section>

        <div className="public-transport-stop-links">
          <a href={departureUrl} target="_blank" rel="noopener noreferrer">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M5 19 19 5" />
              <path d="M10 5h9v9" />
            </svg>
            <span>{t('transportStops.sbbDeparture')}</span>
          </a>
          <a href={destinationUrl} target="_blank" rel="noopener noreferrer">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M5 19 19 5" />
              <path d="M10 5h9v9" />
            </svg>
            <span>{t('transportStops.sbbDestination')}</span>
          </a>
        </div>
      </div>
    </aside>
  );
}

/** Lets the user resolve multiple stops represented by one decluttered symbol. */
function PublicTransportStopChoices({
  stops,
  onSelectStop,
  onClose,
}: {
  stops: PublicTransportStop[];
  onSelectStop: (stop: PublicTransportStop) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  return (
    <div className="public-transport-stop-choice-summary">
      <section
        className="public-transport-stop-choice-panel"
        role="dialog"
        aria-label={t('transportStops.choicesTitle')}
      >
        <header className="public-transport-stop-choice-panel-header">
          <div className="public-transport-stop-heading">
            <strong>{t('transportStops.choicesTitle')}</strong>
          </div>
          <button
            type="button"
            className="public-transport-stop-choice-close"
            aria-label={t('transportStops.close')}
            title={t('transportStops.close')}
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="public-transport-stop-choice-content">
          <p className="public-transport-stop-choice-hint">
            {t('transportStops.choicesHint')}
          </p>
          <div className="public-transport-stop-choices">
            {stops.map((stop) => (
              <button
                key={stop.id}
                type="button"
                className="public-transport-stop-choice"
                onClick={() => onSelectStop(stop)}
              >
                <span>{stop.name}</span>
                <span className="public-transport-stop-choice-modes">
                  {stop.modes.map((mode) => (
                    <img
                      key={mode}
                      src={MODE_ICON_URLS[mode]}
                      alt={t(MODE_LABEL_KEYS[mode])}
                      title={t(MODE_LABEL_KEYS[mode])}
                    />
                  ))}
                </span>
              </button>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

/** Renders either the stop-overlap chooser or the selected stop timetable. */
export default function PublicTransportStopPopup({
  status,
  onSelectStop,
  onClose,
}: PublicTransportStopPopupProps) {
  if (status.state === 'choices') {
    return (
      <PublicTransportStopChoices
        stops={status.stops}
        onSelectStop={onSelectStop}
        onClose={onClose}
      />
    );
  }

  return <PublicTransportStopDetails stop={status.stop} onClose={onClose} />;
}

