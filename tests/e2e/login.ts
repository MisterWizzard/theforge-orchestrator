import { expect, type BrowserContext } from '@playwright/test';

import { operatorPassword, webOrigin } from './stack.js';

/**
 * Signs the browser context in through the real form on a throwaway page, so
 * a spec's own page starts with the `forge_session` cookie and still sees
 * exactly one document load (`form-persistence.spec.ts` counts them). Every
 * spec that reaches the dashboard goes through the login this way; there is
 * no back door that mints a cookie.
 */
export async function signIn(context: BrowserContext): Promise<void> {
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByLabel('Operator password').fill(operatorPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(`${webOrigin}/`);
  await page.close();
}
