/**
 * Business context: groups background selection and optional information
 * overlays behind one compact map control. This prevents the permanent control
 * column from growing whenever the project adds another useful map layer.
 */
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n/I18nContext';
import type { BaseMapStyle } from '../map/config';

/** Controlled layer choices owned by the root map component. */
interface MapLayersSelectorProps {
  /** Background currently displayed by the OpenLayers base layer. */
  baseMapStyle: BaseMapStyle;
  /** Replaces the current background while preserving all overlays. */
  onBaseMapChange: (style: BaseMapStyle) => void;
  /** Whether official hiking trails are currently visible. */
  areHikingTrailsVisible: boolean;
  /** Shows or hides the official hiking-trail overlay. */
  onHikingTrailsChange: (isVisible: boolean) => void;
  /** Whether official SwitzerlandMobility hiking routes are visible. */
  isSwitzerlandMobilityHikingVisible: boolean;
  /** Shows or hides official SwitzerlandMobility hiking routes. */
  onSwitzerlandMobilityHikingChange: (isVisible: boolean) => void;
  /** Whether official hiking closures and detours are currently visible. */
  areTrailClosuresVisible: boolean;
  /** Shows or hides the official closure overlay. */
  onTrailClosuresChange: (isVisible: boolean) => void;
  /** Whether official shooting notices and danger zones are visible. */
  areShootingDangerZonesVisible: boolean;
  /** Shows or hides the official military danger-zone overlay. */
  onShootingDangerZonesChange: (isVisible: boolean) => void;
  /** Whether official public-transport stops are currently visible. */
  arePublicTransportStopsVisible: boolean;
  /** Shows or hides the official stop overlay. */
  onPublicTransportStopsChange: (isVisible: boolean) => void;
}

/** One mutually exclusive base-map choice and its translated label. */
interface BaseMapOption {
  value: BaseMapStyle;
  labelKey:
    | 'map.baseMap.color'
    | 'map.baseMap.gray'
    | 'map.baseMap.aerial';
}

const BASE_MAP_OPTIONS: BaseMapOption[] = [
  { value: 'color', labelKey: 'map.baseMap.color' },
  { value: 'gray', labelKey: 'map.baseMap.gray' },
  { value: 'aerial', labelKey: 'map.baseMap.aerial' },
];

