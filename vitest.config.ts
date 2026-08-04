/**
 * Business context: configures deterministic browser-like regression tests for
 * pure route, GPX, metric, and transport-domain modules. JSDOM supplies the
 * browser XML APIs used by local GPX parsing without starting the application.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    clearMocks: true,
    restoreMocks: true,
  },
});
