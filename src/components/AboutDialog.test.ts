/**
 * Business context: protects the About dialog's single explicit dismissal and
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

  it('focuses the title and exposes one explicit close button', async () => {
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
    expect(container.querySelector('.about-dialog-icon-close')).toBeNull();
    expect(container.querySelectorAll('.about-dialog button')).toHaveLength(1);
    expect(container.textContent).toContain('1.3.0');
    expect(container.textContent).toContain(
      'le fichier GPX est hébergé pendant 24 heures, sans être associé à votre identité',
    );

    const closeButton = container.querySelector<HTMLButtonElement>(
      '.about-dialog-close',
    );

    expect(closeButton?.textContent).toBe('Fermer');

    await act(async () => {
      closeButton?.click();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
