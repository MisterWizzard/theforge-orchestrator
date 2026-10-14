import { randomUUID } from 'node:crypto';
import {
  AgentMessageSchema,
  ArtifactSchema,
  AttemptSchema,
  BlockerSchema,
  DecisionSchema,
  FindingSchema,
  RunSchema,
  TaskSchema,
  UsageRecordSchema,
} from '@theforge/contracts';
import { describe, expect, it } from 'vitest';
import { allowEventDeletion, createDatabase, PostgresForgeRepository } from './index.js';

const databaseUrl = process.env.DATABASE_URL;

describe('durable structured evidence', () => {
  it.runIf(Boolean(databaseUrl))(
    'stores correlated evidence idempotently and restores provider sessions',
    async () => {
      const sql = createDatabase(databaseUrl);
      const repository = new PostgresForgeRepository(sql);
      const suffix = randomUUID();
      const projectId = `evidence-project-${suffix}`;
      const runId = `evidence-run-${suffix}`;
      const taskId = `evidence-task-${suffix}`;
      const attemptId = `evidence-attempt-${suffix}`;
      const now = new Date().toISOString();

      try {
        await repository.ensureProject({
          id: projectId,
          name: 'Evidence fixture',
          repositoryUrl: 'https://example.invalid/evidence.git',
        });
        await repository.putRun(
          RunSchema.parse({
            id: runId,
            projectId,
            objective: 'Persist structured evidence',
            state: 'executing',
            budget: { maxUsd: 5, maxTokens: 10_000 },
            spent: { usd: 0, tokens: 0 },
            createdAt: now,
            updatedAt: now,
          }),
        );
        await repository.putTask(
          TaskSchema.parse({
            id: taskId,
            runId,
            title: 'Collect evidence',
            description: 'Store every normalized evidence type',
            state: 'in_progress',
            priority: 1,
            acceptanceCriteria: ['Evidence survives restart'],
            createdAt: now,
            updatedAt: now,
          }),
        );

        const attempt = AttemptSchema.parse({
          id: attemptId,
          taskId,
          provider: 'codex',
          workspacePath: 'C:/forge/worktree',
          state: 'running',
          startedAt: now,
        });
        await repository.upsertAttempt(attempt);
        await repository.setAttemptProviderSession(attemptId, 'provider-session-1');
        await repository.setAttemptProviderSession(attemptId, 'provider-session-1');

        const artifact = ArtifactSchema.parse({
          id: `artifact-${suffix}`,
          runId,
          taskId,
          attemptId,
          kind: 'test',
          label: 'Initial verification',
          uri: `forge://runs/${runId}/tests/1`,
          metadata: { command: 'pnpm test', code: 0 },
          createdAt: now,
        });
        await repository.upsertArtifact(artifact);
        await repository.upsertArtifact({ ...artifact, label: 'Verification' });

        const message = AgentMessageSchema.parse({
          id: `message-${suffix}`,
          runId,
          taskId,
          attemptId,
          type: 'review.finding',
          sender: { role: 'reviewer', provider: 'claude' },
          claim: 'The validation path is covered.',
          evidence: [artifact.id],
          criteria: ['Evidence survives restart'],
          confidence: 0.9,
          timestamp: now,
          idempotencyKey: `message-key-${suffix}`,
        });
        expect(await repository.appendMessage(message)).toBe(true);
        expect(await repository.appendMessage(message)).toBe(false);

        const finding = FindingSchema.parse({
          id: `finding-${suffix}`,
          runId,
          taskId,
          claim: 'A repair needs verification.',
          severity: 'medium',
          evidence: [artifact.id],
          affectedCriterion: 'Evidence survives restart',
          requestedAction: 'Rerun the check.',
          status: 'open',
        });
        await repository.upsertFinding(finding);
        await repository.upsertFinding({ ...finding, status: 'resolved' });

        const decision = DecisionSchema.parse({
          id: `decision-${suffix}`,
          runId,
          title: 'Use deterministic verification',
          rationale: 'It creates machine-verifiable evidence.',
          status: 'proposed',
          evidence: [artifact.id],
          createdAt: now,
        });
        await repository.upsertDecision(decision);
        await repository.upsertDecision({ ...decision, status: 'accepted' });

        const blocker = BlockerSchema.parse({
          id: `blocker-${suffix}`,
          runId,
          taskId,
          classification: 'transient',
          summary: 'The first verification attempt timed out.',
          evidence: [artifact.id],
          impact: 'Verification cannot finish yet.',
          attempts: ['Retried once'],
          smallestUnblockAction: 'Retry after backoff.',
          status: 'active',
        });
        await repository.upsertBlocker(blocker);
        await repository.upsertBlocker({ ...blocker, status: 'resolved' });

        const usage = UsageRecordSchema.parse({
          id: `usage-${suffix}`,
          runId,
          taskId,
          attemptId,
          provider: 'codex',
          model: 'fixture-model',
          inputTokens: 10,
          outputTokens: 5,
          costUsd: 0.01,
          elapsedMs: 50,
          tools: ['shell'],
          createdAt: now,
        });
        await repository.upsertUsageRecord(usage);
        await repository.upsertUsageRecord({ ...usage, outputTokens: 6, costUsd: 0.02 });

        await expect(repository.getAttempt(attemptId)).resolves.toMatchObject({
          id: attemptId,
          provider: 'codex',
          providerSessionId: 'provider-session-1',
        });
        await expect(repository.listAttempts(runId, taskId)).resolves.toHaveLength(1);
        await expect(repository.listMessages(runId, taskId)).resolves.toEqual([message]);
        await expect(repository.listFindings(runId, taskId)).resolves.toEqual([
          { ...finding, status: 'resolved' },
        ]);
        await expect(repository.listDecisions(runId)).resolves.toEqual([
          { ...decision, status: 'accepted' },
        ]);
        await expect(repository.listBlockers(runId, taskId)).resolves.toEqual([
          { ...blocker, status: 'resolved' },
        ]);
        await expect(repository.listArtifacts(runId, taskId)).resolves.toEqual([
          { ...artifact, label: 'Verification' },
        ]);
        await expect(repository.listUsageRecords(runId, taskId)).resolves.toEqual([
          { ...usage, outputTokens: 6, costUsd: 0.02 },
        ]);
      } finally {
        // Deleting a run cascades through the append-only events guard (006).
        await sql.begin(async (tx) => {
          await allowEventDeletion(tx);
          await tx`delete from runs where id=${runId}`;
        });
        await sql`delete from projects where id=${projectId}`;
        await sql.end();
      }
    },
    30_000,
  );
});
