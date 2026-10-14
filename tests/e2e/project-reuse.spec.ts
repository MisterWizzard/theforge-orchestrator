import { expect, test, type Page } from '@playwright/test';

import { signIn } from './login.js';

/**
 * Submitting the form twice for the same repository used to mint a fresh
 * `project-<ms>` id each time, so the dropdown filled with same-name entries.
 * The dashboard now reuses the project it already knows for that URL, both
 * from its own state straight after registration and from the polled list.
 */

async function submitAndCapture(page: Page) {
  const projectResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/forge-api/projects' &&
      response.request().method() === 'POST',
  );
  const runResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/forge-api/runs' &&
      response.request().method() === 'POST',
  );
  const startResponse = page.waitForResponse(
    (response) =>
      /\/forge-api\/runs\/[^/]+\/start$/.test(new URL(response.url()).pathname) &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: /Ignite run/ }).click();
  const [project, run, start] = await Promise.all([projectResponse, runResponse, startResponse]);
  expect(project.status()).toBe(201);
  expect(run.status()).toBe(201);
  expect(start.status()).toBe(202);
  await expect(page.getByRole('button', { name: /Ignite run/ })).toBeEnabled();
  return (project.request().postDataJSON() as { id: string; repositoryUrl: string }).id;
}

test('re-submitting the same repository reuses the registered project', async ({
  context,
  page,
}, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`.replace(/[^a-z0-9-]/gi, '-');
  const repositoryUrl = `C:\\forge\\e2e\\reuse-${suffix}`;
  await signIn(context);
  // Exercise setup without allowing an authenticated local CLI to spend money.
  await page.route('**/forge-api/runs/*/start', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ accepted: true, mode: 'browser-verification' }),
    });
  });

  await page.clock.install();
  await page.goto('/');
  await expect(page.locator('.status')).toContainText('Live');
  await page.getByLabel('Repository URL').fill(repositoryUrl);
  await page.getByLabel('What should be completed?').fill(`Reuse the project ${suffix}`);

  const firstId = await submitAndCapture(page);
  expect(firstId).toMatch(/^project-\d+$/);
  // Straight after registration, before any poll, the same URL must not mint a new id.
  expect(await submitAndCapture(page)).toBe(firstId);

  // After the poll replaces the list with the coordinator's, still one entry, still reused.
  const projectsPoll = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/forge-api/projects' &&
      response.request().method() === 'GET',
  );
  await page.clock.runFor(15_500);
  expect((await projectsPoll).status()).toBe(200);
  const options = page.getByLabel('Existing project').locator('option', {
    hasText: `reuse-${suffix}`,
  });
  await expect(options).toHaveCount(1);
  await expect(options).toHaveAttribute('value', firstId);
  expect(await submitAndCapture(page)).toBe(firstId);
});
