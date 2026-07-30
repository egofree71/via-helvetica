/**
 * Business context: configures the localized static application and ensures
 * developer-only routing datasets can be served by Vite without ever entering
 * the production GitHub Pages artifact.
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
 * excluding generated routing experiments. Development keeps Vite's standard
 * public directory so `/routing-data/...` remains available for local tests.
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
  // Static routing experiments remain available only to the development server.
  publicDir: command === 'serve' ? 'public' : false,
  plugins: [react(), copyProductionPublicAssets()],
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