/** Renders a compact button that opens the unified map-layer menu. */
export default function MapLayersSelector({
  baseMapStyle,
  onBaseMapChange,
  areHikingTrailsVisible,
  onHikingTrailsChange,
  isSwitzerlandMobilityHikingVisible,
  onSwitzerlandMobilityHikingChange,
  areTrailClosuresVisible,
  onTrailClosuresChange,
  areShootingDangerZonesVisible,
  onShootingDangerZonesChange,
  arePublicTransportStopsVisible,
  onPublicTransportStopsChange,
}: MapLayersSelectorProps) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const label = t('map.layers.select');

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('pointerdown', closeOnOutsidePress);
    document.addEventListener('keydown', closeOnEscape);

    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePress);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [isOpen]);

  return (
    <div className="map-layers-selector" ref={rootRef}>
      <button
        type="button"
        className={[
          'map-control-button',
          'map-control-button--map-layers',
          isOpen ? 'map-control-button--menu-open' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        aria-label={label}
        aria-expanded={isOpen}
        aria-haspopup="menu"
        title={label}
        onClick={() => setIsOpen((open) => !open)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="m12 3 8 4.5-8 4.5-8-4.5L12 3Z" />
          <path d="m4 12 8 4.5 8-4.5" />
          <path d="m4 16.5 8 4.5 8-4.5" />
        </svg>
      </button>

      {isOpen && (
        <div className="map-layers-menu" role="menu" aria-label={label}>
          <section
            className="map-layers-section"
            role="group"
            aria-labelledby="map-layers-base-maps-title"
          >
            <h2
              id="map-layers-base-maps-title"
              className="map-layers-section-title"
            >
              {t('map.layers.baseMaps')}
            </h2>

            {BASE_MAP_OPTIONS.map((option) => {
              const isSelected = option.value === baseMapStyle;
              const optionLabel = t(option.labelKey);

              return (
                <button
                  key={option.value}
                  type="button"
                  className={[
                    'map-layer-option',
                    isSelected ? 'map-layer-option--selected' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  role="menuitemradio"
                  aria-checked={isSelected}
                  onClick={() => onBaseMapChange(option.value)}
                >
                  <span
                    className={`base-map-option-preview base-map-option-preview--${option.value}`}
                    aria-hidden="true"
                  />
                  <span>{optionLabel}</span>
                  {isSelected && (
                    <svg
                      className="map-layer-option-check"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                      focusable="false"
                    >
                      <path d="m5 12.5 4.5 4.5L19 7.5" />
                    </svg>
                  )}
                </button>
              );
            })}
          </section>

          <section
            className="map-layers-section map-layers-section--overlays"
            role="group"
            aria-labelledby="map-layers-information-title"
          >
            <h2
              id="map-layers-information-title"
              className="map-layers-section-title"
            >
              {t('map.layers.information')}
            </h2>

            <button
              type="button"
              className={[
                'map-layer-option',
                'map-layer-option--overlay',
                areHikingTrailsVisible
                  ? 'map-layer-option--selected'
                  : '',
              ]
                .filter(Boolean)
                .join(' ')}
              role="menuitemcheckbox"
              aria-checked={areHikingTrailsVisible}
              onClick={() =>
                onHikingTrailsChange(!areHikingTrailsVisible)
              }
            >
              <span>{t('hikingTrails.layer')}</span>
              <span
                className={[
                  'map-layer-option-toggle',
                  areHikingTrailsVisible
                    ? 'map-layer-option-toggle--checked'
                    : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                aria-hidden="true"
              >
                <span />
              </span>
            </button>

            <button
              type="button"
              className={[
                'map-layer-option',
                'map-layer-option--overlay',
                isSwitzerlandMobilityHikingVisible
                  ? 'map-layer-option--selected'
                  : '',
              ]
                .filter(Boolean)
                .join(' ')}
              role="menuitemcheckbox"
              aria-checked={isSwitzerlandMobilityHikingVisible}
              onClick={() =>
                onSwitzerlandMobilityHikingChange(
                  !isSwitzerlandMobilityHikingVisible,
                )
              }
            >
              <span>{t('switzerlandMobilityHiking.layer')}</span>
              <span
                className={[
                  'map-layer-option-toggle',
                  isSwitzerlandMobilityHikingVisible
                    ? 'map-layer-option-toggle--checked'
                    : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                aria-hidden="true"
              >
                <span />
              </span>
            </button>

            <button
              type="button"
              className={[
                'map-layer-option',
                'map-layer-option--overlay',
                areTrailClosuresVisible
                  ? 'map-layer-option--selected'
                  : '',
              ]
                .filter(Boolean)
                .join(' ')}
              role="menuitemcheckbox"
              aria-checked={areTrailClosuresVisible}
              onClick={() =>
                onTrailClosuresChange(!areTrailClosuresVisible)
              }
            >
              <span>{t('closures.layer')}</span>
              <span
                className={[
                  'map-layer-option-toggle',
                  areTrailClosuresVisible
                    ? 'map-layer-option-toggle--checked'
                    : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                aria-hidden="true"
              >
                <span />
              </span>
            </button>

            <button
              type="button"
              className={[
                'map-layer-option',
                'map-layer-option--overlay',
                areShootingDangerZonesVisible
                  ? 'map-layer-option--selected'
                  : '',
              ]
                .filter(Boolean)
                .join(' ')}
              role="menuitemcheckbox"
              aria-checked={areShootingDangerZonesVisible}
              onClick={() =>
                onShootingDangerZonesChange(
                  !areShootingDangerZonesVisible,
                )
              }
            >
              <span>{t('shootingDangerZones.layer')}</span>
              <span
                className={[
                  'map-layer-option-toggle',
                  areShootingDangerZonesVisible
                    ? 'map-layer-option-toggle--checked'
                    : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                aria-hidden="true"
              >
                <span />
              </span>
            </button>

            <button
              type="button"
              className={[
                'map-layer-option',
                'map-layer-option--overlay',
                arePublicTransportStopsVisible
                  ? 'map-layer-option--selected'
                  : '',
              ]
                .filter(Boolean)
                .join(' ')}
              role="menuitemcheckbox"
              aria-checked={arePublicTransportStopsVisible}
              onClick={() =>
                onPublicTransportStopsChange(
                  !arePublicTransportStopsVisible,
                )
              }
            >
              <span>{t('transportStops.layer')}</span>
              <span
                className={[
                  'map-layer-option-toggle',
                  arePublicTransportStopsVisible
                    ? 'map-layer-option-toggle--checked'
                    : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                aria-hidden="true"
              >
                <span />
              </span>
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
