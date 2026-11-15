import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@orchestrator/core': fileURLToPath(
        new URL('../packages/core/src/index.ts', import.meta.url),
      ),
      '@orchestrator/server': fileURLToPath(
        new URL('../packages/server/src/app.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
