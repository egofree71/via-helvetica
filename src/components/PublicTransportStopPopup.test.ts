/**
 * Business context: protects the concrete public-transport detail panel after
 * the common map-information chooser has resolved one official stop.
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

const stop: PublicTransportStop = {
  id: 'a',
  stationId: 'station-a',
  name: 'Lausanne, gare',
  modes: ['train'],
  coordinate: [2_537_900, 1_152_300],
};

describe('PublicTransportStopPopup', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    window.localStorage.setItem('via-helvetica-language', 'fr');
    vi.mocked(loadStationBoard).mockResolvedValue({
      departures: [],
      modes: ['train'],
    });
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

  it('loads departures only after one concrete stop detail panel is mounted', async () => {
    await act(async () => {
      root?.render(
        createElement(
          I18nProvider,
          null,
          createElement(PublicTransportStopPopup, {
            status: { state: 'stop', stop },
            onClose: vi.fn(),
          }),
        ),
      );
      await Promise.resolve();
    });

    expect(container.querySelector('.map-information-popup')).not.toBeNull();
    expect(container.textContent).toContain('Lausanne, gare');
    expect(loadStationBoard).toHaveBeenCalledTimes(1);
    expect(loadStationBoard).toHaveBeenCalledWith(
      'station-a',
      expect.any(AbortSignal),
    );
  });
});
