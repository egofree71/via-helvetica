/**
 * Business context: exposes development-only routing switches used to compare
 * the production GeoAdmin provider with the precomputed Geneva binary graph.
 * Vite's build mode, rather than the URL hostname, is the safety boundary so
 * local-network addresses remain testable while production stays on GeoAdmin.
 */

/** Routing-data providers available to the dedicated Worker. */
export type RoutingDataSource =
  | 'geo-admin'
  | 'precomputed-binary-geneva';

/** Development-only routing choices used while Vite serves source files. */
export interface LocalRoutingDevelopmentConfig {
  /** Data provider used only when `import.meta.env.DEV` is true. */
  dataSource: RoutingDataSource;
  /**
   * Whether development GeoAdmin requests include optional hiking geometry.
   * The binary graph already contains final hiking-aware edge costs.
   */
  useHikingEnrichment: boolean;
}

/**
 * Manually editable development configuration.
 * Restart the Vite development server after changing either value.
 */
export const LOCAL_ROUTING_DEVELOPMENT_CONFIG: LocalRoutingDevelopmentConfig = {
  dataSource: 'precomputed-binary-geneva',
  useHikingEnrichment: true,
};

/**
 * Resolves the routing-data provider for the current build mode.
 * @param isDevelopment - Vite development flag injected into the Worker bundle.
 * @param localConfig - Development setting, injectable for regression tests.
 * @returns The configured experiment in development; always GeoAdmin in production.
 */
export function resolveRoutingDataSource(
  isDevelopment: boolean,
  localConfig: LocalRoutingDevelopmentConfig =
    LOCAL_ROUTING_DEVELOPMENT_CONFIG,
): RoutingDataSource {
  return isDevelopment ? localConfig.dataSource : 'geo-admin';
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
