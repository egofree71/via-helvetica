/**
 * Business context: protects the compact search combobox against interaction
 * regressions in keyboard navigation, local coordinate handling, and visible
 * active-option tracking without requiring a browser-level map test.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18nContext';
import {
  clearLocationSearchCache,
  searchLocations,
} from '../search/locationSearch';
import LocationSearch from './LocationSearch';

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;

  valueSetter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('LocationSearch keyboard navigation', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  const scrollIntoView = vi.fn();

  beforeEach(() => {
    clearLocationSearchCache();
    window.localStorage.setItem('via-helvetica-language', 'en');
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
      writable: true,
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
    clearLocationSearchCache();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('supports Home and End and keeps the active option visible', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        results: [
          {
            id: '1',
            attrs: {
              label: 'Bern',
              lat: 46.948,
              lon: 7.4474,
              origin: 'gazetteer',
            },
          },
          {
            id: '2',
            attrs: {
              label: 'Bern Bahnhof',
              lat: 46.949,
              lon: 7.439,
              origin: 'gazetteer',
            },
          },
          {
            id: '3',
            attrs: {
              label: 'Bern Altstadt',
              lat: 46.9485,
              lon: 7.452,
              origin: 'gazetteer',
            },
          },
        ],
      }),
    );

    vi.stubGlobal('fetch', fetchMock);
    await searchLocations(
      'bern',
      'en',
      new AbortController().signal,
    );

    await act(async () => {
      root?.render(
        createElement(
          I18nProvider,
          null,
          createElement(LocationSearch, {
            onSearchFocus: vi.fn(),
            onSelect: vi.fn(),
          }),
        ),
      );
    });

    const input = container.querySelector<HTMLInputElement>('input');
    expect(input).not.toBeNull();

    await act(async () => {
      setInputValue(input!, 'bern');
    });

    const options = Array.from(
      container.querySelectorAll<HTMLElement>('[role="option"]'),
    );
    expect(options).toHaveLength(3);

    await act(async () => {
      input!.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'End',
          bubbles: true,
        }),
      );
    });

    expect(options[2].getAttribute('aria-selected')).toBe('true');

    await act(async () => {
      input!.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Home',
          bubbles: true,
        }),
      );
    });

    expect(options[0].getAttribute('aria-selected')).toBe('true');
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  });
});

describe('LocationSearch coordinate entry', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    clearLocationSearchCache();
    window.localStorage.setItem('via-helvetica-language', 'en');
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
      writable: true,
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
    clearLocationSearchCache();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows a local coordinate result and selects it with Enter without fetching', async () => {
    const fetchMock = vi.fn();
    const onSelect = vi.fn();

    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root?.render(
        createElement(
          I18nProvider,
          null,
          createElement(LocationSearch, {
            onSearchFocus: vi.fn(),
            onSelect,
          }),
        ),
      );
    });

    const input = container.querySelector<HTMLInputElement>('input');
    expect(input).not.toBeNull();
    expect(input?.placeholder).toBe('Place or coordinates…');

    await act(async () => {
      setInputValue(input!, "2'671'804, 1'204'459");
    });

    const option = container.querySelector<HTMLElement>('[role="option"]');
    expect(option?.textContent).toContain("2'671'804, 1'204'459");
    expect(option?.textContent).toContain('LV95 coordinates');
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      input!.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
        }),
      );
    });

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toMatchObject({
      origin: 'lv95',
      label: "2'671'804, 1'204'459",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('explains when a valid coordinate is outside the map', async () => {
    vi.stubGlobal('fetch', vi.fn());

    await act(async () => {
      root?.render(
        createElement(
          I18nProvider,
          null,
          createElement(LocationSearch, {
            onSearchFocus: vi.fn(),
            onSelect: vi.fn(),
          }),
        ),
      );
    });

    const input = container.querySelector<HTMLInputElement>('input');

    await act(async () => {
      setInputValue(input!, '48.8566, 2.3522');
    });

    expect(container.textContent).toContain(
      'These coordinates are outside the area covered by the map.',
    );
  });
});
