/**
 * Business context: protects localized entry URLs and client-side language
 * changes so switching language never reloads the map or loses route state.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  I18nProvider,
  languageFromPathname,
  useI18n,
} from './I18nContext';

function LanguageProbe() {
  const { language, setLanguage } = useI18n();

  return createElement(
    'div',
    null,
    createElement('output', { 'data-language': true }, language),
    createElement(
      'button',
      { type: 'button', onClick: () => setLanguage('de') },
      'DE',
    ),
  );
}

describe('localized language URLs', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    window.localStorage.clear();
    window.history.replaceState({}, '', '/');
    document.head.innerHTML = `
      <meta name="description" content="" />
      <link rel="canonical" href="https://viahelvetica.ch/" />
      <meta property="og:locale" content="en_CH" />
      <meta property="og:locale:alternate" content="fr_CH" />
      <meta property="og:locale:alternate" content="de_CH" />
      <meta property="og:locale:alternate" content="it_CH" />
      <meta property="og:title" content="" />
      <meta property="og:description" content="" />
      <meta property="og:url" content="" />
      <meta property="og:image:alt" content="" />
      <meta name="twitter:title" content="" />
      <meta name="twitter:description" content="" />
      <meta name="twitter:image:alt" content="" />
      <script id="structured-data" type="application/ld+json">{}</script>
    `;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
    }

    container.remove();
    window.history.replaceState({}, '', '/');
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('recognizes only supported root language segments', () => {
    expect(languageFromPathname('/fr/')).toBe('fr');
    expect(languageFromPathname('/de/?map=1')).toBe('de');
    expect(languageFromPathname('/benchmarks/routing/')).toBeNull();
    expect(languageFromPathname('/')).toBeNull();
  });

  it('gives the localized path priority over a stored preference', async () => {
    window.localStorage.setItem('via-helvetica-language', 'en');
    window.history.replaceState({}, '', '/fr/');

    await act(async () => {
      root?.render(createElement(I18nProvider, null, createElement(LanguageProbe)));
    });

    expect(container.querySelector('output')?.textContent).toBe('fr');
    expect(document.documentElement.lang).toBe('fr');
    expect(document.title).toContain('Planificateur');
    expect(
      JSON.parse(
        document.querySelector<HTMLScriptElement>('#structured-data')
          ?.textContent ?? '{}',
      ).inLanguage,
    ).toBe('fr');
    expect(
      document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href,
    ).toBe('https://viahelvetica.ch/fr/');
  });

  it('changes the path without navigation and preserves query and hash', async () => {
    window.localStorage.setItem('via-helvetica-language', 'fr');
    window.history.replaceState({}, '', '/fr/?map=1#route');
    const pushState = vi.spyOn(window.history, 'pushState');

    await act(async () => {
      root?.render(createElement(I18nProvider, null, createElement(LanguageProbe)));
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button')?.click();
    });

    expect(pushState).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe('/de/');
    expect(window.location.search).toBe('?map=1');
    expect(window.location.hash).toBe('#route');
    expect(container.querySelector('output')?.textContent).toBe('de');
    expect(document.documentElement.lang).toBe('de');
  });

  it('normalizes the x-default root to the resolved localized path', async () => {
    window.localStorage.setItem('via-helvetica-language', 'fr');
    const replaceState = vi.spyOn(window.history, 'replaceState');

    await act(async () => {
      root?.render(createElement(I18nProvider, null, createElement(LanguageProbe)));
    });

    expect(window.location.pathname).toBe('/fr/');
    expect(container.querySelector('output')?.textContent).toBe('fr');
    expect(replaceState).toHaveBeenCalledWith(
      expect.objectContaining({ viaHelveticaLanguage: 'fr' }),
      '',
      '/fr/',
    );
    expect(
      document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href,
    ).toBe('https://viahelvetica.ch/fr/');
  });
});
