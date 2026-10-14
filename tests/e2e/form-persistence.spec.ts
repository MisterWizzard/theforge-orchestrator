import { expect, test, type Page, type TestInfo } from '@playwright/test';

import { signIn } from './login.js';
import { coordinatorOrigin, coordinatorToken } from './stack.js';

/**
 * The handoff reported the new-run form "resetting under live updates". The
 * dashboard has no live channel of its own: its only refresh is a 15 s poll
 * that writes list state, and the run page's EventSource triggers a refetch of
 * run data. These tests pin the form and the run page through exactly those
 * paths and assert that nothing the user typed, selected or attached to the DOM
 * is lost, and that neither component remounts nor the document navigates.
 */

declare global {
  interface Window {
    __forgeEventSources?: number;
    __forgeDocumentToken?: string;
  }
}

const authorization = { authorization: `Bearer ${coordinatorToken}` };

async function pollDashboardOnce(page: Page) {
  const projectsPoll = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/forge-api/projects' &&
      response.request().method() === 'GET',
  );
  const runsPoll = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/forge-api/runs' &&
      response.request().method() === 'GET',
  );
  // The dashboard polls on a 15 s interval; the installed clock fires it now.
  await page.clock.runFor(15_500);
  const [projects, runs] = await Promise.all([projectsPoll, runsPoll]);
  expect(projects.status()).toBe(200);
  expect(runs.status()).toBe(200);
}

type DocumentTracker = { loads: number; navigations: string[] };

/**
 * `load` fires once per document; `framenavigated` also fires for same-document
 * history updates (Next's router replaces state on hydration), so it is kept
 * for the record only.
 */
function trackDocument(page: Page): DocumentTracker {
  const tracker: DocumentTracker = { loads: 0, navigations: [] };
  page.on('load', () => (tracker.loads += 1));
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) tracker.navigations.push(frame.url());
  });
  return tracker;
}

async function stampDocument(page: Page) {
  await page.evaluate(() => {
    window.__forgeDocumentToken = 'stamped';
  });
}

/** The document that was stamped is still the one on screen: no full navigation happened. */
async function expectSameDocument(page: Page, tracker: DocumentTracker, testInfo: TestInfo) {
  testInfo.annotations.push({
    type: 'framenavigated',
    description: `${tracker.navigations.length}: ${tracker.navigations.join(' -> ')}`,
  });
  expect(tracker.loads).toBe(1);
  expect(await page.evaluate(() => window.__forgeDocumentToken)).toBe('stamped');
}

test('a new-repository form survives a poll tick untouched', async ({
  context,
  page,
}, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`.replace(/[^a-z0-9-]/gi, '-');
  await signIn(context);
  const tracker = trackDocument(page);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.clock.install();
  await page.goto('/');
  await expect(page.locator('.status')).toContainText('Live');
  await stampDocument(page);
  const form = page.locator('form.newRun');

  const repository = page.getByLabel('Repository URL');
  const objective = page.getByLabel('What should be completed?');
  const branch = page.getByLabel('Target branch');
  const check = page.getByLabel('Required check');
  const usd = page.getByLabel('USD limit');
  const tokens = page.getByLabel('Token limit');
  const minutes = page.getByLabel('Time limit (minutes)');
  const autonomy = page.getByLabel('Autonomy');
  const planner = page.getByLabel('Planner');

  await repository.fill(`C:\\forge\\e2e\\persist-${suffix}`);
  await objective.fill(`Keep every field across a poll ${suffix}`);
  await branch.fill('feature/persistence');
  await check.fill('pnpm test');
  await usd.fill('42.5');
  await tokens.fill('123456');
  await minutes.fill('45');
  await autonomy.selectOption('high');
  // Away from the default (claude, ADR-024), so a reset would be visible.
  await planner.selectOption('codex');
  await form.evaluate((element) => element.setAttribute('data-e2e-marker', `alive`));

  await pollDashboardOnce(page);

  await expect(form).toHaveAttribute('data-e2e-marker', 'alive');
  await expect(repository).toHaveValue(`C:\\forge\\e2e\\persist-${suffix}`);
  await expect(repository).toBeEnabled();
  await expect(objective).toHaveValue(`Keep every field across a poll ${suffix}`);
  await expect(branch).toHaveValue('feature/persistence');
  await expect(check).toHaveValue('pnpm test');
  await expect(usd).toHaveValue('42.5');
  await expect(tokens).toHaveValue('123456');
  await expect(minutes).toHaveValue('45');
  await expect(autonomy).toHaveValue('high');
  await expect(planner).toHaveValue('codex');
  await expect(page.getByLabel('Existing project')).toHaveValue('');
  await expectSameDocument(page, tracker, testInfo);
  expect(pageErrors).toEqual([]);
});

test('a selected existing project and its edits survive a poll tick', async ({
  context,
  page,
  request,
}, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`.replace(/[^a-z0-9-]/gi, '-');
  await signIn(context);
  const projectId = `persist-project-${suffix}`;
  const repositoryUrl = `C:\\forge\\e2e\\registered-${suffix}`;
  const registration = await request.post(`${coordinatorOrigin}/api/projects`, {
    headers: authorization,
    data: {
      id: projectId,
      name: `Persistence fixture ${suffix}`,
      repositoryUrl,
      baseRef: 'develop',
      checks: [{ executable: 'pnpm', args: ['lint'] }],
    },
  });
  expect(registration.status()).toBe(201);
  const tracker = trackDocument(page);

  await page.clock.install();
  await page.goto('/');
  await expect(page.locator('.status')).toContainText('Live');
  await stampDocument(page);
  const form = page.locator('form.newRun');
  const select = page.getByLabel('Existing project');
  const repository = page.getByLabel('Repository URL');
  const objective = page.getByLabel('What should be completed?');
  const branch = page.getByLabel('Target branch');
  const usd = page.getByLabel('USD limit');

  await select.selectOption(projectId);
  await expect(repository).toHaveValue(repositoryUrl);
  await expect(repository).toBeDisabled();
  await expect(branch).toHaveValue('develop');
  await expect(page.getByLabel('Required check')).toHaveValue('pnpm lint');
  await objective.fill(`Run against the registered project ${suffix}`);
  await branch.fill('release/persistence');
  await usd.fill('7.25');
  await form.evaluate((element) => element.setAttribute('data-e2e-marker', 'alive'));

  await pollDashboardOnce(page);

  await expect(form).toHaveAttribute('data-e2e-marker', 'alive');
  await expect(select).toHaveValue(projectId);
  await expect(repository).toHaveValue(repositoryUrl);
  await expect(repository).toBeDisabled();
  await expect(objective).toHaveValue(`Run against the registered project ${suffix}`);
  await expect(branch).toHaveValue('release/persistence');
  await expect(usd).toHaveValue('7.25');
  await expectSameDocument(page, tracker, testInfo);
});

