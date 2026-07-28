import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  /*
   * The custom GitHub Pages domain serves Via Helvetica from the domain root.
   * Root-relative production assets keep https://viahelvetica.ch/ deployable.
   */
  base: '/',
  plugins: [react()],
  build: {
    rolldownOptions: {
      // Each generated HTML file keeps its directory in dist for GitHub Pages.
      input: [
        'index.html',
        'fr/index.html',
        'de/index.html',
        'it/index.html',
        'en/index.html',
      ],
    },
  },
});
