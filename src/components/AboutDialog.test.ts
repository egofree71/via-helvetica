/**
 * Business context: protects the About dialog's consistent header dismissal and
 * ensures its initial focus announces the information panel instead of making
 * the first project link appear preselected.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18nContext';
import AboutDialog from './AboutDialog';

describe('AboutDialog', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let originalShowModal: PropertyDescriptor | undefined;
  let originalClose: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    window.localStorage.setItem('via-helvetica-language', 'fr');
    window.history.replaceState({}, '', '/fr/');

    originalShowModal = Object.getOwnPropertyDescriptor(
      HTMLDialogElement.prototype,
      'showModal',
    );
    originalClose = Object.getOwnPropertyDescriptor(
      HTMLDialogElement.prototype,
      'close',
    );

    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.setAttribute('open', '');
      },
    });
    Object.defineProperty(HTMLDialogElement.prototype, 'close', {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.removeAttribute('open');
      },
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
    }

    container.remove();
    window.localStorage.clear();
    window.history.replaceState({}, '', '/');

    if (originalShowModal) {
      Object.defineProperty(
        HTMLDialogElement.prototype,
        'showModal',
        originalShowModal,
      );
    } else {
      delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>)
        .showModal;
    }

    if (originalClose) {
      Object.defineProperty(
        HTMLDialogElement.prototype,
        'close',
        originalClose,
      );
    } else {
      delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).close;
    }

    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('focuses the title and exposes one header close button', async () => {
    const onClose = vi.fn();

    await act(async () => {
      root?.render(
        createElement(
          I18nProvider,
          null,
          createElement(AboutDialog, {
            isOpen: true,
            onClose,
          }),
        ),
      );
    });

    expect(document.activeElement).toBe(
      container.querySelector('#about-dialog-title'),
    );
    expect(container.querySelector('.about-dialog-footer')).toBeNull();
    expect(container.querySelectorAll('.about-dialog button')).toHaveLength(1);
    expect(container.textContent).toContain('1.7.2');
    expect(container.textContent).toContain(
      'Via Helvetica est conçue principalement pour préparer un itinéraire sur un grand écran',
    );
    expect(container.textContent).toContain(
      'Elle n’est pas destinée au suivi d’un itinéraire ni à la navigation en temps réel sur le terrain',
    );
    expect(container.textContent).toContain(
      'le fichier GPX est hébergé pendant 24 heures, sans être associé à votre identité',
    );

    const closeButton = container.querySelector<HTMLButtonElement>(
      '.about-dialog-icon-close',
    );

    expect(closeButton?.getAttribute('aria-label')).toBe('Fermer');
    expect(closeButton?.textContent).toBe('×');

    await act(async () => {
      closeButton?.click();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      language: 'fr',
      expected:
        'Via Helvetica est conçue principalement pour préparer un itinéraire sur un grand écran',
    },
    {
      language: 'de',
      expected:
        'Via Helvetica ist in erster Linie für die Planung einer Route auf einem grossen Bildschirm konzipiert',
    },
    {
      language: 'it',
      expected:
        'Via Helvetica è pensata principalmente per preparare un itinerario su uno schermo grande',
    },
    {
      language: 'en',
      expected:
        'Via Helvetica is designed primarily for planning a route on a large screen',
    },
  ])(
    'localizes the intended-use guidance in $language',
    async ({ language, expected }) => {
      window.localStorage.setItem('via-helvetica-language', language);
      window.history.replaceState({}, '', `/${language}/`);

      await act(async () => {
        root?.render(
          createElement(
            I18nProvider,
            null,
            createElement(AboutDialog, {
              isOpen: true,
              onClose: vi.fn(),
            }),
          ),
        );
      });

      expect(container.textContent).toContain(expected);
    },
  );

  it.each([
    {
      language: 'fr',
      expected: [
        'La Suisse à pied',
        '© OFROU, SuisseMobile, Suisse Rando, cantons',
        '© OFROU, cantons, Suisse Rando, SuisseMobile',
        '© Armée suisse',
        '© OFT',
      ],
    },
    {
      language: 'de',
      expected: [
        'Wanderland',
        '© ASTRA, SchweizMobil, Schweizer Wanderwege, Kantone',
        '© ASTRA, Kantone, Schweizer Wanderwege, SchweizMobil',
        '© Schweizer Armee',
        '© BAV',
      ],
    },
    {
      language: 'it',
      expected: [
        'La Svizzera a piedi',
        '© USTRA, SvizzeraMobile, Sentieri Svizzeri, cantoni',
        '© USTRA, cantoni, Sentieri Svizzeri, SvizzeraMobile',
        '© Esercito svizzero',
        '© UFT',
      ],
    },
    {
      language: 'en',
      expected: [
        'Hiking in Switzerland',
        '© FEDRO, SwitzerlandMobility, Swiss Hiking Trail Federation, cantons',
        '© FEDRO, cantons, Swiss Hiking Trail Federation, SwitzerlandMobility',
        '© Swiss Armed Forces',
        '© FOT',
      ],
    },
  ])(
    'localizes map and data credits in $language',
    async ({ language, expected }) => {
      window.localStorage.setItem('via-helvetica-language', language);
      window.history.replaceState({}, '', `/${language}/`);

      await act(async () => {
        root?.render(
          createElement(
            I18nProvider,
            null,
            createElement(AboutDialog, {
              isOpen: true,
              onClose: vi.fn(),
            }),
          ),
        );
      });

      for (const text of expected) {
        expect(container.textContent).toContain(text);
      }
    },
  );
});