test('the run page refetches on a control event without remounting', async ({
  context,
  page,
  request,
}, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`.replace(/[^a-z0-9-]/gi, '-');
  await signIn(context);
  const projectId = `persist-run-project-${suffix}`;
  const objective = `Refetch without remount ${suffix}`;
  expect(
    (
      await request.post(`${coordinatorOrigin}/api/projects`, {
        headers: authorization,
        data: { id: projectId, name: `Run page fixture ${suffix}`, repositoryUrl: process.cwd() },
      })
    ).status(),
  ).toBe(201);
  const created = await request.post(`${coordinatorOrigin}/api/runs`, {
    headers: authorization,
    data: { projectId, objective, maxUsd: 1, maxTokens: 1000 },
  });
  expect(created.status()).toBe(201);
  const { run } = (await created.json()) as { run: { id: string } };
  const tracker = trackDocument(page);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  // Count EventSource constructions: a remounted RunDetail would open a second stream.
  await page.addInitScript(() => {
    window.__forgeEventSources = 0;
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        window.__forgeEventSources = (window.__forgeEventSources ?? 0) + 1;
      }
    };
  });
  let detailRequests = 0;
  page.on('request', (item) => {
    if (
      item.method() === 'GET' &&
      new URL(item.url()).pathname === `/forge-api/runs/${encodeURIComponent(run.id)}`
    )
      detailRequests += 1;
  });

  await page.goto(`/runs/${run.id}`);
  await expect(page.getByRole('heading', { name: objective })).toBeVisible();
  await expect(page.getByText('run.created', { exact: true })).toBeVisible();
  await stampDocument(page);
  const summary = page.locator('.runSummary');
  await summary.evaluate((element) => element.setAttribute('data-e2e-marker', 'alive'));
  const requestsBeforeControl = detailRequests;
  expect(await page.evaluate(() => window.__forgeEventSources)).toBe(1);

  const controlResponse = page.waitForResponse(
    (response) =>
      /\/forge-api\/runs\/[^/]+\/control$/.test(new URL(response.url()).pathname) &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Pause' }).click();
  expect((await controlResponse).status()).toBe(200);
  // `run.pause` reaches the timeline only through the SSE-triggered refetch.
  await expect(page.getByText('run.pause', { exact: true })).toBeVisible();
  await expect(page.locator('.status')).toContainText('paused');

  expect(detailRequests).toBeGreaterThan(requestsBeforeControl);
  await expect(summary).toHaveAttribute('data-e2e-marker', 'alive');
  expect(await page.evaluate(() => window.__forgeEventSources)).toBe(1);
  await expect(page.getByRole('heading', { name: objective })).toBeVisible();
  await expectSameDocument(page, tracker, testInfo);
  expect(pageErrors).toEqual([]);
});
