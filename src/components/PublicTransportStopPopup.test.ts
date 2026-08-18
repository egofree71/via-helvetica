/**
 * Business context: protects the declutter overlap chooser so several official
 * stops represented by one rendered symbol remain individually selectable
 * before any departure-board request is started.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18nContext';
import { loadStationBoard } from '../transport/stationBoard';
import type { PublicTransportStop } from '../transport/publicTransportStops';
import PublicTransportStopPopup from './PublicTransportStopPopup';

vi.mock('../transport/stationBoard', () => ({
  loadStationBoard: vi.fn(),
}));

const stops: PublicTransportStop[] = [
  {
    id: 'a',
    stationId: 'station-a',
    name: 'Lausanne, gare',
    modes: ['train'],
    coordinate: [2_537_900, 1_152_300],
  },
  {
    id: 'b',
    stationId: 'station-b',
    name: 'Lausanne, gare sud',
    modes: ['bus'],
    coordinate: [2_537_980, 1_152_300],
  },
];

describe('PublicTransportStopPopup choices', () => {
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

  it('lists represented stops and waits for an explicit stop choice', async () => {
    const onSelectStop = vi.fn();

    await act(async () => {
      root?.render(
        createElement(
          I18nProvider,
          null,
          createElement(PublicTransportStopPopup, {
            status: { state: 'choices', stops },
            onSelectStop,
            onClose: vi.fn(),
          }),
        ),
      );
    });

    expect(container.textContent).toContain('Choisir un arrêt');
    expect(
      container.querySelector('.public-transport-stop-choice-summary'),
    ).not.toBeNull();
    expect(container.querySelector('.map-information-popup')).toBeNull();
    expect(container.textContent).toContain('Lausanne, gare');
    expect(container.textContent).toContain('Lausanne, gare sud');
    expect(loadStationBoard).not.toHaveBeenCalled();

    const buttons = container.querySelectorAll<HTMLButtonElement>(
      '.public-transport-stop-choice',
    );
    expect(buttons).toHaveLength(2);

    await act(async () => {
      buttons[1].click();
    });

    expect(onSelectStop).toHaveBeenCalledWith(stops[1]);
    expect(loadStationBoard).not.toHaveBeenCalled();
  });
});
