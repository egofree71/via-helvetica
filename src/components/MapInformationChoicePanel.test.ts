/**
 * Business context: protects the common map-information chooser so one click
 * can expose safety, public transport, and SwitzerlandMobility candidates in
 * the intended product order before any detailed workflow is started.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import dangerIconUrl from '../assets/map-information/other-dangers.svg';
import hikingIconUrl from '../assets/map-information/hiking.svg';
import pedestriansProhibitedIconUrl from '../assets/map-information/pedestrians-prohibited.svg';
import { I18nProvider } from '../i18n/I18nContext';
import type { MapInformationChoice } from '../map/mapInformationChoice';
import {
  PUBLIC_TRANSPORT_MODE_ICON_URLS,
} from '../transport/publicTransportModePresentation';
import MapInformationChoicePanel from './MapInformationChoicePanel';

const anchorCoordinate: [number, number] = [2_537_900, 1_152_300];
const identifyContext = {
  coordinate: anchorCoordinate,
  mapExtent: [2_530_000, 1_145_000, 2_545_000, 1_160_000] as [
    number,
    number,
    number,
    number,
  ],
  imageSize: [1_200, 800] as [number, number],
  language: 'fr' as const,
};

const choices: MapInformationChoice[] = [
  {
    kind: 'trailClosure',
    closure: { featureId: 'closure-1', context: identifyContext },
    anchorCoordinate,
  },
  {
    kind: 'shootingDangerZone',
    dangerZone: {
      featureId: 'danger-1',
      geometry: null,
      context: identifyContext,
    },
    anchorCoordinate,
  },
  {
    kind: 'publicTransportStop',
    stop: {
      id: 'stop-1',
      stationId: 'station-1',
      name: 'Lausanne, Bel-Air',
      modes: ['bus'],
      coordinate: anchorCoordinate,
    },
    anchorCoordinate,
  },
  {
    kind: 'switzerlandMobilityHiking',
    candidate: {
      featureId: 'route-1',
      routeNumber: '4',
      routeId: '4.16',
      routeName: 'ViaJacobi',
      sectionName: 'Moudon - Lausanne',
      stageNumber: '16',
      hasStages: true,
    },
    anchorCoordinate,
  },
];

describe('MapInformationChoicePanel', () => {
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

  it('groups safety first, transport second, and public routes last', async () => {
    const onSelectChoice = vi.fn();

    await act(async () => {
      root?.render(
        createElement(
          I18nProvider,
          null,
          createElement(MapInformationChoicePanel, {
            choices,
            onSelectChoice,
            onClose: vi.fn(),
          }),
        ),
      );
    });

    expect(
      container.querySelector('.map-information-choice-summary'),
    ).not.toBeNull();
    expect(container.querySelector('.map-information-popup')).toBeNull();

    const groupHeadings = Array.from(
      container.querySelectorAll<HTMLHeadingElement>(
        '.map-information-choice-group h2',
      ),
      (heading) => heading.textContent,
    );
    expect(groupHeadings).toEqual([
      'Randonnée et sécurité',
      'Arrêts de transports publics',
      'À pied SuisseMobile',
    ]);

    const buttons = container.querySelectorAll<HTMLButtonElement>(
      '.map-information-choice',
    );
    expect(buttons).toHaveLength(4);
    expect(buttons[0].textContent).toContain('Fermeture / déviation');
    expect(buttons[1].textContent).toContain(
      'Avis de tir / zone de danger',
    );
    expect(buttons[2].textContent).toContain('Lausanne, Bel-Air');
    expect(buttons[3].textContent).toContain('ViaJacobi');

    const iconModifiers = Array.from(
      container.querySelectorAll<HTMLElement>('.map-information-choice-icon'),
      (icon) =>
        Array.from(icon.classList).find((className) =>
          className.startsWith('map-information-choice-icon--'),
        ),
    );
    expect(iconModifiers).toEqual([
      'map-information-choice-icon--closure',
      'map-information-choice-icon--danger',
      'map-information-choice-icon--transport',
      'map-information-choice-icon--hiking',
    ]);
    const imageIcons = container.querySelectorAll<HTMLImageElement>(
      '.map-information-choice-icon img[aria-hidden="true"]',
    );
    expect(imageIcons).toHaveLength(4);
    expect(imageIcons[0].getAttribute('src')).toBe(
      pedestriansProhibitedIconUrl,
    );
    expect(imageIcons[1].getAttribute('src')).toBe(dangerIconUrl);
    expect(imageIcons[2].getAttribute('src')).toBe(
      PUBLIC_TRANSPORT_MODE_ICON_URLS.bus,
    );
    expect(imageIcons[3].getAttribute('src')).toBe(hikingIconUrl);

    await act(async () => {
      buttons[2].click();
    });

    expect(onSelectChoice).toHaveBeenCalledWith(choices[2]);
  });

  it('uses the same mode-specific pictograms as the public-transport layer', async () => {
    const transportChoices: MapInformationChoice[] = [
      choices[2],
      {
        kind: 'publicTransportStop',
        stop: {
          id: 'stop-boat',
          stationId: 'station-boat',
          name: 'Lausanne-Ouchy',
          modes: ['boat'],
          coordinate: anchorCoordinate,
        },
        anchorCoordinate,
      },
    ];

    await act(async () => {
      root?.render(
        createElement(
          I18nProvider,
          null,
          createElement(MapInformationChoicePanel, {
            choices: transportChoices,
            onSelectChoice: vi.fn(),
            onClose: vi.fn(),
          }),
        ),
      );
    });

    const transportIcons = container.querySelectorAll<HTMLImageElement>(
      '.map-information-choice-icon--transport img',
    );
    expect(transportIcons).toHaveLength(2);
    expect(transportIcons[0].getAttribute('src')).toBe(
      PUBLIC_TRANSPORT_MODE_ICON_URLS.bus,
    );
    expect(transportIcons[1].getAttribute('src')).toBe(
      PUBLIC_TRANSPORT_MODE_ICON_URLS.boat,
    );
  });

});
