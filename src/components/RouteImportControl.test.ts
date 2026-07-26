/**
 * Business context: protects the compact GPX import entry point. Opening the
 * native picker must first release any temporary map-information selection so a
 * cancelled file dialog does not leave two competing workflows on the map.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18nContext';
import RouteImportControl from './RouteImportControl';

describe('RouteImportControl', () => {
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

  it('clears temporary map information before opening the file picker', async () => {
    const callOrder: string[] = [];
    const inputClick = vi
      .spyOn(HTMLInputElement.prototype, 'click')
      .mockImplementation(() => {
        callOrder.push('picker');
      });

    await act(async () => {
      root?.render(
        createElement(
          I18nProvider,
          null,
          createElement(RouteImportControl, {
            onOpen: () => {
              callOrder.push('clear');
            },
            onSelectFile: vi.fn(),
          }),
        ),
      );
    });

    const button = container.querySelector<HTMLButtonElement>('button');

    expect(button).not.toBeNull();

    await act(async () => {
      button?.click();
    });

    expect(inputClick).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['clear', 'picker']);
  });
});
