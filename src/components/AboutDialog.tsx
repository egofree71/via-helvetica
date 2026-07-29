/**
 * Business context: presents project identity, planning limitations, contact
 * details, and complete data credits without occupying permanent map space.
 * The visible About control keeps those credits directly accessible from the
 * map in one localized information surface.
 */
import { useLayoutEffect, useRef } from 'react';
import { useI18n } from '../i18n/I18nContext';
import {
  CURRENT_RELEASE_VERSION,
  releaseHistoryPath,
} from '../releases/releaseHistory';

/** Controlled visibility and close callback for the application information dialog. */
interface AboutDialogProps {
  /** Whether the modal information dialog should be displayed. */
  isOpen: boolean;
  /** Closes the dialog and returns focus to the information button. */
  onClose: () => void;
}

/** Public project links kept together so visible labels remain fully localized. */
const PROJECT_LINKS = {
  email: 'mailto:contact@viahelvetica.ch',
  source: 'https://github.com/egofree71/via-helvetica',
  license: 'https://github.com/egofree71/via-helvetica/blob/main/LICENSE',
  // Replace this placeholder with the creator's final public profile before release.
  linkedin: 'https://www.linkedin.com/in/philippe-de-pol/',
  swisstopo: 'https://www.swisstopo.admin.ch/',
  bav: 'https://www.bav.admin.ch/',
  transportOpenData: 'https://transport.opendata.ch/',
} as const;

/** Renders the localized About dialog above the otherwise map-centred interface. */
export default function AboutDialog({
  isOpen,
  onClose,
}: AboutDialogProps) {
  const { language, t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;

    if (!dialog) {
      return;
    }

    if (isOpen) {
      if (!dialog.open) {
        dialog.showModal();
      }

      // The native dialog otherwise focuses the first link in the content.
      // Starting on the heading announces the dialog context and avoids making
      // an unrelated project link look preselected when the panel opens.
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
      className="about-dialog"
      aria-labelledby="about-dialog-title"
      aria-describedby="about-dialog-description"
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
      <article className="about-dialog-panel">
        <header className="about-dialog-header">
          <h2
            ref={titleRef}
            id="about-dialog-title"
            tabIndex={-1}
          >
            {t('about.title')}
          </h2>
          <p className="about-dialog-tagline">{t('about.tagline')}</p>
        </header>

        <div className="about-dialog-content">
          <section className="about-dialog-section">
            <p id="about-dialog-description">{t('about.description')}</p>
            <p>{t('about.privacy')}</p>
          </section>

          <section className="about-dialog-notice">
            <h3>{t('about.safetyTitle')}</h3>
            <p>{t('about.safety')}</p>
          </section>

          <section className="about-dialog-section">
            <h3>{t('about.projectTitle')}</h3>
            <dl className="about-dialog-details">
              <div>
                <dt>{t('about.createdBy')}</dt>
                <dd>Philippe De Pol</dd>
              </div>
              <div>
                <dt>{t('about.support')}</dt>
                <dd>
                  <a href={PROJECT_LINKS.email}>contact@viahelvetica.ch</a>
                </dd>
              </div>
              <div>
                <dt>{t('about.sourceCode')}</dt>
                <dd>
                  <a
                    href={PROJECT_LINKS.source}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    GitHub
                  </a>
                </dd>
              </div>
              <div>
                <dt>{t('about.license')}</dt>
                <dd>
                  <a
                    href={PROJECT_LINKS.license}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    MIT
                  </a>
                </dd>
              </div>
              <div>
                <dt>{t('about.linkedin')}</dt>
                <dd>
                  <a
                    href={PROJECT_LINKS.linkedin}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    LinkedIn
                  </a>
                </dd>
              </div>
              <div>
                <dt>{t('about.currentVersion')}</dt>
                <dd>{CURRENT_RELEASE_VERSION}</dd>
              </div>
              <div>
                <dt>{t('about.releaseHistory')}</dt>
                <dd>
                  <a
                    href={releaseHistoryPath(language)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t('about.releaseHistoryAction')}
                  </a>
                </dd>
              </div>
            </dl>
          </section>

          <section className="about-dialog-section">
            <h3>{t('about.creditsTitle')}</h3>
            <dl className="about-dialog-credits">
              <div>
                <dt>{t('about.maps')}</dt>
                <dd>
                  <a
                    href={PROJECT_LINKS.swisstopo}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    © swisstopo
                  </a>
                </dd>
              </div>
              <div>
                <dt>{t('about.switzerlandMobilityHiking')}</dt>
                <dd>© ASTRA, SchweizMobil, Schweizer Wanderwege, Kantone</dd>
              </div>
              <div>
                <dt>{t('about.closures')}</dt>
                <dd>© ASTRA, Kantone, Schweizer Wanderwege, SchweizMobil</dd>
              </div>
              <div>
                <dt>{t('about.dangerZones')}</dt>
                <dd>© Schweizer Armee</dd>
              </div>
              <div>
                <dt>{t('about.transportStops')}</dt>
                <dd>
                  <a
                    href={PROJECT_LINKS.bav}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    © BAV
                  </a>
                </dd>
              </div>
              <div>
                <dt>{t('about.departures')}</dt>
                <dd>
                  <a
                    href={PROJECT_LINKS.transportOpenData}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    transport.opendata.ch
                  </a>
                </dd>
              </div>
            </dl>
          </section>
        </div>

        <footer className="about-dialog-footer">
          <button
            type="button"
            className="about-dialog-close"
            onClick={onClose}
          >
            {t('about.close')}
          </button>
        </footer>
      </article>
    </dialog>
  );
}
