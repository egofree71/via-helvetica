/**
 * Business context: protects the compact desktop position panel so WGS 84 and
 * LV95 remain unambiguous, copy actions use exactly the displayed coordinates,
 * and point-height failure never hides the local coordinate values.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18nContext';
import type { MapPositionInspection } from '../map/useMapPositionInspection';
import MapPositionPanel, {
  formatLv95MapPosition,
  formatWgs84MapPosition,
} from './MapPositionPanel';

const readyInspection: MapPositionInspection = {
  coordinate: [2_671_362.4, 1_204_798.7],
  wgs84Coordinate: [8.377, 46.99],
  elevationStatus: 'ready',
  elevationMeters: 731.4,
};

describe('MapPositionPanel', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let clipboardDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    window.localStorage.setItem('via-helvetica-language', 'fr');
    clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
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

    if (clipboardDescriptor) {
      Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
    } else {
      Reflect.deleteProperty(navigator, 'clipboard');
    }

    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('formats WGS 84 and LV95 in the intended user-facing order', () => {
    expect(formatWgs84MapPosition([8.377, 46.99])).toBe('46.99000, 8.37700');
    expect(formatLv95MapPosition([2_671_362.4, 1_204_798.7])).toBe(
      "2'671'362, 1'204'799",
    );
  });

  it('shows coordinates and elevation and copies each displayed coordinate', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const onClose = vi.fn();

    await act(async () => {
      root?.render(
        createElement(
          I18nProvider,
          null,
          createElement(MapPositionPanel, {
            inspection: readyInspection,
            onClose,
          }),
        ),
      );
    });

    expect(container.textContent).toContain('Position sur la carte');
    expect(container.textContent).toContain('46.99000, 8.37700');
    expect(container.textContent).toContain("2'671'362, 1'204'799");
    expect(container.textContent).toContain('731 m');

    const copyButtons = container.querySelectorAll<HTMLButtonElement>(
      '.map-position-copy',
    );
    expect(copyButtons).toHaveLength(2);

    await act(async () => copyButtons[0].click());
    await act(async () => copyButtons[1].click());

    expect(writeText).toHaveBeenNthCalledWith(1, '46.99000, 8.37700');
    expect(writeText).toHaveBeenNthCalledWith(2, "2'671'362, 1'204'799");

    container.querySelector<HTMLButtonElement>(
      '.map-information-choice-close',
    )?.click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps coordinates visible when elevation is unavailable', async () => {
    await act(async () => {
      root?.render(
        createElement(
          I18nProvider,
          null,
          createElement(MapPositionPanel, {
            inspection: {
              ...readyInspection,
              elevationStatus: 'error',
              elevationMeters: null,
            },
            onClose: vi.fn(),
          }),
        ),
      );
    });

    expect(container.textContent).toContain('46.99000, 8.37700');
    expect(container.textContent).toContain('Altitude indisponible');
  });
});
