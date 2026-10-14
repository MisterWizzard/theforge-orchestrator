/**
 * The e2e stack is private to Playwright: its own coordinator and web server on
 * ports no `pnpm dev` stack uses, started fresh for every run and never reused,
 * with no PostgreSQL or Redis behind them. Every spec and the config read the
 * origins and tokens from here so they cannot drift apart.
 */
export const coordinatorPort = 4410;
export const webPort = 3010;
export const coordinatorOrigin = `http://127.0.0.1:${coordinatorPort}`;
export const webOrigin = `http://127.0.0.1:${webPort}`;
export const workerToken = 'playwright-worker-token-that-is-long-enough';
export const coordinatorToken = 'playwright-coordinator-token-that-is-long-enough';
/** The operator password the e2e web server is started with (ADR-027); a fixed dummy, never a real one. */
export const operatorPassword = 'playwright-operator-password-that-is-long-enough';
