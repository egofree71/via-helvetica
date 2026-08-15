/**
 * Business context: protects the responsive route-summary states that keep the
 * compact metrics, optional elevation profile, and imported-GPX edit action
 * coordinated without encoding viewport-specific layout decisions in React.
 */
import { act, createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18nContext';
import RouteStatistics from './RouteStatistics';

const defaultProps: ComponentProps<typeof RouteStatistics> = {
  distanceMeters: 2_000,
  elevationStatus: 'ready',
  ascentMeters: 120,
  descentMeters: 80,
  durationMinutes: 55,
  elevationPoints: [
    { distanceMeters: 0, elevationMeters: 500 },
    { distanceMeters: 2_000, elevationMeters: 620 },
  ],
};

/** Renders the translated statistics component with optional prop overrides. */
function createStatisticsElement(
  overrides: Partial<ComponentProps<typeof RouteStatistics>> = {},
) {
  return createElement(
    I18nProvider,
    null,
    createElement(RouteStatistics, { ...defaultProps, ...overrides }),
  );
}

describe('RouteStatistics', () => {
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

  it('toggles the profile and keeps the contextual edit action available', async () => {
    const editAction = { label: 'Modifier', onClick: vi.fn() };

    await act(async () => {
      root?.render(createStatisticsElement({ editAction }));
    });

    const profileToggle = container.querySelector<HTMLButtonElement>(
      '.route-profile-toggle',
    );
    const editButton = container.querySelector<HTMLButtonElement>(
      '.route-summary-edit-button',
    );

    expect(profileToggle?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.route-elevation-profile')).toBeNull();
    expect(editButton?.getAttribute('aria-label')).toBe('Modifier');

    await act(async () => {
      profileToggle?.click();
    });

    expect(profileToggle?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.route-elevation-profile')).not.toBeNull();

    await act(async () => {
      editButton?.click();
    });

    expect(editAction.onClick).toHaveBeenCalledTimes(1);
  });
});
