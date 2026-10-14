import { defineConfig, devices } from '@playwright/test';
import {
  coordinatorOrigin,
  coordinatorPort,
  coordinatorToken,
  operatorPassword,
  webOrigin,
  webPort,
  workerToken,
} from './tests/e2e/stack.js';

/**
 * The e2e run is hermetic. Playwright merges `process.env` into every web
 * server's environment, so a `DATABASE_URL` or `REDIS_URL` exported in the
 * developer's shell would otherwise reach the coordinator, which opens
 * PostgreSQL whenever the variable is set (`FORGE_VOLATILE_MODE` only relaxes
 * the startup guard). Both are blanked here explicitly: the coordinator's
 * environment parser treats an empty value as unset. The servers are never
 * reused and sit on ports a `pnpm dev` stack does not use, so a database-backed
 * dev coordinator can be neither reused nor collided with.
 */
export default defineConfig({
  testDir: './tests/e2e',
  retries: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: webOrigin,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
  ],
  webServer: [
    {
      command:
        'pnpm exec turbo run build --filter=@theforge/coordinator && node apps/coordinator/dist/server.js',
      url: `${coordinatorOrigin}/health`,
      timeout: 120_000,
      env: {
        DATABASE_URL: '',
        REDIS_URL: '',
        PORT: String(coordinatorPort),
        FORGE_WORKER_TOKEN: workerToken,
        FORGE_COORDINATOR_TOKEN: coordinatorToken,
        FORGE_WEB_ORIGIN: webOrigin,
        FORGE_VOLATILE_MODE: 'true',
      },
      reuseExistingServer: false,
    },
    {
      command: `pnpm exec turbo run build --filter=@theforge/web && pnpm --filter @theforge/web exec next start -H 127.0.0.1 -p ${webPort}`,
      url: webOrigin,
      timeout: 120_000,
      env: {
        FORGE_API_URL: coordinatorOrigin,
        FORGE_COORDINATOR_TOKEN: coordinatorToken,
        FORGE_WEB_ORIGIN: webOrigin,
        FORGE_WEB_OPERATOR_PASSWORD: operatorPassword,
        FORGE_WEB_SESSION_SECRET: '',
      },
      reuseExistingServer: false,
    },
  ],
});
