import { expect, test } from '@playwright/test';

import { signIn } from './login.js';
import { coordinatorOrigin, webOrigin, workerToken } from './stack.js';

test('sets up a repository and exposes durable, accessible live controls', async ({
  context,
  page,
  request,
}, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`.replace(/[^a-z0-9-]/gi, '-');
  const workerName = `Browser worker ${suffix}`;
  const objective = `Build a verified responsive notes feature ${suffix}`;
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await signIn(context);
  // Signed in (page.request carries the session cookie), a cross-origin
  // mutation is still refused by the proxy's own same-origin check.
  const crossOriginMutation = await page.request.post(`${webOrigin}/forge-api/projects`, {
    headers: { origin: 'https://attacker.invalid', 'sec-fetch-site': 'cross-site' },
    data: {},
  });
  expect(crossOriginMutation.status()).toBe(403);

  const registration = await request.post(`${coordinatorOrigin}/api/workers/register`, {
    headers: { authorization: `Bearer ${workerToken}` },
    data: {
      id: `browser-worker-${suffix}`,
      name: workerName,
      platform: 'linux',
      capabilities: ['git', 'node', 'browser'],
      policyProfile: 'default',
    },
  });
  expect(registration.status()).toBe(201);

  // Exercise setup and controls without allowing an authenticated local CLI to spend money.
  await page.route('**/forge-api/runs/*/start', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ accepted: true, mode: 'browser-verification' }),
    });
  });

  await page.goto('/');
  await expect(page.locator('main')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeAttached();
  await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Build runs' })).toBeVisible();
  await expect(page.locator('.status')).toContainText('Live');

  const providers = page.locator('#providers');
  await expect(providers.getByRole('heading', { name: 'Model adapters' })).toBeVisible();
  await expect(providers.getByText('claude', { exact: true })).toBeVisible();
  await expect(providers.getByText('codex', { exact: true })).toBeVisible();

  const workers = page.locator('#workers');
  await expect(workers.getByRole('heading', { name: 'Workers' })).toBeVisible();
  const worker = workers.locator('.diagnostic').filter({ hasText: workerName });
  await expect(worker).toBeVisible();
  await expect(worker.getByText(/online .* git, node, browser/i)).toBeVisible();

  const repository = page.getByLabel('Repository URL');
  const objectiveInput = page.getByLabel('What should be completed?');
  await page.getByRole('button', { name: /Ignite run/ }).click();
  await expect(repository).toBeFocused();
  expect(await repository.evaluate((input: HTMLInputElement) => input.validity.valueMissing)).toBe(
    true,
  );
  await repository.fill(process.cwd());
  await repository.press('Tab');
  await expect(objectiveInput).toBeFocused();
  expect(await objectiveInput.evaluate((input) => getComputedStyle(input).outlineStyle)).not.toBe(
    'none',
  );
  await objectiveInput.fill(objective);

  const projectResponsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/forge-api/projects' &&
      response.request().method() === 'POST',
  );
  const runResponsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/forge-api/runs' &&
      response.request().method() === 'POST',
  );
  const startResponsePromise = page.waitForResponse(
    (response) =>
      /\/forge-api\/runs\/[^/]+\/start$/.test(new URL(response.url()).pathname) &&
      response.request().method() === 'POST',
  );

  await page.getByRole('button', { name: /Ignite run/ }).click();
  const [projectResponse, runResponse, startResponse] = await Promise.all([
    projectResponsePromise,
    runResponsePromise,
    startResponsePromise,
  ]);
  expect(projectResponse.status()).toBe(201);
  expect(projectResponse.request().postDataJSON()).toMatchObject({
    repositoryUrl: process.cwd(),
    baseRef: 'main',
    checks: [{ executable: 'pnpm', args: ['check'] }],
  });
  expect(runResponse.status()).toBe(201);
  expect(runResponse.request().postDataJSON()).toMatchObject({
    objective,
    maxUsd: 5,
    maxTokens: 100000,
    configuration: {
      autonomyProfile: 'standard',
      timeLimitMinutes: 120,
      targetBranch: 'main',
      // The form's defaults: Claude for every role (ADR-024).
      providerRoles: {
        planner: 'claude',
        critic: 'claude',
        builder: 'claude',
        reviewer: 'claude',
      },
    },
  });
  expect(startResponse.status()).toBe(202);

  const run = page.getByRole('link', { name: new RegExp(objective) }).first();
  await expect(run).toBeVisible();
  await run.click();

  await expect(page.getByRole('heading', { name: objective })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible();
  await expect(page.getByText('4 tasks')).toBeVisible();
  const progress = page.getByRole('progressbar', { name: 'Completed tasks' });
  await expect(progress).toHaveAttribute('aria-valuemin', '0');
  await expect(progress).toHaveAttribute('aria-valuemax', '4');
  await expect(progress).toHaveAttribute('aria-valuenow', '0');
  await expect(page.getByText('run.created', { exact: true })).toBeVisible();

  const pauseResponsePromise = page.waitForResponse(
    (response) =>
      /\/forge-api\/runs\/[^/]+\/control$/.test(new URL(response.url()).pathname) &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Pause' }).click();
  expect((await pauseResponsePromise).status()).toBe(200);
  await expect(page.locator('.status')).toContainText('paused');
  await expect(page.getByText('run.pause', { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { name: objective })).toBeVisible();
  await expect(page.locator('.status')).toContainText('paused');
  await expect(page.getByText('run.pause', { exact: true })).toBeVisible();

  const cancelResponsePromise = page.waitForResponse(
    (response) =>
      /\/forge-api\/runs\/[^/]+\/control$/.test(new URL(response.url()).pathname) &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Cancel' }).click();
  expect((await cancelResponsePromise).status()).toBe(200);
  await expect(page.locator('.status')).toContainText('cancelled');
  await expect(page.getByText('run.cancel', { exact: true })).toBeVisible();

  await expect(page.getByRole('button', { name: 'Pause' })).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    ),
  ).toBe(true);
  expect(await page.locator('[data-nextjs-dialog]').count()).toBe(0);
  expect(pageErrors).toEqual([]);
});
