/**
 * Business context: loads the machine-local paths and non-secret publication
 * settings used by the offline Swiss routing-data pipeline. National sources,
 * intermediate geometry, build databases, and binary releases live outside the
 * repository so Vite, IDE indexers, Git, and antivirus scans do not repeatedly
 * traverse tens of thousands of generated files.
 *
 * One dataset identifier, binary-format identifier, and scope define the stable
 * release path used both locally and on R2. This prevents annual source updates
 * from requiring the same version string to be edited in several places.
 */
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
export const DEFAULT_ROUTING_DATA_CONFIG_PATH = join(
  PROJECT_ROOT,
  'routing-data.config.local.json',
);

const EXPLICIT_PATH_FIELDS = [
  'sourceGeoPackage',
  'dataRoot',
  // These legacy/advanced overrides remain supported for one-off layouts.
  'geometryRoot',
  'binaryReleaseRoot',
  'buildDatabasePath',
];

const RELEASE_IDENTIFIER_FIELDS = ['datasetId', 'formatId', 'scope'];

/** Resolves one configured path relative to the configuration file. */
function resolveConfiguredPath(value, configDirectory, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(
      `Routing-data configuration field ${field} must be a non-empty path string.`,
    );
  }

  const trimmed = value.trim();
  return isAbsolute(trimmed)
    ? resolve(trimmed)
    : resolve(configDirectory, trimmed);
}

/**
 * Validates one identifier that becomes a single filesystem and URL segment.
 * Path separators are forbidden so a typo cannot silently change the release
 * hierarchy or escape the configured data root.
 */
function normalizeReleaseIdentifier(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(
      `Routing-data configuration field ${field} must be a non-empty string.`,
    );
  }

  const normalized = value.trim();
  if (normalized.includes('/') || normalized.includes('\\')) {
    throw new Error(
      `Routing-data configuration field ${field} must contain one path segment.`,
    );
  }
  return normalized;
}

/** Removes surrounding slashes from an object-storage prefix. */
function normalizePrefix(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(
      `Routing-data configuration field ${field} must be a non-empty string.`,
    );
  }
  return value.trim().replace(/^\/+|\/+$/g, '');
}

/** Normalizes a public URL root without changing its scheme or host. */
function normalizePublicUrl(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(
      `Routing-data configuration field ${field} must be a non-empty URL string.`,
    );
  }
  return value.trim().replace(/\/+$/g, '');
}

/**
 * Removes the optional `--config` argument before a script parses its own CLI.
 * Explicit command-line paths continue to override values from the local file.
 *
 * @param {string[]} argv Command-line arguments without the Node executable.
 * @returns {{ configPath: string, configWasExplicit: boolean, argv: string[] }}
 * Normalized config location and the remaining script-specific arguments.
 */
export function extractRoutingDataConfigArgument(argv) {
  let configPath = DEFAULT_ROUTING_DATA_CONFIG_PATH;
  let configWasExplicit = false;
  const remainingArguments = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== '--config') {
      remainingArguments.push(argument);
      continue;
    }

    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error('Missing value for --config.');
    }

    configPath = resolve(value);
    configWasExplicit = true;
    index += 1;
  }

  return {
    configPath,
    configWasExplicit,
    argv: remainingArguments,
  };
}

/**
 * Reads and validates the local routing-data pipeline configuration.
 *
 * Relative filesystem paths are resolved from the configuration directory.
 * `datasetId`, `formatId`, and `scope` form one immutable release path. When a
 * `dataRoot` is supplied, work and release paths are derived from that identity.
 * Explicit legacy paths remain valid as overrides for custom layouts.
 * R2 credentials are deliberately absent; they remain in rclone's own config.
 *
 * @param {string} configPath Absolute or current-directory-relative JSON path.
 * @param {{ optional?: boolean }} options Whether a missing file is acceptable.
 * @returns {Promise<Record<string, unknown>>} Normalized configuration values.
 */
