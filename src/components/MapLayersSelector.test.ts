/**
 * Business context: protects the shared layer menu that lets hikers tune each
 * optional information overlay without losing the existing visibility controls.
 */
import { act, createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18nContext';
import type { MapLayerOpacities } from '../map/useMapLayerOpacities';
import MapLayersSelector from './MapLayersSelector';

const layerOpacities: MapLayerOpacities = {
  hikingTrails: 0.8,
  switzerlandMobilityHiking: 0.6,
  trailClosures: 0.8,
  shootingDangerZones: 0.6,
  publicTransportStops: 1,
};

const defaultProps: ComponentProps<typeof MapLayersSelector> = {
  baseMapStyle: 'color',
  onBaseMapChange: vi.fn(),
  areHikingTrailsVisible: true,
  onHikingTrailsChange: vi.fn(),
  isSwitzerlandMobilityHikingVisible: false,
  onSwitzerlandMobilityHikingChange: vi.fn(),
  areTrailClosuresVisible: true,
  onTrailClosuresChange: vi.fn(),
  areShootingDangerZonesVisible: true,
  onShootingDangerZonesChange: vi.fn(),
  arePublicTransportStopsVisible: false,
  onPublicTransportStopsChange: vi.fn(),
  layerOpacities,
  onLayerOpacityChange: vi.fn(),
};

/** Builds the translated selector while preserving component state on rerender. */
function createSelectorElement(
  overrides: Partial<ComponentProps<typeof MapLayersSelector>> = {},
) {
  return createElement(
    I18nProvider,
    null,
    createElement(MapLayersSelector, {
      ...defaultProps,
      ...overrides,
    }),
  );
}

describe('MapLayersSelector', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    window.localStorage.setItem('via-helvetica-language', 'fr');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }

    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('offers one bounded opacity control for every information layer', async () => {
    const onLayerOpacityChange = vi.fn();

    await act(async () => {
      root?.render(createSelectorElement({ onLayerOpacityChange }));
    });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '.map-control-button--map-layers',
        )
        ?.click();
    });

    const opacityButtons = container.querySelectorAll<HTMLButtonElement>(
      '.map-layer-opacity-button',
    );

    expect(opacityButtons).toHaveLength(5);
    expect(opacityButtons[0]?.getAttribute('aria-label')).toBe(
      'Régler l’opacité de la couche « Chemins de randonnée »',
    );
    expect(opacityButtons[0]?.hasAttribute('aria-controls')).toBe(false);
    expect(Array.from(opacityButtons, (button) => button.disabled)).toEqual([
      false,
      true,
      false,
      false,
      true,
    ]);

    await act(async () => {
      opacityButtons[1]?.click();
    });

    expect(
      container.querySelector('#map-layer-opacity-switzerlandMobilityHiking'),
    ).toBeNull();

    await act(async () => {
      opacityButtons[0]?.click();
    });

    const slider = container.querySelector<HTMLInputElement>(
      '#map-layer-opacity-hikingTrails',
    );
    const visibleValue = container.querySelector<HTMLElement>(
      '.map-layer-opacity-value',
    );

    expect(opacityButtons[0]?.getAttribute('aria-controls')).toBe(
      'map-layer-opacity-hikingTrails-settings',
    );
    expect(slider?.min).toBe('20');
    expect(slider?.value).toBe('80');
    expect(slider?.hasAttribute('aria-label')).toBe(false);
    expect(slider?.getAttribute('aria-labelledby')).toBe(
      'map-layer-opacity-hikingTrails-layer-label map-layer-opacity-hikingTrails-label',
    );
    expect(visibleValue?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('output')).toBeNull();
    expect(container.textContent).toContain('Opacité');
    expect(container.textContent).toContain('80 %');

    await act(async () => {
      if (slider) {
        const setNativeValue = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )?.set;

        setNativeValue?.call(slider, '35');
        slider.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });

    expect(onLayerOpacityChange).toHaveBeenCalledWith(
      'hikingTrails',
      0.35,
    );
  });

  it('offers a close action for the mobile layer sheet', async () => {
    await act(async () => {
      root?.render(createSelectorElement());
    });

    const layersButton = container.querySelector<HTMLButtonElement>(
      '.map-control-button--map-layers',
    );

    await act(async () => {
      layersButton?.click();
    });

    expect(container.textContent).toContain('Carte et options');
    expect(
      container.querySelector('.map-layers-section--base-maps'),
    ).not.toBeNull();

    const closeButton = container.querySelector<HTMLButtonElement>(
      '.map-layers-mobile-close',
    );

    expect(closeButton?.getAttribute('aria-label')).toBe(
      'Fermer le panneau Carte et options',
    );

    await act(async () => {
      closeButton?.click();
    });

    expect(container.querySelector('.map-layers-menu')).toBeNull();
    expect(layersButton?.getAttribute('aria-expanded')).toBe('false');
  });

  it('offers language choices inside the mobile map options sheet', async () => {
    await act(async () => {
      root?.render(createSelectorElement());
    });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '.map-control-button--map-layers',
        )
        ?.click();
    });

    const languageOptions = container.querySelectorAll<HTMLButtonElement>(
      '.map-layers-language-option',
    );

    expect(languageOptions).toHaveLength(4);
    expect(Array.from(languageOptions, (option) => option.textContent)).toEqual([
      'FR',
      'DE',
      'IT',
      'EN',
    ]);
    expect(languageOptions[0]?.getAttribute('aria-checked')).toBe('true');

    await act(async () => {
      languageOptions[1]?.click();
    });

    expect(container.textContent).toContain('Karte und Optionen');
    expect(
      container.querySelector<HTMLButtonElement>(
        '.map-layers-language-option[aria-label="Deutsch"]',
      )?.getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('does not reopen opacity settings after their layer is hidden', async () => {
    await act(async () => {
      root?.render(createSelectorElement());
    });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '.map-control-button--map-layers',
        )
        ?.click();
    });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '.map-layer-opacity-button',
        )
        ?.click();
    });

    expect(
      container.querySelector('#map-layer-opacity-hikingTrails-settings'),
    ).not.toBeNull();

    await act(async () => {
      root?.render(
        createSelectorElement({ areHikingTrailsVisible: false }),
      );
    });

    expect(
      container.querySelector('#map-layer-opacity-hikingTrails-settings'),
    ).toBeNull();

    await act(async () => {
      root?.render(
        createSelectorElement({ areHikingTrailsVisible: true }),
      );
    });

    expect(
      container.querySelector('#map-layer-opacity-hikingTrails-settings'),
    ).toBeNull();
  });
});
