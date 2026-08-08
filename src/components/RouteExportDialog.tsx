/**
 * Business context: names the current itinerary once, then offers the two
 * transfer paths useful after planning: a normal local GPX download or a
 * temporary swisstopo hand-off (desktop QR, direct mobile link). The dialog
 * remains transient so these export details do not consume permanent map space.
 */
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { useI18n } from '../i18n/I18nContext';
import {
  createQrCodeMatrix,
  createQrCodeSvgPath,
} from '../share/qrCode';
import type { SwisstopoShare } from '../share/swisstopoShare';

/** Controlled visibility and callbacks for the route-export dialog. */
interface RouteExportDialogProps {
  /** Whether the modal export dialog should be displayed. */
  isOpen: boolean;
  /** Localized name proposed when the dialog opens. */
  defaultName: string;
  /** Whether the optional temporary swisstopo share service is configured. */
  canShareWithSwisstopo: boolean;
  /** Closes the dialog. */
  onCancel: () => void;
  /** Downloads the route with the trimmed name entered by the user. */
  onExportGpx: (routeName: string) => void;
  /** Uploads the named GPX temporarily and returns its swisstopo hand-off URL. */
  onCreateSwisstopoShare: (routeName: string) => Promise<SwisstopoShare>;
}

/** Maximum route-name length accepted by the export form. */
const ROUTE_NAME_MAX_LENGTH = 120;
/**
 * Mobile hand-off should avoid showing a QR code on the same device that must
 * scan it. Combining viewport size with a coarse pointer avoids treating most
 * touch-enabled laptops as phones or tablets.
 */
const MOBILE_SWISSTOPO_MEDIA_QUERY =
  '(max-width: 64rem) and (hover: none) and (pointer: coarse)';

/** Reads the current device characteristics without assuming `matchMedia` exists. */
function isMobileSwisstopoHandoff(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia(MOBILE_SWISSTOPO_MEDIA_QUERY).matches
  );
}

