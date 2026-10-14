/**
 * Tier 0 CLI.
 *
 * Verification is the default and merging must be asked for explicitly:
 * `--execute` is the only way anything is changed. A tool that can merge is one
 * flag away from a tool that merges by accident.
 *
 * Every run also writes its outcomes as JSON - to `--json=<path>` when given,
 * otherwise under the outbox - so `pnpm forge tier0-ingest <file>` can turn
 * merges and escalations into notifications and nothing is lost to scrollback.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listCandidates,
  runCommand,
  verifyPullRequest,
  type PullRequestOutcome,
} from './runner.js';
import { DEFAULT_CONFIG } from './policy.js';
import { outcomeReportPath, toOutcomeRecord, writeOutcomeReport } from './report.js';

const args = process.argv.slice(2);
const repository = args.find((a) => !a.startsWith('--'));
const execute = args.includes('--execute');
const limit = Number(args.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? '50');
const checks = (args.find((a) => a.startsWith('--checks='))?.split('=')[1] ?? 'test,lint')
  .split(',')
  .filter(Boolean);
// Restrict to specific pull requests, in the order given. Useful when merges
// must be sequenced deliberately - for example highest-severity first, because
// every dependency PR touches the lockfile and only the first will apply
// cleanly before the rest need rebasing.
const only = (args.find((a) => a.startsWith('--only='))?.split('=')[1] ?? '')
  .split(',')
  .map((n) => Number(n.trim()))
  .filter((n) => Number.isInteger(n) && n > 0);
const jsonArgument = args.find((a) => a.startsWith('--json='))?.slice('--json='.length);

if (!repository) {
  console.error(
    'usage: tier0 <owner/repo> [--checks=test,lint] [--limit=N] [--only=1,2] [--json=path] [--execute]',
  );
  process.exit(2);
}

const log = (line: string) => console.log(line);

const discovered = await listCandidates(repository, limit);
const candidates = only.length
  ? only
      .map((n) => discovered.find((pr) => pr.number === n))
      .filter((pr): pr is NonNullable<typeof pr> => pr !== undefined)
  : discovered;
console.log(`\nTier 0 — ${repository}`);
console.log(`${candidates.length} open pull requests · checks: ${checks.join(', ')}`);
console.log(execute ? 'MODE: EXECUTE (merges will happen)' : 'MODE: dry run (nothing will change)');
console.log(
  DEFAULT_CONFIG.mergeAllowlist.includes(repository)
    ? 'merge allowlist: this repository IS allowlisted'
    : 'merge allowlist: this repository is NOT allowlisted — verify only',
);

const outcomes: PullRequestOutcome[] = [];
for (const pr of candidates) {
  console.log(`\n#${pr.number} ${pr.title}`);
  const outcome = await verifyPullRequest(pr, { repository, checks, execute, onLog: log });
  outcomes.push(outcome);
  const failed = outcome.checks.filter((c) => c.exitCode !== 0).map((c) => c.name);
  console.log(
    `  -> ${outcome.decision.action.toUpperCase()}${outcome.merged ? ' (merged)' : ''} · ${outcome.decision.reason}`,
  );
  if (failed.length) console.log(`     failed: ${failed.join(', ')}`);
  if ('hint' in outcome.decision && outcome.decision.hint)
    console.log(`     hint: ${outcome.decision.hint}`);
}

const by = (action: string) => outcomes.filter((o) => o.decision.action === action).length;
console.log(
  `\nsummary: ${by('merge')} merge · ${by('verify-only')} verify-only · ${by('escalate')} escalate · ${by('deferred')} deferred · ${by('skip')} skip`,
);
console.log(`merged: ${outcomes.filter((o) => o.merged).length}`);

// Provenance: which TheForge commit made these decisions. The repository root
// is two levels above this file's directory; the working directory may not be.
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
const head = await runCommand('git', ['rev-parse', 'HEAD'], repositoryRoot);
const tier0Commit = head.exitCode === 0 ? head.output.trim() : 'unknown';
const mode = execute ? 'execute' : 'dry-run';
const reportPath = jsonArgument ? resolve(jsonArgument) : outcomeReportPath(process.env);
await writeOutcomeReport(
  reportPath,
  outcomes.map((outcome) => toOutcomeRecord(outcome, mode, tier0Commit)),
);
console.log(`outcomes: ${reportPath}`);
console.log(`ingest with: pnpm forge tier0-ingest ${reportPath}`);
