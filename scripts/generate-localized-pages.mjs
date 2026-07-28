/**
 * Business context: generates one static HTML entry per supported language so
 * search engines and social crawlers receive localized metadata without adding
 * a server or duplicating the complete application shell by hand.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const SITE_ORIGIN = 'https://viahelvetica.ch';
const TEMPLATE_PATH = path.join(PROJECT_ROOT, 'index.html');
const METADATA_PATH = path.join(
  PROJECT_ROOT,
  'src',
  'i18n',
  'seoMetadata.json',
);
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

function structuredDataFor(language, metadata) {
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

function localizeTemplate(template, language, metadata) {
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
    structuredDataFor(language, metadata),
  );

  return html;
}

const [template, metadataSource] = await Promise.all([
  readFile(TEMPLATE_PATH, 'utf8'),
  readFile(METADATA_PATH, 'utf8'),
]);
const metadata = JSON.parse(metadataSource);

for (const language of SUPPORTED_LANGUAGES) {
  if (!metadata[language]) {
    throw new Error(`Missing SEO metadata for language: ${language}`);
  }

  if (metadata[language].path !== `/${language}/`) {
    throw new Error(`Invalid localized path for language: ${language}`);
  }

  const outputDirectory = path.join(PROJECT_ROOT, language);
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    path.join(outputDirectory, 'index.html'),
    localizeTemplate(template, language, metadata),
    'utf8',
  );
}
