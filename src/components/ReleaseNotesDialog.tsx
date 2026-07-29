/**
 * Business context: announces the current Via Helvetica release once per
 * browser while keeping the map-centred interface free of permanent release
 * chrome. The complete history opens in a separate static page so an itinerary
 * in progress is never discarded.
 */
import { useLayoutEffect, useRef } from 'react';
import { useI18n } from '../i18n/I18nContext';
import {
  getCurrentReleaseDialogItems,
  getLocalizedReleaseHistory,
  releaseHistoryPath,
} from '../releases/releaseHistory';

/** Controlled visibility and acknowledgement callback for release highlights. */
interface ReleaseNotesDialogProps {
  /** Whether the current release announcement should be displayed. */
  isOpen: boolean;
  /** Acknowledges the current release and closes the dialog. */
  onClose: () => void;
}

/** Renders compact localized highlights for the current application release. */
export default function ReleaseNotesDialog({
  isOpen,
  onClose,
}: ReleaseNotesDialogProps) {
  const { language, t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const localizedHistory = getLocalizedReleaseHistory(language);
  const dialogItems = getCurrentReleaseDialogItems(language);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;

    if (!dialog) {
      return;
    }

    if (isOpen) {
      if (!dialog.open) {
        dialog.showModal();
      }

      // The native dialog otherwise focuses the first action, which makes the
      // history link look preselected. Focusing the heading gives assistive
      // technology the dialog context before users tab through its actions.
      titleRef.current?.focus({ preventScroll: true });
      return;
    }

    if (dialog.open) {
      dialog.close();
    }
  }, [isOpen]);

  return (
    <dialog
      ref={dialogRef}
      className="release-notes-dialog"
      aria-labelledby="release-notes-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <article className="release-notes-dialog-panel">
        <header className="release-notes-dialog-header">
          <h2
            ref={titleRef}
            id="release-notes-dialog-title"
            tabIndex={-1}
          >
            {localizedHistory.dialog.title}
          </h2>
        </header>

        <div className="release-notes-dialog-content">
          <ul className="release-notes-list">
            {dialogItems.map((item) => (
              <li key={item.id}>
                <strong>{item.title}</strong>{' '}
                <span>{item.description}</span>
              </li>
            ))}
          </ul>
        </div>

        <footer className="release-notes-dialog-footer">
          <a
            href={releaseHistoryPath(language)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={onClose}
          >
            <span>{localizedHistory.dialog.historyLink}</span>
            <svg
              className="release-notes-new-tab-icon"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path d="M14 5h5v5" />
              <path d="m19 5-8 8" />
              <path d="M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
            </svg>
            <span className="visually-hidden">
              ({localizedHistory.dialog.historyLinkNewTabLabel})
            </span>
          </a>

          <button
            type="button"
            className="release-notes-dialog-close"
            onClick={onClose}
          >
            {t('about.close')}
          </button>
        </footer>
      </article>
    </dialog>
  );
}
