import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** Where the dev server forwards API calls. The API server listens on PORT (default 8080). */
const apiTarget = process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@shared': path.resolve(import.meta.dirname, '../server/src/shared'),
    },
  },
  server: {
    port: 5173,
    // The Host header is kept (no changeOrigin) so the API's same-origin check on mutating requests passes.
    proxy: {
      '/api': { target: apiTarget },
      '/healthz': { target: apiTarget },
      '/readyz': { target: apiTarget },
    },
  },
  preview: {
    proxy: {
      '/api': { target: apiTarget },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
});
