import type { Run, Task } from '@theforge/contracts';
export const fixtureTime = '2026-07-22T00:00:00.000Z';
export function fixtureRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-fixture',
    projectId: 'project-fixture',
    objective:
      'Add a persisted notes feature with validation, tests, and a polished responsive UI.',
    constraints: [],
    state: 'created',
    budget: { maxUsd: 5, maxTokens: 100000 },
    spent: { usd: 0, tokens: 0 },
    createdAt: fixtureTime,
    updatedAt: fixtureTime,
    ...overrides,
  };
}
export function fixtureTask(
  id: string,
  dependencies: string[] = [],
  overrides: Partial<Task> = {},
): Task {
  return {
    id,
    runId: 'run-fixture',
    title: id,
    description: id,
    state: dependencies.length ? 'queued' : 'ready',
    priority: 10 - dependencies.length,
    dependencies,
    acceptanceCriteria: ['Tests pass', 'Evidence recorded'],
    requiredCapabilities: ['git'],
    fileOwnership: [],
    attempts: 0,
    maxAttempts: 3,
    createdAt: fixtureTime,
    updatedAt: fixtureTime,
    ...overrides,
  };
}
