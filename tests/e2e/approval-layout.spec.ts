import { expect, test, type Page } from '@playwright/test';

import { signIn } from './login.js';

/**
 * An approval carries its exact action and scope as JSON, and the buttons that
 * decide it. Both used to overflow their card: the JSON ran past the edge and
 * the buttons hung off it (run page) or collapsed into a column of single
 * letters (home page). This feeds a deliberately long approval through the
 * browser's own routing, so no run, worker or spend is needed, and checks
 * geometry rather than appearance.
 */
const runId = 'f0e1d2c3-b4a5-4968-8776-655443322110';
const approval = {
  id: 'approval-layout-1',
  runId,
  actionClass: 'amber',
  actionDigest: 'd'.repeat(64),
  normalizedAction: JSON.stringify({
    executable: 'git',
    args: ['push', '--set-upstream', 'origin', `forge/${runId.slice(0, 8)}`],
    cwd: 'C:\\forge-demo\\managed\\worktrees\\f0e1d2c3-b4a5-4968-8776-655443322110-implementation',
    workerId: null,
  }),
  scope: JSON.stringify({
    repositoryUrl: 'https://github.com/example/a-repository-with-a-rather-long-name',
    baseRef: 'main',
    commit: '42a56a6c9fbbd218815521fe820bc759ce0faf55',
  }),
  status: 'pending',
  expiresAt: '2030-01-01T00:00:00.000Z',
};

async function expectContained(page: Page) {
  const card = page.locator('#approvals');
  await expect(card.getByText('git push --set-upstream origin forge/f0e1d2c3')).toBeVisible();
  // The raw JSON is behind a disclosure now, not the card's visible content.
  await expect(card.getByText('"executable"').first()).toBeHidden();

  const geometry = await card.evaluate((panel) => {
    const panelBox = panel.getBoundingClientRect();
    const outside = [...panel.querySelectorAll('.approval, .approval *')]
      .filter((element) => element.getClientRects().length > 0)
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return box.right > panelBox.right + 0.5 || box.left < panelBox.left - 0.5;
      })
      .map((element) => String(element.className || element.tagName));
    return { outside, scrollOverflow: panel.scrollWidth - panel.clientWidth };
  });
  expect(geometry.outside, 'elements outside the card').toEqual([]);
  expect(geometry.scrollOverflow).toBeLessThanOrEqual(0);

  for (const name of [/^Reject /, /^Approve /]) {
    const button = card.getByRole('button', { name });
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    // One line of text, not a column of single letters.
    expect(box?.height ?? 0).toBeLessThan(80);
  }
  const pageOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(pageOverflow, 'horizontal page scroll').toBeLessThanOrEqual(0);
}

test('the control centre approval inbox fits its card and keeps usable buttons', async ({
  context,
  page,
}) => {
  await signIn(context);
  await page.route('**/forge-api/approvals', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({ json: [approval] });
  });
  await page.goto('/');
  await expect(
    page.locator('#approvals').getByRole('heading', { name: 'Approval inbox' }),
  ).toBeVisible();
  await expectContained(page);
});

test('the run page approvals card fits its card and keeps usable buttons', async ({
  context,
  page,
}) => {
  await signIn(context);
  await page.route(`**/forge-api/runs/${runId}`, async (route) => {
    await route.fulfill({
      json: {
        run: {
          id: runId,
          objective: 'Add persisted notes with validation',
          state: 'partially_completed',
          budget: { maxUsd: 1 },
          spent: { usd: 0 },
        },
        tasks: [],
        events: [],
        approvals: [approval],
      },
    });
  });
  await page.route(`**/forge-api/runs/${runId}/events`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': ok\n\n' }),
  );
  await page.goto(`/runs/${runId}`);
  await expect(
    page.locator('#approvals').getByRole('heading', { name: 'Approvals' }),
  ).toBeVisible();
  await expectContained(page);
  // The exact stored action is still one click away for the person deciding.
  await page.locator('#approvals summary').click();
  await expect(page.locator('#approvals .approvalRaw pre')).toContainText('"executable": "git"');
});
