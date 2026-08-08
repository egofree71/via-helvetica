/**
 * Business context: configures deterministic browser-like regression tests for
 * browser-facing domain modules plus the pure validation rules of the optional
 * GPX share Worker. JSDOM supplies the browser XML APIs used by local GPX parsing
 * without starting the application.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'workers/**/*.test.js'],
    clearMocks: true,
    restoreMocks: true,
  },
});
