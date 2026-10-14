import { expect, test, type Page } from '@playwright/test';

import { operatorPassword, webOrigin } from './stack.js';

/**
 * The operator login (ADR-027) from the outside: what an unauthenticated
 * client sees, what a wrong and a right password do, what the cookie looks
 * like, and that logging out really ends the session. The failure throttle is
 * keyed on the client address, so the lockout test gives itself an address of
 * its own through `x-forwarded-for`; the desktop and mobile projects run at
 * the same time against one web server and must not lock each other out.
 */

async function noHorizontalScroll(page: Page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
  );
}

test('without a session every page redirects to /login and the API answers 401', async ({
  page,
  request,
}) => {
  const runs = await request.get(`${webOrigin}/forge-api/runs`);
  expect(runs.status()).toBe(401);
  expect(await runs.json()).toEqual({ error: 'operator_login_required' });
  expect(runs.headers()['cache-control']).toBe('no-store');

  // A mutation is refused for the missing session before its origin is even looked at.
  const mutation = await request.post(`${webOrigin}/forge-api/projects`, {
    headers: { origin: webOrigin, 'sec-fetch-site': 'same-origin' },
    data: {},
  });
  expect(mutation.status()).toBe(401);

  // Health stays open so a monitor can tell "web up" from "web down".
  const health = await request.get(`${webOrigin}/forge-api/health`);
  expect(health.status()).toBe(200);

  await page.goto('/settings');
  await expect(page).toHaveURL(`${webOrigin}/login?next=%2Fsettings`);
  await expect(page.getByRole('heading', { name: 'Operator sign-in' })).toBeVisible();
  await expect(page.getByLabel('Operator password')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(0);
  expect(await noHorizontalScroll(page)).toBe(true);

  await page.goto('/');
  await expect(page).toHaveURL(`${webOrigin}/login`);
});

test('a wrong password stays on /login with an error and no cookie', async ({ page }) => {
  await page.goto('/login?next=%2Fsettings');
  await page.getByLabel('Operator password').fill('definitely-not-the-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(`${webOrigin}/login?error=invalid&next=%2Fsettings`);
  // `.authError` rather than the alert role: Next's route announcer is a second alert.
  await expect(page.locator('.authError')).toContainText('That password is not right.');
  await expect(page.getByLabel('Operator password')).toBeVisible();
  expect((await page.context().cookies()).find((cookie) => cookie.name === 'forge_session')).toBe(
    undefined,
  );
  expect((await page.request.get(`${webOrigin}/forge-api/runs`)).status()).toBe(401);
});

test('the right password lands on the requested page with a hardened cookie; logging out ends it', async ({
  page,
}) => {
  await page.goto('/runs/does-not-matter');
  await expect(page).toHaveURL(`${webOrigin}/login?next=%2Fruns%2Fdoes-not-matter`);
  await page.getByLabel('Operator password').fill(operatorPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(`${webOrigin}/runs/does-not-matter`);

  const cookie = (await page.context().cookies()).find((item) => item.name === 'forge_session');
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', secure: false, path: '/' });
  expect(cookie?.value).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  // Twelve hours, give or take the seconds the test took.
  expect(cookie!.expires * 1000 - Date.now()).toBeGreaterThan(11.9 * 60 * 60 * 1000);
  expect(cookie!.expires * 1000 - Date.now()).toBeLessThanOrEqual(12 * 60 * 60 * 1000);

  // The proxy answers now, and the login form sends a signed-in operator home.
  expect((await page.request.get(`${webOrigin}/forge-api/runs`)).status()).toBe(200);
  await page.goto('/login');
  await expect(page).toHaveURL(`${webOrigin}/`);
  await expect(page.getByRole('heading', { name: 'Build runs' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Log out' })).toBeVisible();

  await page.getByRole('link', { name: 'Log out' }).click();
  await expect(page).toHaveURL(`${webOrigin}/login`);
  expect((await page.context().cookies()).find((item) => item.name === 'forge_session')).toBe(
    undefined,
  );
  expect((await page.request.get(`${webOrigin}/forge-api/runs`)).status()).toBe(401);
  await page.goto('/');
  await expect(page).toHaveURL(`${webOrigin}/login`);
});

test('the right password from a cold start lands on /', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Operator password').fill(operatorPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(`${webOrigin}/`);
  await expect(page.getByRole('heading', { name: 'Build runs' })).toBeVisible();
  await expect(page.locator('.status')).toContainText('Live');
  expect(await noHorizontalScroll(page)).toBe(true);
});

test('five wrong passwords lock that address out for a minute, and the right one is refused too', async ({
  page,
}, testInfo) => {
  // A source label of this attempt's own (the route treats it as opaque), so
  // the other project and any retry are not locked out with it.
  await page.context().setExtraHTTPHeaders({
    'x-forwarded-for': `e2e-${testInfo.project.name}-${testInfo.retry}-${Date.now()}`,
  });
  await page.goto('/login');
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await page.getByLabel('Operator password').fill(`wrong-password-attempt-${attempt}`);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(
      attempt < 5 ? `${webOrigin}/login?error=invalid` : `${webOrigin}/login?error=locked`,
    );
  }
  await expect(page.locator('.authError')).toContainText('Too many attempts');
  await page.getByLabel('Operator password').fill(operatorPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(`${webOrigin}/login?error=locked`);
  expect((await page.context().cookies()).find((item) => item.name === 'forge_session')).toBe(
    undefined,
  );
});

test('the login form refuses a cross-site submission', async ({ request }) => {
  const forged = await request.post(`${webOrigin}/login/session`, {
    headers: { origin: 'https://attacker.invalid', 'sec-fetch-site': 'cross-site' },
    form: { password: operatorPassword },
  });
  expect(forged.status()).toBe(403);
  expect(await forged.json()).toEqual({ error: 'same_origin_form_required' });
  const headless = await request.post(`${webOrigin}/login/session`, {
    form: { password: operatorPassword },
    maxRedirects: 0,
  });
  expect(headless.status()).toBe(403);
});
