/**
 * Business context: protects the shared layer menu that lets hikers tune each
 * optional information overlay without losing the existing visibility controls.
 */
import { act, createElement } from 'react';
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

  it('offers one expandable opacity control for every information layer', async () => {
    const onLayerOpacityChange = vi.fn();

    await act(async () => {
      root?.render(
        createElement(
          I18nProvider,
          null,
          createElement(MapLayersSelector, {
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
            onLayerOpacityChange,
          }),
        ),
      );
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

    expect(slider?.value).toBe('80');
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
});
