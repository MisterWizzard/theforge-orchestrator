import type { Run, Task } from '@theforge/contracts';
import { OrchestrationRun } from './index.js';
const now = new Date().toISOString();
const run: Run = {
  id: 'demo-run',
  projectId: 'demo',
  objective: 'Add a persisted notes feature with validation, tests, and a polished responsive UI.',
  constraints: ['no destructive actions'],
  state: 'created',
  budget: { maxUsd: 5, maxTokens: 100000 },
  spent: { usd: 0, tokens: 0 },
  createdAt: now,
  updatedAt: now,
};
const names = ['context', 'backend', 'frontend', 'review'];
const tasks: Task[] = names.map((name, index) => ({
  id: `demo-${name}`,
  runId: run.id,
  title: name,
  description: `Complete ${name}`,
  state: index === 0 ? 'ready' : 'queued',
  priority: names.length - index,
  dependencies: index ? [`demo-${names[index - 1]}`] : [],
  acceptanceCriteria: ['verified'],
  requiredCapabilities: [],
  fileOwnership: [],
  attempts: 0,
  maxAttempts: 3,
  createdAt: now,
  updatedAt: now,
}));
const report = await new OrchestrationRun(run, tasks).execute();
console.log(JSON.stringify(report, null, 2));
