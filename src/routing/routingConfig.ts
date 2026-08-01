/**
 * Business context: resolves the routing provider and binary-data location used
 * by the dedicated Worker. Local development can compare providers, while a
 * versioned remote dataset is enabled explicitly through a Vite environment
 * variable and production otherwise remains on GeoAdmin.
 */

/** Routing-data providers available to the dedicated Worker. */
export type RoutingDataSource =
  | 'geo-admin'
  | 'precomputed-binary';

/** Legacy local Vite path used only for focused binary-provider experiments. */
export const LOCAL_PRECOMPUTED_BINARY_ROUTING_BASE_URL =
  '/routing-data/ch-precomputed-binary';

/** Development-only routing choices used while Vite serves source files. */
export interface LocalRoutingDevelopmentConfig {
  /** Data provider used only when no remote dataset URL is configured. */
  dataSource: RoutingDataSource;
  /**
   * Whether development GeoAdmin requests include optional hiking geometry.
   * The binary graph already contains final hiking-aware edge costs.
   */
  useHikingEnrichment: boolean;
}

/** Fully resolved Worker routing configuration. */
export interface ResolvedRoutingConfiguration {
  /** Provider used for the initial routing session. */
  dataSource: RoutingDataSource;
  /** Base URL used only by the precomputed binary provider. */
  precomputedBinaryBaseUrl?: string;
  /** Whether the binary URL comes from `VITE_ROUTING_DATA_BASE_URL`. */
  usesRemoteBinaryData: boolean;
}

/**
 * Manually editable development fallback. GeoAdmin is the safe default because
 * national binary releases now live outside the repository and are activated by
 * `VITE_ROUTING_DATA_BASE_URL`. Restart Vite after changing either value.
 */
export const LOCAL_ROUTING_DEVELOPMENT_CONFIG: LocalRoutingDevelopmentConfig = {
  dataSource: 'geo-admin',
  useHikingEnrichment: true,
};

/**
 * Normalizes a configured routing-data root without accepting credentials,
 * query parameters, or fragments that would make relative manifest paths
 * ambiguous.
 * @param value - Raw Vite environment value.
 * @returns A root-relative or HTTP(S) base URL without a trailing slash.
 * @throws {Error} When a non-empty value is not a safe routing-data base URL.
 */
export function normalizeRoutingDataBaseUrl(
  value: string | undefined,
): string | null {
  const trimmed = value?.trim();

  if (!trimmed) {
    return null;
  }

  if (/\s/.test(trimmed)) {
    throw new Error('Routing-data base URL must not contain whitespace.');
  }

  if (trimmed.startsWith('/')) {
    if (trimmed.includes('?') || trimmed.includes('#')) {
      throw new Error(
        'Root-relative routing-data URLs must not contain a query or fragment.',
      );
    }

    return trimmed.replace(/\/+$/, '') || '/';
  }

  const normalized = trimmed.replace(/\/+$/, '');

  let parsed: URL;

  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error('Routing-data base URL is not a valid URL.');
  }

  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      'Routing-data base URL must be an HTTP(S) URL without credentials, query, or fragment.',
    );
  }

  return normalized;
}

/**
 * Resolves the provider and its data root for the current build.
 * @param isDevelopment - Vite development flag injected into the Worker bundle.
 * @param environmentBaseUrl - Optional `VITE_ROUTING_DATA_BASE_URL` value.
 * @param localConfig - Development setting, injectable for regression tests.
 * @returns A remote binary provider when configured, otherwise the local
 * development choice or the production-safe GeoAdmin default.
 */
export function resolveRoutingConfiguration(
  isDevelopment: boolean,
  environmentBaseUrl: string | undefined,
  localConfig: LocalRoutingDevelopmentConfig =
    LOCAL_ROUTING_DEVELOPMENT_CONFIG,
): ResolvedRoutingConfiguration {
  const remoteBaseUrl = normalizeRoutingDataBaseUrl(environmentBaseUrl);

  if (remoteBaseUrl) {
    return {
      dataSource: 'precomputed-binary',
      precomputedBinaryBaseUrl: remoteBaseUrl,
      usesRemoteBinaryData: true,
    };
  }

  const dataSource = isDevelopment ? localConfig.dataSource : 'geo-admin';

  if (dataSource === 'precomputed-binary') {
    return {
      dataSource,
      precomputedBinaryBaseUrl: LOCAL_PRECOMPUTED_BINARY_ROUTING_BASE_URL,
      usesRemoteBinaryData: false,
    };
  }

  return {
    dataSource: 'geo-admin',
    usesRemoteBinaryData: false,
  };
}

/**
 * Resolves whether optional hiking geometry should be requested.
 * @param isDevelopment - Vite development flag injected into the Worker bundle.
 * @param localConfig - Development setting, injectable for regression tests.
 * @returns The development value while serving source; always `true` in production.
 */
export function shouldUseHikingEnrichment(
  isDevelopment: boolean,
  localConfig: LocalRoutingDevelopmentConfig =
    LOCAL_ROUTING_DEVELOPMENT_CONFIG,
): boolean {
  return isDevelopment ? localConfig.useHikingEnrichment : true;
}
