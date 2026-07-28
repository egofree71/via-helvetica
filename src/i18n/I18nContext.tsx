/**
 * Business context: owns the selected interface language, keeps localized URLs
 * synchronized without reloading the map, and exposes a small typed translation
 * API without adding a runtime internationalization dependency.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import seoMetadataSource from './seoMetadata.json';
import {
  LANGUAGE_METADATA,
  SUPPORTED_LANGUAGES,
  TRANSLATIONS,
  type Language,
  type TranslationKey,
} from './translations';

/** Local-storage key used to preserve the explicit language selection. */
const LANGUAGE_STORAGE_KEY = 'via-helvetica-language';
/** History-state key used to restore the language of the unlocalized root URL. */
const LANGUAGE_HISTORY_STATE_KEY = 'viaHelveticaLanguage';
/** Production origin used by canonical, Open Graph, and structured-data URLs. */
const SITE_ORIGIN = 'https://viahelvetica.ch';
/** Named values substituted into translated strings such as profile ranges. */
type TranslationParameters = Record<string, string | number>;

/** Static metadata required by both generated HTML entries and runtime updates. */
interface SeoMetadataEntry {
  /** Root-relative path of the localized application entry. */
  path: string;
  /** Open Graph locale code. */
  locale: string;
  /** Localized document and application title. */
  title: string;
  /** Localized search-result description. */
  description: string;
  /** Shorter localized description used by social previews. */
  socialDescription: string;
  /** Localized alternative text for the shared social image. */
  imageAlt: string;
  /** Localized browser requirement used by Schema.org metadata. */
  browserRequirements: string;
  /** Localized fallback text shown when JavaScript is disabled. */
  javascriptRequirement: string;
  /** Localized capability summary used by Schema.org metadata. */
  featureList: string[];
}

const SEO_METADATA: Record<Language, SeoMetadataEntry> = seoMetadataSource;

/** Public language state and translation helpers. */
interface I18nContextValue {
  /** Currently selected interface language. */
  language: Language;
  /** Swiss locale used by Intl number formatting. */
  locale: string;
  /** Changes and persists the interface language without reloading the map. */
  setLanguage: (language: Language) => void;
  /** Returns one translated string with optional named substitutions. */
  t: (key: TranslationKey, parameters?: TranslationParameters) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

/** Tests whether an arbitrary value is one of the supported language codes. */
export function isSupportedLanguage(value: string): value is Language {
  return SUPPORTED_LANGUAGES.includes(value as Language);
}

/** Returns the localized language encoded by a root path such as `/de/`. */
export function languageFromPathname(pathname: string): Language | null {
  const firstSegment = pathname.split('/').filter(Boolean)[0];
  return firstSegment && isSupportedLanguage(firstSegment)
    ? firstSegment
    : null;
}

/** Resolves a browser language tag such as `de-CH` to a supported language. */
function languageFromTag(tag: string): Language | null {
  const language = tag.toLowerCase().split('-')[0];
  return isSupportedLanguage(language) ? language : null;
}

/** Uses the URL first, then persisted and browser preferences, then English. */
function resolveInitialLanguage(): Language {
  const pathLanguage = languageFromPathname(window.location.pathname);

  if (pathLanguage) {
    return pathLanguage;
  }

  try {
    const storedLanguage = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);

    if (storedLanguage && isSupportedLanguage(storedLanguage)) {
      return storedLanguage;
    }
  } catch {
    // Storage can be unavailable in strict privacy contexts; detection still works.
  }

  for (const browserLanguage of navigator.languages ?? [navigator.language]) {
    const supportedLanguage = languageFromTag(browserLanguage);

    if (supportedLanguage) {
      return supportedLanguage;
    }
  }

  return 'en';
}

/** Substitutes `{name}` placeholders while leaving unknown placeholders intact. */
function interpolate(
  template: string,
  parameters: TranslationParameters = {},
): string {
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    Object.hasOwn(parameters, name) ? String(parameters[name]) : placeholder,
  );
}

/** Updates one existing metadata element without creating conflicting copies. */
function setMetadataContent(selector: string, content: string): void {
  const element = document.querySelector<HTMLMetaElement>(selector);

  if (element) {
    element.content = content;
  }
}