/** Renders an accessible modal for local GPX export and swisstopo transfer. */
export default function RouteExportDialog({
  isOpen,
  defaultName,
  canShareWithSwisstopo,
  onCancel,
  onExportGpx,
  onCreateSwisstopoShare,
}: RouteExportDialogProps) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const wasOpenRef = useRef(false);
  const openingNameRef = useRef(defaultName);
  const selectionPendingRef = useRef(false);
  const [routeName, setRouteName] = useState(defaultName);
  const [share, setShare] = useState<SwisstopoShare | null>(null);
  const [isSharePending, setIsSharePending] = useState(false);
  const [shareError, setShareError] = useState(false);
  const [useDirectSwisstopoHandoff, setUseDirectSwisstopoHandoff] = useState(
    isMobileSwisstopoHandoff,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') {
      return undefined;
    }

    const mediaQuery = window.matchMedia(MOBILE_SWISSTOPO_MEDIA_QUERY);
    const updateMode = () => setUseDirectSwisstopoHandoff(mediaQuery.matches);

    updateMode();
    mediaQuery.addEventListener('change', updateMode);

    return () => mediaQuery.removeEventListener('change', updateMode);
  }, []);

  useLayoutEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = isOpen;

    if (isOpen && !wasOpen) {
      openingNameRef.current = defaultName;
      selectionPendingRef.current = true;
      setRouteName(defaultName);
      setShare(null);
      setShareError(false);
      setIsSharePending(false);
    }
  }, [defaultName, isOpen]);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;

    if (!dialog) {
      return;
    }

    if (!isOpen) {
      selectionPendingRef.current = false;

      if (dialog.open) {
        dialog.close();
      }

      return;
    }

    // Wait for the controlled input to contain the new proposal. Selecting it
    // before React commits that value would move the caret back to the end.
    if (routeName !== openingNameRef.current) {
      return;
    }

    if (!dialog.open) {
      dialog.showModal();
    }

    if (!selectionPendingRef.current) {
      return;
    }

    const input = inputRef.current;

    if (!input) {
      return;
    }

    input.focus({ preventScroll: true });
    input.setSelectionRange(0, input.value.length);
    selectionPendingRef.current = false;
  }, [isOpen, routeName]);

  const trimmedRouteName = routeName.trim();
  const qrCode = useMemo(() => {
    if (!share) {
      return null;
    }

    const matrix = createQrCodeMatrix(share.swisstopoUrl);

    return {
      path: createQrCodeSvgPath(matrix),
      viewBoxSize: matrix.viewBoxSize,
    };
  }, [share]);

  /** Keeps Enter equivalent to the long-standing GPX download action. */
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (trimmedRouteName && !isSharePending) {
      onExportGpx(trimmedRouteName);
    }
  };

  /** Creates a fresh temporary transfer after validating the current name. */
  const createShare = async () => {
    if (!trimmedRouteName || isSharePending) {
      return;
    }

    setIsSharePending(true);
    setShare(null);
    setShareError(false);

    try {
      const nextShare = await onCreateSwisstopoShare(trimmedRouteName);
      setShare(nextShare);

      // A phone can use the universal swisstopo link directly; showing a QR on
      // the same screen would force the user to find a second device to scan it.
      if (useDirectSwisstopoHandoff) {
        window.location.assign(nextShare.swisstopoUrl);
      }
    } catch (error) {
      console.error('Unable to prepare the route for swisstopo.', error);
      setShareError(true);
    } finally {
      setIsSharePending(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="route-export-dialog"
      aria-labelledby="route-export-dialog-title"
      aria-describedby="route-export-dialog-hint"
      onCancel={(event) => {
        event.preventDefault();

        if (!isSharePending) {
          onCancel();
        }
      }}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !isSharePending) {
          onCancel();
        }
      }}
    >
      <form className="route-export-dialog-form" onSubmit={submit}>
        <div className="route-export-dialog-header">
          <h2 id="route-export-dialog-title">{t('route.export')}</h2>
          <button
            type="button"
            className="route-export-dialog-close"
            aria-label={t('gpx.close')}
            title={t('gpx.close')}
            disabled={isSharePending}
            onClick={onCancel}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>

        <label htmlFor="route-export-name">{t('gpx.nameLabel')}</label>
        <input
          ref={inputRef}
          id="route-export-name"
          type="text"
          value={routeName}
          maxLength={ROUTE_NAME_MAX_LENGTH}
          autoComplete="off"
          required
          disabled={isSharePending}
          onChange={(event) => {
            setRouteName(event.target.value);
            // A generated QR belongs to the exact named GPX that was uploaded.
            setShare(null);
            setShareError(false);
          }}
        />
        <p id="route-export-dialog-hint">{t('gpx.nameHint')}</p>

        {share && qrCode && !useDirectSwisstopoHandoff && (
          <section
            className="route-export-dialog-share"
            aria-labelledby="route-export-dialog-share-title"
          >
            <div className="route-export-dialog-share-copy">
              <strong id="route-export-dialog-share-title">
                {t('gpx.swisstopoReady')}
              </strong>
              <span>{t('gpx.swisstopoScanHint')}</span>
            </div>
            <svg
              className="route-export-dialog-qr"
              viewBox={`0 0 ${qrCode.viewBoxSize} ${qrCode.viewBoxSize}`}
              role="img"
              aria-label={t('gpx.swisstopoQrAria')}
              shapeRendering="crispEdges"
            >
              <rect width="100%" height="100%" fill="#ffffff" />
              <path d={qrCode.path} fill="#000000" />
            </svg>
          </section>
        )}

        {share && useDirectSwisstopoHandoff && (
          <a
            className="route-export-dialog-button route-export-dialog-mobile-fallback"
            href={share.swisstopoUrl}
          >
            {t('gpx.openSwisstopoApp')}
          </a>
        )}

        {shareError && (
          <p className="route-export-dialog-error" role="alert">
            {t('gpx.swisstopoError')}
          </p>
        )}

        {!share && (
          <div className="route-export-dialog-options">
            <button
              type="submit"
              className="route-export-dialog-button"
              disabled={!trimmedRouteName || isSharePending}
            >
              {t('gpx.download')}
            </button>

            {canShareWithSwisstopo && (
              <div className="route-export-dialog-swisstopo-option">
                <button
                  type="button"
                  className="route-export-dialog-button"
                  disabled={!trimmedRouteName || isSharePending}
                  onClick={() => void createShare()}
                >
                  {isSharePending
                    ? t('gpx.preparingSwisstopo')
                    : useDirectSwisstopoHandoff
                      ? t('gpx.openSwisstopoApp')
                      : t('gpx.createSwisstopoQr')}
                </button>
                <p className="route-export-dialog-storage-note">
                  {t('gpx.swisstopoStorageNotice')}
                </p>
              </div>
            )}
          </div>
        )}
      </form>
    </dialog>
  );
}
