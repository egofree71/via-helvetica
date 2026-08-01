/**
 * Business context: loads the machine-local paths and non-secret publication
 * settings used by the offline Swiss routing-data pipeline. National sources,
 * intermediate geometry, build databases, and binary releases live outside the
 * repository so Vite, IDE indexers, Git, and antivirus scans do not repeatedly
 * traverse tens of thousands of generated files.
 */
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
export const DEFAULT_ROUTING_DATA_CONFIG_PATH = join(
  PROJECT_ROOT,
  'routing-data.config.local.json',
);

const PATH_FIELDS = [
  'sourceGeoPackage',
  'geometryRoot',
  'binaryReleaseRoot',
  'buildDatabasePath',
];

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

  for (const field of PATH_FIELDS) {
    if (parsed[field] !== undefined) {
      normalized[field] = resolveConfiguredPath(
        parsed[field],
        configDirectory,
        field,
      );
    }
  }

  if (parsed.scope !== undefined) {
    if (typeof parsed.scope !== 'string' || parsed.scope.trim() === '') {
      throw new Error(
        'Routing-data configuration field scope must be a non-empty string.',
      );
    }
    normalized.scope = parsed.scope.trim();
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
  }

  Object.defineProperty(normalized, 'configPath', {
    value: resolvedPath,
    enumerable: false,
  });

  return normalized;
}
