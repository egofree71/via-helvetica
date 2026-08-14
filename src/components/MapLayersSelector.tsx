/**
 * Business context: groups background selection and optional information
 * overlays behind one compact map control. Each overlay can be shown, hidden,
 * and made more or less opaque without growing the permanent control column.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useI18n } from '../i18n/I18nContext';
import {
  MINIMUM_MAP_LAYER_OPACITY,
  type BaseMapStyle,
} from '../map/config';
import type {
  MapLayerOpacities,
  MapLayerOpacityKey,
} from '../map/useMapLayerOpacities';

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
  /** Current persisted opacity ratio for every optional information layer. */
  layerOpacities: MapLayerOpacities;
  /** Changes and persists one optional information-layer opacity. */
  onLayerOpacityChange: (
    layer: MapLayerOpacityKey,
    opacity: number,
  ) => void;
}

/** One mutually exclusive base-map choice and its translated label. */
interface BaseMapOption {
  value: BaseMapStyle;
  labelKey:
    | 'map.baseMap.color'
    | 'map.baseMap.gray'
    | 'map.baseMap.aerial';
}

/** One optional overlay rendered by the shared visibility and opacity row. */
interface OverlayLayerOption {
  /** Stable key used to read and update the layer's persisted opacity. */
  layer: MapLayerOpacityKey;
  /** Translation key displayed as the overlay row label. */
  labelKey:
    | 'hikingTrails.layer'
    | 'switzerlandMobilityHiking.layer'
    | 'closures.layer'
    | 'shootingDangerZones.layer'
    | 'transportStops.layer';
  /** Whether the corresponding OpenLayers information layer is displayed. */
  isVisible: boolean;
  /** Shows or hides the layer without changing its stored opacity. */
  onVisibilityChange: (isVisible: boolean) => void;
}

/** Props for one accessible overlay row and its expandable opacity slider. */
interface OverlayLayerControlProps {
  /** Layer identity, visibility state, label key, and visibility action. */
  option: OverlayLayerOption;
  /** Localized user-facing layer name. */
  label: string;
  /** Current OpenLayers opacity ratio from the product minimum to 1. */
  opacity: number;
  /** Localized label shown beside the slider. */
  opacityLabel: string;
  /** Accessible label and tooltip for the opacity settings button. */
  opacitySettingsLabel: string;
  /** Whether this layer currently owns the expanded opacity panel. */
  isOpacityOpen: boolean;
  /** Opens or closes this layer's opacity panel. */
  onToggleOpacity: () => void;
  /** Applies a new opacity ratio selected with the slider. */
  onOpacityChange: (opacity: number) => void;
}

const BASE_MAP_OPTIONS: BaseMapOption[] = [
  { value: 'color', labelKey: 'map.baseMap.color' },
  { value: 'gray', labelKey: 'map.baseMap.gray' },
  { value: 'aerial', labelKey: 'map.baseMap.aerial' },
];

/** Converts an OpenLayers opacity ratio to the integer percentage shown in UI. */
function opacityPercent(opacity: number): number {
  return Math.round(opacity * 100);
}

