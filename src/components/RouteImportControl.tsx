/**
 * Business context: exposes local GPX loading through one compact map button.
 * The native file picker remains hidden so importing a reference route does not
 * add a permanent panel or interfere with route creation.
 */
import { useRef } from 'react';
import { useI18n } from '../i18n/I18nContext';

/** Callbacks supplied by the root application for the GPX import workflow. */
interface RouteImportControlProps {
  /** Clears any temporary map selection before the native picker opens. */
  onOpen?: () => void;
  /** Reads, validates, displays, and frames the selected GPX file. */
  onSelectFile: (file: File) => void | Promise<void>;
}

/** Opens the browser file picker for one GPX itinerary. */
export default function RouteImportControl({
  onOpen,
  onSelectFile,
}: RouteImportControlProps) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const label = t('route.import');

  const openFilePicker = () => {
    const input = inputRef.current;

    if (!input) {
      return;
    }

    // The imported route becomes the next temporary map workflow even when
    // the user eventually cancels the native picker. Clear any public feature
    // selection before the browser dialog temporarily hides the map context.
    onOpen?.();

    // Resetting permits selecting the same GPX again after it was edited.
    input.value = '';
    input.click();
  };

  return (
    <div className="route-import-control">
      <button
        type="button"
        className="map-control-button map-control-button--route-import"
        aria-label={label}
        title={label}
        onClick={openFilePicker}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M12 15.5V4.5" />
          <path d="m7.5 9 4.5-4.5L16.5 9" />
          <path d="M5 18.5V20h14v-1.5" />
        </svg>
      </button>

      <input
        ref={inputRef}
        className="visually-hidden"
        type="file"
        accept=".gpx"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];

          if (file) {
            void onSelectFile(file);
          }
        }}
      />
    </div>
  );
}
