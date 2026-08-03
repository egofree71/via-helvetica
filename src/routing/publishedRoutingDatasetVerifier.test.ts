// @vitest-environment node
/**
 * Business context: prevents a routing release from being declared publicly
 * usable without checking the exact browser origin that will fetch its cells.
 */
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const VERIFIER = join(
  ROOT,
  'scripts',
  'verify-published-routing-dataset.mjs',
);

function verifyWith(argumentsList: string[]) {
  return spawnSync(process.execPath, [VERIFIER, ...argumentsList], {
    encoding: 'utf8',
  });
}

/**
 * Runs one verifier invocation with an explicit minimal configuration.
 * This keeps the test independent from the developer's ignored local config.
 */
function verifyWithIsolatedConfig(argumentsList: string[]) {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), 'via-helvetica-routing-verifier-'),
  );
  const configPath = join(temporaryDirectory, 'routing-data.config.json');
  writeFileSync(configPath, JSON.stringify({ publication: {} }), 'utf8');

  try {
    return verifyWith(['--config', configPath, ...argumentsList]);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

describe('published routing dataset verifier', () => {
  it('requires the browser origin whose CORS access must be verified', () => {
    const result = verifyWithIsolatedConfig([
      '--base-url',
      'https://routing-data.example.test/release',
      '--source',
      ROOT,
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('publication.publicOrigin');
  });

  it('rejects a URL with a path instead of an HTTP origin', () => {
    const result = verifyWithIsolatedConfig([
      '--base-url',
      'https://routing-data.example.test/release',
      '--source',
      ROOT,
      '--origin',
      'https://viahelvetica.ch/fr/',
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('valid HTTP(S) origin');
  });
});
