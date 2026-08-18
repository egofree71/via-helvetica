/**
 * Business context: keeps SwitzerlandMobility route identity consistent wherever
 * a lightweight route candidate is presented before or after full geometry load.
 */
import type { TranslationKey } from '../i18n/translations';
import type { SwitzerlandMobilityHikingRouteCandidate } from './hikingRoutes';

/** Translation helper subset required by public-route identity labels. */
export type SwitzerlandMobilityHikingTranslate = (
  key: TranslationKey,
  parameters?: Record<string, string | number>,
) => string;

/** Returns the best public route name, then a localized numeric fallback. */
export function getSwitzerlandMobilityHikingRouteName(
  candidate: SwitzerlandMobilityHikingRouteCandidate,
  t: SwitzerlandMobilityHikingTranslate,
): string {
  if (candidate.routeName) {
    return candidate.routeName;
  }

  if (candidate.routeNumber) {
    return t('switzerlandMobilityHiking.routeNumber', {
      number: candidate.routeNumber,
    });
  }

  return t('switzerlandMobilityHiking.unnamedRoute');
}

/** Builds the localized stage/section subtitle for a public route candidate. */
export function getSwitzerlandMobilityHikingRouteSubtitle(
  candidate: SwitzerlandMobilityHikingRouteCandidate,
  t: SwitzerlandMobilityHikingTranslate,
): string | null {
  if (candidate.stageNumber && candidate.sectionName) {
    return t('switzerlandMobilityHiking.stageSection', {
      number: candidate.stageNumber,
      section: candidate.sectionName,
    });
  }

  if (candidate.stageNumber) {
    return t('switzerlandMobilityHiking.stage', {
      number: candidate.stageNumber,
    });
  }

  return candidate.sectionName;
}
