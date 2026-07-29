/**
 * Business context: centralizes release announcements shared by the one-time
 * in-app dialog and the indexable static release-history pages. The browser
 * stores only the last acknowledged version, never route or account data.
 */
import releaseHistorySource from './releaseHistory.json';
import type { Language } from '../i18n/translations';

/** Local-storage key containing the most recently acknowledged release. */
const LAST_SEEN_RELEASE_STORAGE_KEY = 'via-helvetica-last-seen-release';
/**
 * Existing preference written by pre-1.1.0 builds and used to detect returning
 * visitors during the first release-announcement migration.
 */
const PREVIOUS_VISIT_STORAGE_KEY = 'via-helvetica-language';
/** Temporary key confirming that release acknowledgement can be persisted. */
const RELEASE_STORAGE_PROBE_KEY = 'via-helvetica-release-storage-probe';

/** One release highlight shown in the dialog and on the static history page. */
export interface ReleaseHistoryItem {
  /** Stable language-neutral identifier used to validate translations. */
  id: string;
  /** Short localized title including its final colon. */
  title: string;
  /** Compact localized explanation suitable for the mobile dialog. */
  description: string;
  /** Optional details shown only on the complete static history page. */
  details: string[];
  /** False when the item belongs only on the complete history page. */
  showInDialog?: boolean;
}

/** One localized application release. */
export interface LocalizedRelease {
  /** Public semantic version. */
  version: string;
  /** Short overview displayed before the release highlights. */
  summary: string;
  /** Localized highlights, in stable cross-language order. */
  items: ReleaseHistoryItem[];
}

/** Text used by the one-time in-app release dialog. */
interface ReleaseDialogContent {
  /** Localized dialog heading including the current version. */
  title: string;
  /** Localized link label for the complete release history. */
  historyLink: string;
  /** Accessible notice that the complete history opens in a new browser tab. */
  historyLinkNewTabLabel: string;
}

/** SEO and visible copy used by one static release-history page. */
interface ReleasePageContent {
  /** Localized document title. */
  title: string;
  /** Localized search-result description. */
  description: string;
  /** Visible page heading. */
  heading: string;
  /** Visible introduction above the release cards. */
  intro: string;
  /** Link label returning to the localized map application. */
  backToApp: string;
  /** Accessible label for the compact language navigation. */
  languageNavigation: string;
  /** Localized noun displayed before each semantic version. */
  versionLabel: string;
  /** Badge displayed beside the current release. */
  currentLabel: string;
}

/** Complete localized release-history content. */
export interface LocalizedReleaseHistory {
  /** One-time dialog copy. */
  dialog: ReleaseDialogContent;
  /** Static page metadata and headings. */
  page: ReleasePageContent;
  /** Releases ordered from newest to oldest. */
  releases: LocalizedRelease[];
}

/** Shared release-history data validated during static page generation. */
interface ReleaseHistoryData {
  /** Version announced by the current build. */
  currentVersion: string;
  /** Complete content in every supported interface language. */
  locales: Record<Language, LocalizedReleaseHistory>;
}

const RELEASE_HISTORY = releaseHistorySource as ReleaseHistoryData;

/** Version announced by the current application build. */
export const CURRENT_RELEASE_VERSION = RELEASE_HISTORY.currentVersion;

/** Returns all localized release content for the selected interface language. */
export function getLocalizedReleaseHistory(
  language: Language,
): LocalizedReleaseHistory {
  return RELEASE_HISTORY.locales[language];
}

/** Returns the current release or fails fast when release data drifted. */
export function getCurrentRelease(language: Language): LocalizedRelease {
  const release = getLocalizedReleaseHistory(language).releases.find(
    (candidate) => candidate.version === CURRENT_RELEASE_VERSION,
  );

  if (!release) {
    throw new Error(
      `Missing current release ${CURRENT_RELEASE_VERSION} for ${language}.`,
    );
  }

  return release;
}

/** Returns only the current highlights intended for the compact in-app dialog. */
export function getCurrentReleaseDialogItems(
  language: Language,
): ReleaseHistoryItem[] {
  return getCurrentRelease(language).items.filter(
    (item) => item.showInDialog !== false,
  );
}

/** Returns the localized static history path without leaving the current route. */
export function releaseHistoryPath(language: Language): string {
  return `/${language}/releases/`;
}

/** Minimal storage contract required by release-announcement persistence. */
type ReleaseStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * Confirms that an acknowledgement can be written before displaying a modal.
 * Failing silently is safer than showing an announcement that returns forever.
 */
function canPersistReleaseAcknowledgement(storage: ReleaseStorage): boolean {
  try {
    storage.setItem(RELEASE_STORAGE_PROBE_KEY, CURRENT_RELEASE_VERSION);
    const wasStored = storage.getItem(RELEASE_STORAGE_PROBE_KEY)
      === CURRENT_RELEASE_VERSION;
    storage.removeItem(RELEASE_STORAGE_PROBE_KEY);
    return wasStored;
  } catch {
    return false;
  }
}

/**
 * Tests whether a returning visitor still needs to acknowledge this release.
 * A first visit records the current version silently because there is no older
 * experience to compare, while unavailable storage disables the courtesy modal.
 */
export function shouldShowCurrentRelease(
  storage: ReleaseStorage = window.localStorage,
): boolean {
  try {
    const lastSeenRelease = storage.getItem(
      LAST_SEEN_RELEASE_STORAGE_KEY,
    );

    if (lastSeenRelease === CURRENT_RELEASE_VERSION) {
      return false;
    }

    if (
      lastSeenRelease === null
      && storage.getItem(PREVIOUS_VISIT_STORAGE_KEY) === null
    ) {
      storage.setItem(
        LAST_SEEN_RELEASE_STORAGE_KEY,
        CURRENT_RELEASE_VERSION,
      );
      return false;
    }

    return canPersistReleaseAcknowledgement(storage);
  } catch {
    return false;
  }
}

/** Records the current release after closing the dialog or opening its history. */
export function markCurrentReleaseSeen(
  storage: Pick<Storage, 'setItem'> = window.localStorage,
): void {
  try {
    storage.setItem(
      LAST_SEEN_RELEASE_STORAGE_KEY,
      CURRENT_RELEASE_VERSION,
    );
  } catch {
    // Release acknowledgement must never block the application when storage is disabled.
  }
}