/** Updates localized Schema.org fields while preserving the shared data shape. */
function synchronizeStructuredData(
  language: Language,
  canonicalUrl: string,
): void {
  const element = document.querySelector<HTMLScriptElement>('#structured-data');

  if (!element?.textContent) {
    return;
  }

  try {
    const data = JSON.parse(element.textContent) as Record<string, unknown>;
    const metadata = SEO_METADATA[language];

    data.url = canonicalUrl;
    data.description = metadata.description;
    data.browserRequirements = metadata.browserRequirements;
    data.inLanguage = language;
    data.featureList = metadata.featureList;
    element.textContent = JSON.stringify(data);
  } catch {
    // The build emits valid JSON; third-party mutation must not break switching.
  }
}

/** Keeps the already loaded document head coherent after History API changes. */
function synchronizeDocumentMetadata(language: Language): void {
  const metadata = SEO_METADATA[language];
  const hasLocalizedPath = languageFromPathname(window.location.pathname);
  const canonicalPath = hasLocalizedPath ? metadata.path : '/';
  const canonicalUrl = `${SITE_ORIGIN}${canonicalPath}`;

  document.documentElement.lang = language;
  document.title = metadata.title;
  setMetadataContent('meta[name="description"]', metadata.description);
  setMetadataContent('meta[property="og:locale"]', metadata.locale);
  setMetadataContent('meta[property="og:title"]', metadata.title);
  setMetadataContent(
    'meta[property="og:description"]',
    metadata.socialDescription,
  );
  setMetadataContent('meta[property="og:url"]', canonicalUrl);
  setMetadataContent('meta[property="og:image:alt"]', metadata.imageAlt);
  setMetadataContent('meta[name="twitter:title"]', metadata.title);
  setMetadataContent(
    'meta[name="twitter:description"]',
    metadata.socialDescription,
  );
  setMetadataContent('meta[name="twitter:image:alt"]', metadata.imageAlt);

  const canonical = document.querySelector<HTMLLinkElement>(
    'link[rel="canonical"]',
  );

  if (canonical) {
    canonical.href = canonicalUrl;
  }

  const alternateLocales = SUPPORTED_LANGUAGES.filter(
    (candidate) => candidate !== language,
  ).map((candidate) => SEO_METADATA[candidate].locale);
  const alternateElements = document.querySelectorAll<HTMLMetaElement>(
    'meta[property="og:locale:alternate"]',
  );

  alternateElements.forEach((element, index) => {
    const locale = alternateLocales[index];

    if (locale) {
      element.content = locale;
    }
  });

  synchronizeStructuredData(language, canonicalUrl);
}

/** Returns a localized URL while preserving query parameters and fragments. */
function localizedBrowserUrl(language: Language): string {
  const url = new URL(window.location.href);
  url.pathname = SEO_METADATA[language].path;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Provides language state and translated strings to the complete application. */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(resolveInitialLanguage);

  const t = useCallback(
    (key: TranslationKey, parameters?: TranslationParameters) =>
      interpolate(TRANSLATIONS[language][key], parameters),
    [language],
  );

  const setLanguage = useCallback((nextLanguage: Language) => {
    const nextState = {
      ...(window.history.state ?? {}),
      [LANGUAGE_HISTORY_STATE_KEY]: nextLanguage,
    };

    // The URL changes without recreating OpenLayers or the current route state.
    window.history.pushState(
      nextState,
      '',
      localizedBrowserUrl(nextLanguage),
    );
    setLanguageState(nextLanguage);
  }, []);

  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      const pathLanguage = languageFromPathname(window.location.pathname);
      const stateLanguage = event.state?.[LANGUAGE_HISTORY_STATE_KEY];

      if (pathLanguage) {
        setLanguageState(pathLanguage);
      } else if (
        typeof stateLanguage === 'string' &&
        isSupportedLanguage(stateLanguage)
      ) {
        setLanguageState(stateLanguage);
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    const currentState = {
      ...(window.history.state ?? {}),
      [LANGUAGE_HISTORY_STATE_KEY]: language,
    };

    // Root has no language segment, so its language must survive browser history.
    window.history.replaceState(currentState, '');
    synchronizeDocumentMetadata(language);

    try {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    } catch {
      // Language switching must remain usable even if persistence is blocked.
    }
  }, [language]);

  const value = useMemo<I18nContextValue>(
    () => ({
      language,
      locale: LANGUAGE_METADATA[language].locale,
      setLanguage,
      t,
    }),
    [language, setLanguage, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/**
 * Returns the nearest language provider.
 * @returns Current language state and the typed translation helper.
 * @throws {Error} If the hook is used outside `I18nProvider`.
 */
export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);

  if (!context) {
    throw new Error('useI18n must be used inside I18nProvider.');
  }

  return context;
}
