/**
 * Business context: protects the offline routing-data release identity from
 * drifting across local paths, R2 prefixes, and public URLs when a new official
 * swissTLM3D edition is configured.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadRoutingDataConfig } from './routing-data-config.mjs';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function writeConfig(value) {
  const directory = await mkdtemp(join(tmpdir(), 'via-helvetica-routing-config-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'routing-data.config.local.json');
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return { directory, path };
}

describe('routing-data configuration', () => {
  it('derives every release location from one identity', async () => {
    const { directory, path } = await writeConfig({
      datasetId: 'swisstlm3d-2027',
      formatId: 'format-v3',
      scope: 'ch',
      dataRoot: './data',
      sourceGeoPackage: './source/swisstlm3d.gpkg',
      publication: {
        remote: 'r2',
        bucket: 'via-helvetica-routing-data',
        publicRootUrl: 'https://routing-data.example.test/',
      },
    });

    const config = await loadRoutingDataConfig(path);

    expect(config.releasePath).toBe('swisstlm3d-2027/format-v3/ch');
    expect(config.geometryRoot).toBe(
      join(directory, 'data', 'work', 'swisstlm3d-2027', 'ch-geometry'),
    );
    expect(config.binaryReleaseRoot).toBe(
      join(
        directory,
        'data',
        'releases',
        'swisstlm3d-2027',
        'format-v3',
        'ch',
      ),
    );
    expect(config.buildDatabasePath).toBe(
      join(
        directory,
        'data',
        'work',
        'swisstlm3d-2027',
        'precomputed-binary-routing-build.sqlite',
      ),
    );
    expect(config.publication.prefix).toBe(
      'swisstlm3d-2027/format-v3/ch',
    );
    expect(config.publication.publicBaseUrl).toBe(
      'https://routing-data.example.test/swisstlm3d-2027/format-v3/ch',
    );
  });

  it('keeps explicit paths and publication values as advanced overrides', async () => {
    const { directory, path } = await writeConfig({
      datasetId: 'swisstlm3d-2027',
      formatId: 'format-v3',
      scope: 'ch',
      dataRoot: './data',
      sourceGeoPackage: './source/swisstlm3d.gpkg',
      geometryRoot: './custom/geometry',
      binaryReleaseRoot: './custom/release',
      buildDatabasePath: './custom/build.sqlite',
      publication: {
        prefix: 'custom/release',
        publicBaseUrl: 'https://example.test/custom/release/',
      },
    });

    const config = await loadRoutingDataConfig(path);

    expect(config.geometryRoot).toBe(join(directory, 'custom', 'geometry'));
    expect(config.binaryReleaseRoot).toBe(join(directory, 'custom', 'release'));
    expect(config.buildDatabasePath).toBe(
      join(directory, 'custom', 'build.sqlite'),
    );
    expect(config.publication.prefix).toBe('custom/release');
    expect(config.publication.publicBaseUrl).toBe(
      'https://example.test/custom/release',
    );
  });
});
