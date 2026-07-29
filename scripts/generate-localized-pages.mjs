/**
 * Business context: generates localized application entries and indexable
 * release-history pages so search and social crawlers receive complete content
 * without adding a server or duplicating maintained HTML by hand.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const SITE_ORIGIN = 'https://viahelvetica.ch';
const APP_TEMPLATE_PATH = path.join(PROJECT_ROOT, 'index.html');
const RELEASE_TEMPLATE_PATH = path.join(
  PROJECT_ROOT,
  'scripts',
  'templates',
  'releases.html',
);
const METADATA_PATH = path.join(
  PROJECT_ROOT,
  'src',
  'i18n',
  'seoMetadata.json',
);
const RELEASE_HISTORY_PATH = path.join(
  PROJECT_ROOT,
  'src',
  'releases',
  'releaseHistory.json',
);
const PACKAGE_PATH = path.join(PROJECT_ROOT, 'package.json');
const SUPPORTED_LANGUAGES = ['fr', 'de', 'it', 'en'];

function escapeHtmlAttribute(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeHtmlText(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function replaceMarkedAttribute(html, marker, attribute, value) {
  const pattern = new RegExp(
    `(<[^>]*data-localized="${marker}"[^>]*\\s${attribute}=")[^"]*(")`,
  );

  if (!pattern.test(html)) {
    throw new Error(`Missing ${attribute} marker: ${marker}`);
  }

  return html.replace(pattern, `$1${escapeHtmlAttribute(value)}$2`);
}

function replaceMarkedText(html, marker, value) {
  const pattern = new RegExp(
    `(<([a-z0-9-]+)[^>]*data-localized="${marker}"[^>]*>)[\\s\\S]*?(<\\/\\2>)`,
    'i',
  );

  if (!pattern.test(html)) {
    throw new Error(`Missing text marker: ${marker}`);
  }

  return html.replace(pattern, `$1${escapeHtmlText(value)}$3`);
}

function replaceStructuredData(html, structuredData) {
  const pattern = /(<script id="structured-data" type="application\/ld\+json">)[\s\S]*?(<\/script>)/;

  if (!pattern.test(html)) {
    throw new Error('Missing structured-data script.');
  }

  return html.replace(
    pattern,
    `$1\n${JSON.stringify(structuredData, null, 2)
      .split('\n')
      .map((line) => `      ${line}`)
      .join('\n')}\n    $2`,
  );
}

function replaceOpenGraphAlternates(html, activeLocale, metadata) {
  const alternates = Object.values(metadata)
    .map((entry) => entry.locale)
    .filter((locale) => locale !== activeLocale)
    .map(
      (locale) =>
        `    <meta property="og:locale:alternate" content="${escapeHtmlAttribute(locale)}" />`,
    )
    .join('\n');
  const pattern = /    <!-- localized-og-alternates:start -->[\s\S]*?    <!-- localized-og-alternates:end -->/;

  if (!pattern.test(html)) {
    throw new Error('Missing Open Graph locale alternate markers.');
  }

  return html.replace(
    pattern,
    `    <!-- localized-og-alternates:start -->\n${alternates}\n    <!-- localized-og-alternates:end -->`,
  );
}

function structuredDataForApplication(language, metadata) {
  const entry = metadata[language];
  const localizedUrl = `${SITE_ORIGIN}${entry.path}`;

  return {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: 'Via Helvetica',
    url: localizedUrl,
    description: entry.description,
    applicationCategory: 'TravelApplication',
    operatingSystem: 'Any',
    browserRequirements: entry.browserRequirements,
    isAccessibleForFree: true,
    inLanguage: language,
    image: {
      '@type': 'ImageObject',
      url: `${SITE_ORIGIN}/via-helvetica-preview.jpg`,
      width: 1200,
      height: 630,
    },
    codeRepository: 'https://github.com/egofree71/via-helvetica',
    license: 'https://opensource.org/license/mit/',
    author: {
      '@type': 'Person',
      name: 'Philippe De Pol',
    },
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'CHF',
    },
    featureList: entry.featureList,
  };
}

function localizeApplicationTemplate(template, language, metadata) {
  const entry = metadata[language];
  const localizedUrl = `${SITE_ORIGIN}${entry.path}`;
  let html = template;

  html = replaceMarkedAttribute(html, 'html-language', 'lang', language);
  html = replaceMarkedAttribute(html, 'description', 'content', entry.description);
  html = replaceMarkedAttribute(html, 'canonical', 'href', localizedUrl);
  html = replaceMarkedAttribute(html, 'og-locale', 'content', entry.locale);
  html = replaceMarkedAttribute(html, 'og-title', 'content', entry.title);
  html = replaceMarkedAttribute(
    html,
    'og-description',
    'content',
    entry.socialDescription,
  );
  html = replaceMarkedAttribute(html, 'og-url', 'content', localizedUrl);
  html = replaceMarkedAttribute(html, 'image-alt', 'content', entry.imageAlt);
  html = replaceMarkedAttribute(html, 'twitter-title', 'content', entry.title);
  html = replaceMarkedAttribute(
    html,
    'twitter-description',
    'content',
    entry.socialDescription,
  );
  html = replaceMarkedAttribute(
    html,
    'twitter-image-alt',
    'content',
    entry.imageAlt,
  );
  html = replaceMarkedText(html, 'title', entry.title);
  html = replaceMarkedText(html, 'noscript-title', entry.title);
  html = replaceMarkedText(html, 'noscript-description', entry.description);
  html = replaceMarkedText(
    html,
    'noscript-requirement',
    entry.javascriptRequirement,
  );
  html = replaceOpenGraphAlternates(html, entry.locale, metadata);
  html = replaceStructuredData(
    html,
    structuredDataForApplication(language, metadata),
  );

  return html;
}

function releasePagePath(language) {
  return `/${language}/releases/`;
}

function replaceTemplateToken(template, token, value) {
  const marker = `{{${token}}}`;

  if (!template.includes(marker)) {
    throw new Error(`Missing release-page template token: ${token}`);
  }

  return template.replaceAll(marker, value);
}

function renderHreflangLinks() {
  return [
    ...SUPPORTED_LANGUAGES.map(
      (language) =>
        `    <link rel="alternate" hreflang="${language}" href="${SITE_ORIGIN}${releasePagePath(language)}" />`,
    ),
    `    <link rel="alternate" hreflang="x-default" href="${SITE_ORIGIN}/releases/" />`,
  ].join('\n');
}

function renderOpenGraphAlternates(activeLanguage, metadata) {
  return SUPPORTED_LANGUAGES
    .filter((language) => language !== activeLanguage)
    .map(
      (language) =>
        `    <meta property="og:locale:alternate" content="${escapeHtmlAttribute(metadata[language].locale)}" />`,
    )
    .join('\n');
}

function renderLanguageLinks(activeLanguage) {
  return SUPPORTED_LANGUAGES.map((language) => {
    const current = language === activeLanguage
      ? ' aria-current="page"'
      : '';

    return `          <a href="${releasePagePath(language)}" hreflang="${language}"${current}>${language.toUpperCase()}</a>`;
  }).join('\n');
}

function renderReleaseItems(items) {
  if (items.length === 0) {
    return '';
  }

  const renderedItems = items.map((item) => {
    const details = item.details.length > 0
      ? `\n            <ul class="release-detail-list">\n${item.details
          .map((detail) => `              <li>${escapeHtmlText(detail)}</li>`)
          .join('\n')}\n            </ul>`
      : '';

    return `          <li>\n            <p><strong>${escapeHtmlText(item.title)}</strong> ${escapeHtmlText(item.description)}</p>${details}\n          </li>`;
  }).join('\n');

  return `\n        <ul class="release-items">\n${renderedItems}\n        </ul>`;
}

function releaseElementId(version) {
  return `release-${version.replaceAll('.', '-')}`;
}

function renderReleaseCards(localizedHistory, currentVersion) {
  return localizedHistory.releases.map((release) => {
    const isCurrent = release.version === currentVersion;
    const currentBadge = isCurrent
      ? `\n          <span class="release-current-badge">${escapeHtmlText(localizedHistory.page.currentLabel)}</span>`
      : '';

    return `        <article class="release-card" aria-labelledby="${releaseElementId(release.version)}">\n          <header class="release-card-header">\n            <h2 id="${releaseElementId(release.version)}">${escapeHtmlText(localizedHistory.page.versionLabel)} ${escapeHtmlText(release.version)}</h2>${currentBadge}\n          </header>\n          <p class="release-summary">${escapeHtmlText(release.summary)}</p>${renderReleaseItems(release.items)}\n        </article>`;
  }).join('\n');
}

function structuredDataForReleasePage(language, localizedHistory) {
  return {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: localizedHistory.page.heading,
    url: `${SITE_ORIGIN}${releasePagePath(language)}`,
    description: localizedHistory.page.description,
    inLanguage: language,
    isPartOf: {
      '@type': 'WebSite',
      name: 'Via Helvetica',
      url: SITE_ORIGIN,
    },
  };
}

function localizeReleaseTemplate(
  template,
  language,
  metadata,
  releaseHistory,
  options = {},
) {
  const localizedHistory = releaseHistory.locales[language];
  const pagePath = options.pagePath ?? releasePagePath(language);
  const canonicalPath = options.canonicalPath ?? pagePath;
  const canonicalUrl = `${SITE_ORIGIN}${canonicalPath}`;
  let html = template;
  const replacements = {
    LANGUAGE: escapeHtmlAttribute(language),
    DESCRIPTION: escapeHtmlAttribute(localizedHistory.page.description),
    CANONICAL_URL: escapeHtmlAttribute(canonicalUrl),
    HREFLANG_LINKS: renderHreflangLinks(),
    OG_LOCALE: escapeHtmlAttribute(metadata[language].locale),
    OG_ALTERNATES: renderOpenGraphAlternates(language, metadata),
    TITLE: escapeHtmlText(localizedHistory.page.title),
    IMAGE_ALT: escapeHtmlAttribute(metadata[language].imageAlt),
    STRUCTURED_DATA: JSON.stringify(
      structuredDataForReleasePage(language, localizedHistory),
      null,
      2,
    )
      .split('\n')
      .map((line) => `      ${line}`)
      .join('\n'),
    APP_PATH: escapeHtmlAttribute(metadata[language].path),
    LANGUAGE_NAVIGATION: escapeHtmlAttribute(
      localizedHistory.page.languageNavigation,
    ),
    LANGUAGE_LINKS: renderLanguageLinks(language),
    BACK_TO_APP: escapeHtmlText(localizedHistory.page.backToApp),
    HEADING: escapeHtmlText(localizedHistory.page.heading),
    INTRO: escapeHtmlText(localizedHistory.page.intro),
    RELEASES: renderReleaseCards(
      localizedHistory,
      releaseHistory.currentVersion,
    ),
  };

  for (const [token, value] of Object.entries(replacements)) {
    html = replaceTemplateToken(html, token, value);
  }

  if (/{{[A-Z_]+}}/.test(html)) {
    throw new Error(`Unresolved release-page template token for ${pagePath}`);
  }

  return html;
}

function validateReleaseHistory(releaseHistory, packageManifest) {
  if (releaseHistory.currentVersion !== packageManifest.version) {
    throw new Error(
      `Release version ${releaseHistory.currentVersion} does not match package version ${packageManifest.version}.`,
    );
  }

  let referenceVersions = null;
  let referenceCurrentItemIds = null;
  let referenceCurrentDialogItemIds = null;

  for (const language of SUPPORTED_LANGUAGES) {
    const localizedHistory = releaseHistory.locales[language];

    if (!localizedHistory) {
      throw new Error(`Missing release history for language: ${language}`);
    }

    const requiredDialogFields = [
      'title',
      'historyLink',
      'historyLinkNewTabLabel',
    ];
    const requiredPageFields = [
      'title',
      'description',
      'heading',
      'intro',
      'backToApp',
      'languageNavigation',
      'versionLabel',
      'currentLabel',
    ];

    for (const field of requiredDialogFields) {
      if (typeof localizedHistory.dialog[field] !== 'string' || !localizedHistory.dialog[field].trim()) {
        throw new Error(`Missing release dialog field ${field} for language: ${language}`);
      }
    }

    for (const field of requiredPageFields) {
      if (typeof localizedHistory.page[field] !== 'string' || !localizedHistory.page[field].trim()) {
        throw new Error(`Missing release page field ${field} for language: ${language}`);
      }
    }

    const versions = localizedHistory.releases.map((release) => release.version);

    if (versions[0] !== releaseHistory.currentVersion) {
      throw new Error(`Current release must be first for language: ${language}`);
    }

    if (referenceVersions && JSON.stringify(versions) !== JSON.stringify(referenceVersions)) {
      throw new Error(`Release versions differ for language: ${language}`);
    }

    referenceVersions ??= versions;

    const currentRelease = localizedHistory.releases[0];
    const currentItemIds = currentRelease.items.map((item) => item.id);

    if (
      referenceCurrentItemIds
      && JSON.stringify(currentItemIds) !== JSON.stringify(referenceCurrentItemIds)
    ) {
      throw new Error(`Current release items differ for language: ${language}`);
    }

    referenceCurrentItemIds ??= currentItemIds;

    const currentDialogItemIds = currentRelease.items
      .filter((item) => item.showInDialog !== false)
      .map((item) => item.id);

    if (
      referenceCurrentDialogItemIds
      && JSON.stringify(currentDialogItemIds)
        !== JSON.stringify(referenceCurrentDialogItemIds)
    ) {
      throw new Error(
        `Current release dialog items differ for language: ${language}`,
      );
    }

    referenceCurrentDialogItemIds ??= currentDialogItemIds;

    for (const release of localizedHistory.releases) {
      if (!release.version || !release.summary?.trim()) {
        throw new Error(`Incomplete release content for ${language}.`);
      }

      for (const item of release.items) {
        if (
          !item.id
          || !item.title?.trim()
          || !item.description?.trim()
          || !Array.isArray(item.details)
          || (
            item.showInDialog !== undefined
            && typeof item.showInDialog !== 'boolean'
          )
        ) {
          throw new Error(
            `Incomplete release item for ${language} ${release.version}.`,
          );
        }
      }

      const duplicateIds = release.items.filter(
        (item, index, items) =>
          items.findIndex((candidate) => candidate.id === item.id) !== index,
      );

      if (duplicateIds.length > 0) {
        throw new Error(
          `Duplicate release item ${duplicateIds[0].id} for ${language} ${release.version}.`,
        );
      }
    }
  }
}

const [
  appTemplate,
  releaseTemplate,
  metadataSource,
  releaseHistorySource,
  packageSource,
] = await Promise.all([
  readFile(APP_TEMPLATE_PATH, 'utf8'),
  readFile(RELEASE_TEMPLATE_PATH, 'utf8'),
  readFile(METADATA_PATH, 'utf8'),
  readFile(RELEASE_HISTORY_PATH, 'utf8'),
  readFile(PACKAGE_PATH, 'utf8'),
]);
const metadata = JSON.parse(metadataSource);
const releaseHistory = JSON.parse(releaseHistorySource);
const packageManifest = JSON.parse(packageSource);

validateReleaseHistory(releaseHistory, packageManifest);

for (const language of SUPPORTED_LANGUAGES) {
  if (!metadata[language]) {
    throw new Error(`Missing SEO metadata for language: ${language}`);
  }

  if (metadata[language].path !== `/${language}/`) {
    throw new Error(`Invalid localized path for language: ${language}`);
  }

  const applicationOutputDirectory = path.join(PROJECT_ROOT, language);
  await mkdir(applicationOutputDirectory, { recursive: true });
  await writeFile(
    path.join(applicationOutputDirectory, 'index.html'),
    localizeApplicationTemplate(appTemplate, language, metadata),
    'utf8',
  );

  const releaseOutputDirectory = path.join(
    PROJECT_ROOT,
    language,
    'releases',
  );
  await mkdir(releaseOutputDirectory, { recursive: true });
  await writeFile(
    path.join(releaseOutputDirectory, 'index.html'),
    localizeReleaseTemplate(
      releaseTemplate,
      language,
      metadata,
      releaseHistory,
    ),
    'utf8',
  );
}

const defaultReleaseOutputDirectory = path.join(PROJECT_ROOT, 'releases');
await mkdir(defaultReleaseOutputDirectory, { recursive: true });
await writeFile(
  path.join(defaultReleaseOutputDirectory, 'index.html'),
  localizeReleaseTemplate(
    releaseTemplate,
    'en',
    metadata,
    releaseHistory,
    {
      pagePath: '/releases/',
      canonicalPath: '/en/releases/',
    },
  ),
  'utf8',
);
