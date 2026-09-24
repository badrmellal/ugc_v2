import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 8181);
const chromiumPath = process.env.PW_CHROMIUM_PATH;

/**
 * End-to-end tests run the production build (web + server) in mock Gemini mode, so no API key is
 * needed: videos are synthesized locally with ffmpeg. Run `npm run build` first.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...(chromiumPath ? { launchOptions: { executablePath: chromiumPath } } : {}),
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'node server/dist/main.js',
    url: `http://127.0.0.1:${port}/healthz`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      ROLE: 'all',
      LOG_LEVEL: 'warn',
      GEMINI_MOCK: 'true',
      MOCK_TURN_SECONDS: '2',
      GEMINI_POLL_INTERVAL_SEC: '1',
      WORKER_POLL_INTERVAL_MS: '500',
      DATABASE_URL: process.env.E2E_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/omni_ugc_e2e',
      STORAGE_DRIVER: 'local',
      LOCAL_STORAGE_DIR: 'test-results/e2e-storage',
      WEB_DIST_DIR: 'web/dist',
      APP_PASSWORD: 'e2e-password',
      SESSION_SECRET: 'e2e-session-secret-0123456789-abcdefghij',
      CREATE_RATE_LIMIT_PER_HOUR: '500',
      RATE_LIMIT_PER_MINUTE: '2000',
    },
  },
});
