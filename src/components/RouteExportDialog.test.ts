/**
 * Interaction regression tests for the GPX export dialog. They protect the
 * initial whole-name selection so typing replaces the generated proposal.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18nContext';
import { SwisstopoShareError } from '../share/swisstopoShare';
import RouteExportDialog from './RouteExportDialog';

describe('RouteExportDialog', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let originalShowModal: PropertyDescriptor | undefined;
  let originalClose: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    window.localStorage.setItem('via-helvetica-language', 'en');

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
      await act(async () => {
        root?.unmount();
      });
    }
    container.remove();

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

  it('selects the complete generated name after React commits its value', async () => {
    const renderDialog = async (isOpen: boolean, defaultName: string) => {
      await act(async () => {
        root?.render(
          createElement(
            I18nProvider,
            null,
            createElement(RouteExportDialog, {
              isOpen,
              defaultName,
              canShareWithSwisstopo: false,
              onCancel: vi.fn(),
              onExportGpx: vi.fn(),
              onCreateSwisstopoShare: vi.fn(),
            }),
          ),
        );
      });
    };

    await renderDialog(false, 'Previous route');
    const generatedName = 'Via Helvetica route — 2026-07-19 22:00';
    await renderDialog(true, generatedName);

    const input = container.querySelector<HTMLInputElement>(
      '#route-export-name',
    );

    expect(input).not.toBeNull();
    expect(input?.value).toBe(generatedName);
    expect(document.activeElement).toBe(input);
    expect(input?.selectionStart).toBe(0);
    expect(input?.selectionEnd).toBe(generatedName.length);
  });

  it('presents two stacked peer actions and reveals a QR after an explicit desktop request', async () => {
    const onExportGpx = vi.fn();
    const onCreateSwisstopoShare = vi.fn().mockResolvedValue({
      gpxUrl:
        'https://share.example.org/gpx/12345678-1234-1234-1234-123456789abc.gpx',
      swisstopoUrl:
        'https://swisstopo.app/u/aHR0cHM6Ly9zaGFyZS5leGFtcGxlLm9yZy9ncHgvMTIzNDU2NzgtMTIzNC0xMjM0LTEyMzQtMTIzNDU2Nzg5YWJjLmdweA',
      expiresAt: '2026-08-09T12:00:00.000Z',
    });

    await act(async () => {
      root?.render(
        createElement(
          I18nProvider,
          null,
          createElement(RouteExportDialog, {
            isOpen: true,
            defaultName: 'Test route',
            canShareWithSwisstopo: true,
            onCancel: vi.fn(),
            onExportGpx,
            onCreateSwisstopoShare,
          }),
        ),
      );
    });

    const buttons = Array.from(container.querySelectorAll('button'));
    const closeButton = container.querySelector<HTMLButtonElement>(
      '.route-export-dialog-close',
    );
    const exportButton = buttons.find(
      (button) => button.textContent === 'Export the GPX file',
    );
    const shareButton = buttons.find(
      (button) =>
        button.textContent === 'Create a QR code to import into swisstopo',
    );

    expect(closeButton?.getAttribute('aria-label')).toBe('Close');
    expect(exportButton).toBeDefined();
    expect(shareButton).toBeDefined();
    expect(exportButton?.className).toBe('route-export-dialog-button');
    expect(shareButton?.className).toBe('route-export-dialog-button');
    expect(
      container.querySelector('.route-export-dialog-storage-note')?.textContent,
    ).toContain('hosted for 24 hours without being associated with your identity');

    await act(async () => {
      shareButton?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });

    expect(onCreateSwisstopoShare).toHaveBeenCalledWith('Test route');
    expect(container.querySelector('.route-export-dialog-qr')).not.toBeNull();
    expect(
      container.querySelector('.route-export-dialog-share-copy')?.textContent,
    ).not.toContain('hosted for 24 hours');
    const resultButtons = Array.from(container.querySelectorAll('button'));
    expect(
      resultButtons.some(
        (button) =>
          button.textContent === 'Create a QR code to import into swisstopo',
      ),
    ).toBe(false);
    expect(
      resultButtons.some((button) => button.textContent === 'Export the GPX file'),
    ).toBe(false);
  });

  it('keeps phone-width layouts on local GPX export without creating a swisstopo share', async () => {
    const matchMedia = vi.fn().mockReturnValue({
      matches: true,
      media: '',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });
    vi.stubGlobal('matchMedia', matchMedia);
    const onExportGpx = vi.fn();
    const onCreateSwisstopoShare = vi.fn();

    await act(async () => {
      root?.render(
        createElement(
          I18nProvider,
          null,
          createElement(RouteExportDialog, {
            isOpen: true,
            defaultName: 'Mobile route',
            canShareWithSwisstopo: true,
            onCancel: vi.fn(),
            onExportGpx,
            onCreateSwisstopoShare,
          }),
        ),
      );
    });

    expect(matchMedia).toHaveBeenCalledWith('(max-width: 700px)');

    const buttons = Array.from(container.querySelectorAll('button'));
    const exportButton = buttons.find(
      (button) => button.textContent === 'Export the GPX file',
    );

    expect(exportButton).toBeDefined();
    expect(
      buttons.some(
        (button) =>
          button.textContent === 'Create a QR code to import into swisstopo',
      ),
    ).toBe(false);
    expect(
      container.querySelector('.route-export-dialog-storage-note'),
    ).toBeNull();
    expect(container.querySelector('.route-export-dialog-share')).toBeNull();

    await act(async () => {
      container.querySelector('form')?.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });

    expect(onExportGpx).toHaveBeenCalledWith('Mobile route');
    expect(onCreateSwisstopoShare).not.toHaveBeenCalled();
  });

  it('shows a specific message when the GPX is too large to share', async () => {
    await act(async () => {
      root?.render(
        createElement(
          I18nProvider,
          null,
          createElement(RouteExportDialog, {
            isOpen: true,
            defaultName: 'Large route',
            canShareWithSwisstopo: true,
            onCancel: vi.fn(),
            onExportGpx: vi.fn(),
            onCreateSwisstopoShare: vi.fn().mockRejectedValue(
              new SwisstopoShareError('tooLarge', 'too large'),
            ),
          }),
        ),
      );
    });

    const shareButton = Array.from(container.querySelectorAll('button')).find(
      (button) =>
        button.textContent === 'Create a QR code to import into swisstopo',
    );

    await act(async () => {
      shareButton?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });

    expect(
      container.querySelector('.route-export-dialog-error')?.textContent,
    ).toContain('exceeds the 2 MB limit');
  });
});
