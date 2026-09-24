import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Unit tests cover pure helpers only, so they run in Node without the React/Tailwind plugins.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(import.meta.dirname, '../server/src/shared'),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