export async function loadRoutingDataConfig(
  configPath = DEFAULT_ROUTING_DATA_CONFIG_PATH,
  { optional = false } = {},
) {
  const resolvedPath = resolve(configPath);
  let raw;

  try {
    raw = await readFile(resolvedPath, 'utf8');
  } catch (error) {
    if (optional && error?.code === 'ENOENT') {
      return {};
    }
    if (error?.code === 'ENOENT') {
      throw new Error(
        `Routing-data configuration not found: ${resolvedPath}. ` +
          'Copy routing-data.config.example.json to routing-data.config.local.json and adjust the paths.',
      );
    }
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Cannot parse routing-data configuration ${resolvedPath}: ${error}`,
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Routing-data configuration must contain one JSON object.');
  }

  const configDirectory = dirname(resolvedPath);
  const normalized = { ...parsed };

  for (const field of EXPLICIT_PATH_FIELDS) {
    if (parsed[field] !== undefined) {
      normalized[field] = resolveConfiguredPath(
        parsed[field],
        configDirectory,
        field,
      );
    }
  }

  const usesDerivedLayout =
    parsed.datasetId !== undefined ||
    parsed.formatId !== undefined ||
    parsed.dataRoot !== undefined;

  if (usesDerivedLayout) {
    for (const field of RELEASE_IDENTIFIER_FIELDS) {
      normalized[field] = normalizeReleaseIdentifier(parsed[field], field);
    }
    if (normalized.dataRoot === undefined) {
      throw new Error(
        'Routing-data configuration field dataRoot is required with datasetId and formatId.',
      );
    }

    normalized.releasePath = [
      normalized.datasetId,
      normalized.formatId,
      normalized.scope,
    ].join('/');

    // Geometry depends on the source edition and scope, not on the binary format.
    normalized.geometryRoot ??= join(
      normalized.dataRoot,
      'work',
      normalized.datasetId,
      `${normalized.scope}-geometry`,
    );
    normalized.binaryReleaseRoot ??= join(
      normalized.dataRoot,
      'releases',
      normalized.datasetId,
      normalized.formatId,
      normalized.scope,
    );
    normalized.buildDatabasePath ??= join(
      normalized.dataRoot,
      'work',
      normalized.datasetId,
      'precomputed-binary-routing-build.sqlite',
    );
  } else if (parsed.scope !== undefined) {
    // Keep the former explicit-path configuration readable during migration.
    normalized.scope = normalizeReleaseIdentifier(parsed.scope, 'scope');
  }

  if (parsed.publication !== undefined) {
    if (
      !parsed.publication ||
      typeof parsed.publication !== 'object' ||
      Array.isArray(parsed.publication)
    ) {
      throw new Error(
        'Routing-data publication configuration must contain one JSON object.',
      );
    }

    normalized.publication = { ...parsed.publication };
    if (parsed.publication.prefix !== undefined) {
      normalized.publication.prefix = normalizePrefix(
        parsed.publication.prefix,
        'publication.prefix',
      );
    } else if (normalized.releasePath) {
      normalized.publication.prefix = normalized.releasePath;
    }

    if (parsed.publication.publicRootUrl !== undefined) {
      normalized.publication.publicRootUrl = normalizePublicUrl(
        parsed.publication.publicRootUrl,
        'publication.publicRootUrl',
      );
    }
    if (parsed.publication.publicBaseUrl !== undefined) {
      normalized.publication.publicBaseUrl = normalizePublicUrl(
        parsed.publication.publicBaseUrl,
        'publication.publicBaseUrl',
      );
    } else if (
      normalized.publication.publicRootUrl &&
      normalized.releasePath
    ) {
      normalized.publication.publicBaseUrl =
        `${normalized.publication.publicRootUrl}/${normalized.releasePath}`;
    }
  }

  Object.defineProperty(normalized, 'configPath', {
    value: resolvedPath,
    enumerable: false,
  });

  return normalized;
}
