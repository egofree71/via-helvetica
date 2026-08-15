/**
 * Business context: keeps language switching directly available in the
 * floating map controls on large screens. Phone layouts move the same choice
 * into the map/options sheet to preserve scarce permanent map space.
 */
import { useI18n } from '../i18n/I18nContext';
import {
  LANGUAGE_METADATA,
  SUPPORTED_LANGUAGES,
  type Language,
} from '../i18n/translations';

/** Native select keeps keyboard and touch behaviour reliable across browsers. */
export default function LanguageSelector() {
  const { language, setLanguage, t } = useI18n();
  const label = t('language.select');

  return (
    <select
      className="language-selector"
      value={language}
      aria-label={label}
      title={label}
      onChange={(event) => setLanguage(event.target.value as Language)}
    >
      {SUPPORTED_LANGUAGES.map((option) => (
        <option key={option} value={option}>
          {LANGUAGE_METADATA[option].shortLabel}
        </option>
      ))}
    </select>
  );
}
