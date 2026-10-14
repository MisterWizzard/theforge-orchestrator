import { describe, expect, it } from 'vitest';
import type { Run, RunState, Task, TaskState } from '@theforge/contracts';
import {
  canTransitionRun,
  canTransitionTask,
  ForgeEngine,
  InMemoryForgeRepository,
} from './index.js';

const now = '2026-07-22T00:00:00.000Z';
const makeRun = (): Run => ({
  id: 'r1',
  projectId: 'p1',
  objective: 'Build a useful feature',
  constraints: [],
  state: 'created',
  budget: { maxUsd: 10, maxTokens: 1000 },
  spent: { usd: 0, tokens: 0 },
  createdAt: now,
  updatedAt: now,
});
const makeTask = (id: string, dependencies: string[] = []): Task => ({
  id,
  runId: 'r1',
  title: id,
  description: '',
  state: dependencies.length ? 'queued' : 'ready',
  priority: 0,
  dependencies,
  acceptanceCriteria: ['passes'],
  requiredCapabilities: [],
  fileOwnership: [],
  attempts: 0,
  maxAttempts: 3,
  createdAt: now,
  updatedAt: now,
});

describe('domain transitions', () => {
  it('covers every run state and rejects self transitions', () => {
    const states: RunState[] = [
      'created',
      'context_gathering',
      'planning',
      'critique',
      'plan_revision',
      'executing',
      'reviewing',
      'verifying',
      'repairing',
      'integrating',
      'paused',
      'blocked',
      'completed',
      'partially_completed',
      'cancelled',
      'failed',
    ];
    for (const state of states) expect(canTransitionRun(state, state)).toBe(false);
    expect(canTransitionRun('created', 'context_gathering')).toBe(true);
    expect(canTransitionRun('integrating', 'completed')).toBe(true);
    expect(canTransitionRun('executing', 'cancelled')).toBe(true);
    expect(canTransitionRun('completed', 'executing')).toBe(false);
  });
  it('covers every task state and rejects terminal escape', () => {
    const states: TaskState[] = [
      'queued',
      'ready',
      'in_progress',
      'blocked',
      'review',
      'verification',
      'done',
      'deferred',
      'cancelled',
    ];
    for (const state of states) expect(canTransitionTask(state, state)).toBe(false);
    expect(canTransitionTask('done', 'ready')).toBe(false);
  });
  it('makes commands idempotent', async () => {
    const repo = new InMemoryForgeRepository();
    await repo.putRun(makeRun());
    const engine = new ForgeEngine(repo);
    const first = await engine.transitionRun('r1', 'context_gathering', 'same-key');
    const second = await engine.transitionRun('r1', 'context_gathering', 'same-key');
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(repo.events).toHaveLength(1);
  });
  it('unblocks only tasks whose dependencies are done', async () => {
    const repo = new InMemoryForgeRepository();
    await repo.putRun(makeRun());
    const a = makeTask('a');
    const b = makeTask('b', ['a']);
    await repo.putTask(a);
    await repo.putTask(b);
    const engine = new ForgeEngine(repo);
    await engine.transitionTask('a', 'in_progress', 'a-start');
    await engine.transitionTask('a', 'done', 'a-done');
    const refreshed = await engine.refreshReadiness('r1');
    expect(refreshed.find((task) => task.id === 'b')?.state).toBe('ready');
  });
});
