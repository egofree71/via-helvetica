/**
 * Business context: configures the localized static application while keeping
 * offline routing-data workspaces outside Vite's runtime and production asset
 * graph. National source, intermediate, and release files are external data.
 */
import { cp, mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const PUBLIC_DIRECTORY = resolve('public');
const OUTPUT_DIRECTORY = resolve('dist');
const EXPERIMENTAL_ROUTING_DIRECTORY = 'routing-data';

/**
 * Copies normal public assets after a production build while deliberately
 * excluding any legacy routing experiment left below `public/`. National routing
 * releases are external and are loaded through their configured public URL.
 */
function copyProductionPublicAssets(): Plugin {
  return {
    name: 'copy-production-public-assets',
    apply: 'build',
    async closeBundle() {
      await mkdir(OUTPUT_DIRECTORY, { recursive: true });

      for (const entry of await readdir(PUBLIC_DIRECTORY, {
        withFileTypes: true,
      })) {
        if (entry.name === EXPERIMENTAL_ROUTING_DIRECTORY) {
          continue;
        }

        await cp(
          join(PUBLIC_DIRECTORY, entry.name),
          join(OUTPUT_DIRECTORY, entry.name),
          { recursive: entry.isDirectory(), force: true },
        );
      }
    },
  };
}

export default defineConfig(({ command }) => ({
  /*
   * The custom GitHub Pages domain serves Via Helvetica from the domain root.
   * Root-relative production assets keep https://viahelvetica.ch/ deployable.
   */
  base: '/',
  // Static routing experiments remain available only as a legacy local fallback.
  publicDir: command === 'serve' ? 'public' : false,
  plugins: [react(), copyProductionPublicAssets()],
  server: {
    /*
     * These paths should remain empty because national datasets live outside
     * the repository. Ignoring them is a safeguard against accidental legacy
     * generation blocking Vite startup or hot-module replacement.
     */
    watch: {
      ignored: [
        '**/.routing-work/**',
        '**/.routing-release/**',
        '**/.tmp-precomputed-binary-routing-compiler/**',
        '**/public/routing-data/**',
      ],
    },
  },
  build: {
    rolldownOptions: {
      // Each generated HTML file keeps its directory in dist for GitHub Pages.
      input: [
        'index.html',
        'fr/index.html',
        'de/index.html',
        'it/index.html',
        'en/index.html',
        'releases/index.html',
        'fr/releases/index.html',
        'de/releases/index.html',
        'it/releases/index.html',
        'en/releases/index.html',
      ],
    },
  },
}));
