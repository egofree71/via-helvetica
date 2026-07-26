/**
 * Business context: protects the compact public-route panel that connects one
 * highlighted SwitzerlandMobility stage to its identity, Via Helvetica planning
 * figures, and optional elevation profile. It must remain understandable in
 * French and let the user resolve routes that share the same mapped path.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18nContext';
import SwitzerlandMobilityHikingPanel from './SwitzerlandMobilityHikingPanel';

const readyStatus = {
  state: 'ready' as const,
  route: {
    featureId: 4016,
    routeNumber: '4',
    routeId: '4.16',
    routeName: 'ViaJacobi',
    sectionName: 'Moudon - Lausanne',
    stageNumber: '16',
    hasStages: true,
    segments: [
      [
        [2_553_000, 1_171_000],
        [2_554_000, 1_170_500],
      ],
    ],
  },
  distanceMeters: 30_000,
  elevationStatus: 'ready' as const,
  elevation: {
    ascentMeters: 760,
    descentMeters: 740,
    points: [
      { distanceMeters: 0, elevationMeters: 500 },
      { distanceMeters: 30_000, elevationMeters: 800 },
    ],
  },
  durationMinutes: 470,
};

describe('SwitzerlandMobilityHikingPanel', () => {
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

  it('shows route identity and calculated planning figures', async () => {
    await act(async () => {
      root?.render(
        createElement(
          I18nProvider,
          null,
          createElement(SwitzerlandMobilityHikingPanel, {
            status: readyStatus,
            onSelectCandidate: vi.fn(),
            onProfileHoverDistanceChange: vi.fn(),
            routeHoverDistanceMeters: null,
            onExport: vi.fn(),
            onClose: vi.fn(),
          }),
        ),
      );
    });

    expect(container.textContent).toContain('ViaJacobi');
    expect(container.textContent).toContain(
      'Étape 16 : Moudon - Lausanne',
    );
    expect(container.textContent).toContain('30 km');
    expect(container.textContent).toContain('760 m');
    expect(container.textContent).toContain('740 m');
    expect(container.textContent).toContain('≈ 7 h 50');
    expect(
      container.querySelectorAll(
        '.switzerland-mobility-hiking-metric-values .route-statistics-item',
      ),
    ).toHaveLength(4);
    expect(container.textContent).toContain('Distance');
    expect(container.textContent).toContain('Montée');
    expect(container.textContent).toContain('Descente');
    expect(container.textContent).toContain('Durée');
  });

  it('opens the existing elevation profile and reflects map hover distance', async () => {
    const onProfileHoverDistanceChange = vi.fn();

    await act(async () => {
      root?.render(
        createElement(
          I18nProvider,
          null,
          createElement(SwitzerlandMobilityHikingPanel, {
            status: readyStatus,
            onSelectCandidate: vi.fn(),
            onProfileHoverDistanceChange,
            routeHoverDistanceMeters: 15_000,
            onExport: vi.fn(),
            onClose: vi.fn(),
          }),
        ),
      );
    });

    const toggle = container.querySelector<HTMLButtonElement>(
      '.switzerland-mobility-hiking-profile-toggle',
    );

    expect(toggle).not.toBeNull();
    expect(toggle?.disabled).toBe(false);

    await act(async () => {
      toggle?.click();
    });

    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(
      container.querySelector('.route-elevation-profile'),
    ).not.toBeNull();
    expect(container.textContent).toContain('15 km');
    expect(container.textContent).toContain('650 m');

    await act(async () => {
      toggle?.click();
    });

    expect(onProfileHoverDistanceChange).toHaveBeenLastCalledWith(null);
  });

  it('lets the user choose a route before the map is framed', async () => {
    const candidate = {
      featureId: 4016,
      routeNumber: '4',
      routeId: '4.16',
      routeName: 'ViaJacobi',
      sectionName: 'Moudon - Lausanne',
      stageNumber: '16',
      hasStages: true,
    };
    const onSelectCandidate = vi.fn();

    await act(async () => {
      root?.render(
        createElement(
          I18nProvider,
          null,
          createElement(SwitzerlandMobilityHikingPanel, {
            status: { state: 'choices', candidates: [candidate] },
            onSelectCandidate,
            onProfileHoverDistanceChange: vi.fn(),
            routeHoverDistanceMeters: null,
            onExport: vi.fn(),
            onClose: vi.fn(),
          }),
        ),
      );
    });

    const choice = container.querySelector<HTMLButtonElement>(
      '.switzerland-mobility-hiking-route-choices button',
    );

    expect(choice).not.toBeNull();
    expect(
      container.querySelector(
        '.switzerland-mobility-hiking-panel--choices',
      ),
    ).not.toBeNull();
    expect(choice?.textContent).toContain('ViaJacobi');
    expect(choice?.textContent).toContain(
      'Étape 16 : Moudon - Lausanne',
    );

    await act(async () => {
      choice?.click();
    });

    expect(onSelectCandidate).toHaveBeenCalledWith(candidate);
  });

  it('exports the selected public route from the panel header', async () => {
    const onExport = vi.fn();

    await act(async () => {
      root?.render(
        createElement(
          I18nProvider,
          null,
          createElement(SwitzerlandMobilityHikingPanel, {
            status: readyStatus,
            onSelectCandidate: vi.fn(),
            onProfileHoverDistanceChange: vi.fn(),
            routeHoverDistanceMeters: null,
            onExport,
            onClose: vi.fn(),
          }),
        ),
      );
    });

    const exportButton = container.querySelector<HTMLButtonElement>(
      '.switzerland-mobility-hiking-panel-export',
    );

    expect(exportButton).not.toBeNull();
    expect(exportButton?.disabled).toBe(false);

    await act(async () => {
      exportButton?.click();
    });

    expect(onExport).toHaveBeenCalledTimes(1);
  });
});
