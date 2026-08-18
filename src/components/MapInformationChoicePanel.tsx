/**
 * Business context: resolves a map click that matches several useful planning
 * objects across different layers. The chooser stays compact and temporary;
 * each selected object then continues in its existing detailed workflow.
 */
import { useEffect } from 'react';
import dangerIconUrl from '../assets/map-information/other-dangers.svg';
import hikingIconUrl from '../assets/map-information/hiking.svg';
import pedestriansProhibitedIconUrl from '../assets/map-information/pedestrians-prohibited.svg';
import { useI18n } from '../i18n/I18nContext';
import type { MapInformationChoice } from '../map/mapInformationChoice';
import {
  getSwitzerlandMobilityHikingRouteName,
  getSwitzerlandMobilityHikingRouteSubtitle,
} from '../switzerlandMobility/hikingRoutePresentation';
import type { PublicTransportMode } from '../transport/publicTransportStops';
import { getPrimaryPublicTransportMode } from '../transport/publicTransportStopModel';
import { PUBLIC_TRANSPORT_MODE_ICON_URLS } from '../transport/publicTransportModePresentation';

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

/** Props for the common map-information ambiguity chooser. */
interface MapInformationChoicePanelProps {
  /** Choices collected for one click, already ordered by product priority. */
  choices: MapInformationChoice[];
  /** Dispatches the selected item to its dedicated detail workflow. */
  onSelectChoice: (choice: MapInformationChoice) => void;
  /** Dismisses the chooser and all retained map-information context. */
  onClose: () => void;
}

/** Stable React key for each provider-backed choice. */
function choiceKey(choice: MapInformationChoice): string {
  switch (choice.kind) {
    case 'trailClosure':
      return `closure:${String(choice.closure.featureId)}`;
    case 'shootingDangerZone':
      return `danger:${String(choice.dangerZone.featureId)}`;
    case 'publicTransportStop':
      return `stop:${choice.stop.id}`;
    case 'switzerlandMobilityHiking':
      return `route:${String(choice.candidate.featureId)}`;
  }
}

/** Decorative category icon that makes mixed map choices easier to scan. */
function ChoiceTypeIcon({ choice }: { choice: MapInformationChoice }) {
  switch (choice.kind) {
    case 'trailClosure':
      return (
        <img
          src={pedestriansProhibitedIconUrl}
          alt=""
          aria-hidden="true"
        />
      );
    case 'shootingDangerZone':
      return <img src={dangerIconUrl} alt="" aria-hidden="true" />;
    case 'publicTransportStop': {
      const mode = getPrimaryPublicTransportMode(choice.stop.modes);
      return (
        <img
          src={PUBLIC_TRANSPORT_MODE_ICON_URLS[mode]}
          alt=""
          aria-hidden="true"
        />
      );
    }
    case 'switzerlandMobilityHiking':
      return <img src={hikingIconUrl} alt="" aria-hidden="true" />;
  }
}

/** CSS modifier matching the semantic category represented by one choice. */
function choiceIconModifier(choice: MapInformationChoice): string {
  switch (choice.kind) {
    case 'trailClosure':
      return 'map-information-choice-icon--closure';
    case 'shootingDangerZone':
      return 'map-information-choice-icon--danger';
    case 'publicTransportStop':
      return 'map-information-choice-icon--transport';
    case 'switzerlandMobilityHiking':
      return 'map-information-choice-icon--hiking';
  }
}

/** Common bottom-center chooser for all information layers sharing one click. */
export default function MapInformationChoicePanel({
  choices,
  onSelectChoice,
  onClose,
}: MapInformationChoicePanelProps) {
  const { t } = useI18n();
  const safetyChoices = choices.filter(
    (choice) =>
      choice.kind === 'trailClosure' ||
      choice.kind === 'shootingDangerZone',
  );
  const transportChoices = choices.filter(
    (choice) => choice.kind === 'publicTransportStop',
  );
  const routeChoices = choices.filter(
    (choice) => choice.kind === 'switzerlandMobilityHiking',
  );

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  const renderChoice = (choice: MapInformationChoice) => {
    let title: string;
    let subtitle: string | null = null;

    switch (choice.kind) {
      case 'trailClosure':
        title = t('closures.title');
        break;
      case 'shootingDangerZone':
        title = t('shootingDangerZones.title');
        break;
      case 'publicTransportStop':
        title = choice.stop.name;
        subtitle = choice.stop.modes
          .map((mode) => t(MODE_LABEL_KEYS[mode]))
          .join(' · ');
        break;
      case 'switzerlandMobilityHiking':
        title = getSwitzerlandMobilityHikingRouteName(choice.candidate, t);
        subtitle = getSwitzerlandMobilityHikingRouteSubtitle(
          choice.candidate,
          t,
        );
        break;
    }

    return (
      <button
        key={choiceKey(choice)}
        type="button"
        className="map-information-choice"
        onClick={() => onSelectChoice(choice)}
      >
        <span
          className={`map-information-choice-icon ${choiceIconModifier(choice)}`}
          aria-hidden="true"
        >
          <ChoiceTypeIcon choice={choice} />
        </span>
        <span className="map-information-choice-label">
          <strong>{title}</strong>
          {subtitle && (
            <span className="map-information-choice-subtitle">{subtitle}</span>
          )}
        </span>
      </button>
    );
  };

  return (
    <div className="map-information-choice-summary">
      <section
        className="map-information-choice-panel"
        role="dialog"
        aria-label={t('mapInformationChoice.title')}
      >
        <header className="map-information-choice-panel-header">
          <div className="map-information-choice-heading">
            <strong>{t('mapInformationChoice.title')}</strong>
          </div>
          <button
            type="button"
            className="map-information-choice-close"
            aria-label={t('mapInformationChoice.close')}
            title={t('mapInformationChoice.close')}
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="map-information-choice-content">
          <p className="map-information-choice-hint">
            {t('mapInformationChoice.hint')}
          </p>
          <div className="map-information-choices">
            {safetyChoices.length > 0 && (
              <div className="map-information-choice-group">
                <h2>{t('mapInformationChoice.safety')}</h2>
                {safetyChoices.map(renderChoice)}
              </div>
            )}
            {transportChoices.length > 0 && (
              <div className="map-information-choice-group">
                <h2>{t('transportStops.layer')}</h2>
                {transportChoices.map(renderChoice)}
              </div>
            )}
            {routeChoices.length > 0 && (
              <div className="map-information-choice-group">
                <h2>{t('switzerlandMobilityHiking.layer')}</h2>
                {routeChoices.map(renderChoice)}
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