/** Renders one overlay visibility row and its independently expandable slider. */
function OverlayLayerControl({
  option,
  label,
  opacity,
  opacityLabel,
  opacitySettingsLabel,
  isOpacityOpen,
  onToggleOpacity,
  onOpacityChange,
}: OverlayLayerControlProps) {
  const sliderId = `map-layer-opacity-${option.layer}`;
  const settingsId = `${sliderId}-settings`;
  const rowLabelId = `${sliderId}-layer-label`;
  const opacityLabelId = `${sliderId}-label`;
  const percentage = opacityPercent(opacity);
  const opacityIconMaskId = `settings-${useId().replace(/:/g, '')}`;

  return (
    <div
      className={[
        'map-layer-control',
        option.isVisible ? 'map-layer-control--selected' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <button
        type="button"
        className="map-layer-option map-layer-option--overlay"
        role="menuitemcheckbox"
        aria-checked={option.isVisible}
        onClick={() => option.onVisibilityChange(!option.isVisible)}
      >
        <span id={rowLabelId}>{label}</span>
        <span
          className={[
            'map-layer-option-toggle',
            option.isVisible ? 'map-layer-option-toggle--checked' : '',
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
          'map-layer-opacity-button',
          isOpacityOpen ? 'map-layer-opacity-button--open' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        aria-label={opacitySettingsLabel}
        title={opacitySettingsLabel}
        aria-expanded={option.isVisible && isOpacityOpen}
        aria-controls={
          option.isVisible && isOpacityOpen ? settingsId : undefined
        }
        disabled={!option.isVisible}
        onClick={onToggleOpacity}
      >
        <svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">
          <defs>
            <mask id={opacityIconMaskId}>
              <rect width="100" height="100" fill="white" />
              <circle cx="50" cy="50" r="18" fill="black" />
            </mask>
          </defs>
          <g fill="currentColor" mask={`url(#${opacityIconMaskId})`}>
            <circle cx="50" cy="50" r="31" />
            {[0, 45, 90, 135, 180, 225, 270, 315].map((angle) => (
              <rect
                key={angle}
                x="42"
                y="1"
                width="16"
                height="28"
                rx="4"
                transform={`rotate(${angle} 50 50)`}
              />
            ))}
          </g>
        </svg>
      </button>

      {option.isVisible && isOpacityOpen && (
        <div
          id={settingsId}
          className="map-layer-opacity-settings"
        >
          <label id={opacityLabelId} htmlFor={sliderId}>
            {opacityLabel}
          </label>
          <input
            id={sliderId}
            type="range"
            min={opacityPercent(MINIMUM_MAP_LAYER_OPACITY)}
            max="100"
            step="5"
            value={percentage}
            aria-labelledby={`${rowLabelId} ${opacityLabelId}`}
            aria-valuetext={`${percentage} %`}
            onChange={(event) =>
              onOpacityChange(Number(event.currentTarget.value) / 100)
            }
          />
          <span className="map-layer-opacity-value" aria-hidden="true">
            {percentage} %
          </span>
        </div>
      )}
    </div>
  );
}

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
  layerOpacities,
  onLayerOpacityChange,
}: MapLayersSelectorProps) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [expandedOpacityLayer, setExpandedOpacityLayer] =
    useState<MapLayerOpacityKey | null>(null);
  const label = t('map.layers.select');

  const closeMenu = useCallback(() => {
    setIsOpen(false);
    setExpandedOpacityLayer(null);
  }, []);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        closeMenu();
      }
    };

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeMenu();
      }
    };

    document.addEventListener('pointerdown', closeOnOutsidePress);
    document.addEventListener('keydown', closeOnEscape);

    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePress);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [closeMenu, isOpen]);

  const overlayOptions: OverlayLayerOption[] = [
    {
      layer: 'hikingTrails',
      labelKey: 'hikingTrails.layer',
      isVisible: areHikingTrailsVisible,
      onVisibilityChange: onHikingTrailsChange,
    },
    {
      layer: 'switzerlandMobilityHiking',
      labelKey: 'switzerlandMobilityHiking.layer',
      isVisible: isSwitzerlandMobilityHikingVisible,
      onVisibilityChange: onSwitzerlandMobilityHikingChange,
    },
    {
      layer: 'trailClosures',
      labelKey: 'closures.layer',
      isVisible: areTrailClosuresVisible,
      onVisibilityChange: onTrailClosuresChange,
    },
    {
      layer: 'shootingDangerZones',
      labelKey: 'shootingDangerZones.layer',
      isVisible: areShootingDangerZonesVisible,
      onVisibilityChange: onShootingDangerZonesChange,
    },
    {
      layer: 'publicTransportStops',
      labelKey: 'transportStops.layer',
      isVisible: arePublicTransportStopsVisible,
      onVisibilityChange: onPublicTransportStopsChange,
    },
  ];

  useEffect(() => {
    if (!expandedOpacityLayer) {
      return;
    }

    const expandedLayerIsVisible = overlayOptions.find(
      (option) => option.layer === expandedOpacityLayer,
    )?.isVisible;

    // A hidden layer has no visible opacity feedback. Closing its transient
    // panel also prevents it from reopening unexpectedly when visibility returns.
    if (expandedLayerIsVisible === false) {
      setExpandedOpacityLayer(null);
    }
  }, [
    areHikingTrailsVisible,
    arePublicTransportStopsVisible,
    areShootingDangerZonesVisible,
    areTrailClosuresVisible,
    expandedOpacityLayer,
    isSwitzerlandMobilityHikingVisible,
  ]);

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
        onClick={() => {
          if (isOpen) {
            closeMenu();
          } else {
            setIsOpen(true);
          }
        }}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="m12 3 8 4.5-8 4.5-8-4.5L12 3Z" />
          <path d="m4 12 8 4.5 8-4.5" />
          <path d="m4 16.5 8 4.5 8-4.5" />
        </svg>
      </button>

      {isOpen && (
        <div className="map-layers-menu" role="menu" aria-label={label}>
          <div className="map-layers-mobile-header">
            <strong>{t('map.layers.mobileTitle')}</strong>
            <button
              type="button"
              className="map-layers-mobile-close"
              role="menuitem"
              aria-label={t('map.layers.close')}
              title={t('map.layers.close')}
              onClick={closeMenu}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </div>

          <section
            className="map-layers-section map-layers-section--base-maps"
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

            {overlayOptions.map((option) => {
              const optionLabel = t(option.labelKey);

              return (
                <OverlayLayerControl
                  key={option.layer}
                  option={option}
                  label={optionLabel}
                  opacity={layerOpacities[option.layer]}
                  opacityLabel={t('map.layers.opacity')}
                  opacitySettingsLabel={t(
                    'map.layers.adjustOpacity',
                    { layer: optionLabel },
                  )}
                  isOpacityOpen={expandedOpacityLayer === option.layer}
                  onToggleOpacity={() =>
                    setExpandedOpacityLayer((currentLayer) =>
                      currentLayer === option.layer ? null : option.layer,
                    )
                  }
                  onOpacityChange={(opacity) =>
                    onLayerOpacityChange(option.layer, opacity)
                  }
                />
              );
            })}
          </section>
        </div>
      )}
    </div>
  );
}
