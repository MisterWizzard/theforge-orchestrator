/* global console, process */
/**
 * One-off purge of test-fixture rows from a development database.
 *
 *   DATABASE_URL=postgres://forge:forge@127.0.0.1:5432/forge \
 *     node tests/fixtures/purge-fixtures.mjs                 # dry run (default): preview only
 *     node tests/fixtures/purge-fixtures.mjs --execute --yes # delete, in one transaction
 *
 * Before PR #13 the vitest suites ran against the shared `public` schema with
 * fixed ids and no cleanup, and Playwright reused whatever coordinator was on
 * :4400, so both left projects, runs, workers and queued jobs behind. Every
 * suite now gets its own schema and the e2e stack has no database, so this is
 * a one-off sweep of what those left, not a maintenance task.
 *
 * What it removes, in this order and in a single transaction:
 *   1. runs owned by a vitest fixture project, or whose objective matches the
 *      Playwright objective; tasks, attempts, events, messages, findings,
 *      decisions, blockers, approvals, artifacts, usage records and worker jobs
 *      follow through `on delete cascade`;
 *   2. fixture projects, and projects that only ever held e2e runs, once no
 *      run of theirs remains (`runs.project_id` does not cascade);
 *   3. fixture workers, and any worker without a heartbeat for 24 h that holds
 *      no lease; a worker still referenced by a surviving job is kept because
 *      `worker_jobs.worker_id` is a plain foreign key;
 *   4. queued worker jobs whose run no longer exists (defensive: the foreign
 *      key makes this impossible today).
 *
 * It never touches the projects named in PROTECTED_PROJECT_NAMES or any run of
 * theirs, whatever the run's objective looks like, and it rolls back if their
 * row counts change inside the transaction. `--execute` without `--yes` prints
 * the preview and refuses.
 *
 * If the events table carries a hash-chain guard that requires the session
 * setting `forge.allow_event_delete`, the transaction sets it first (inside a
 * savepoint, so an unrecognised parameter cannot poison the transaction).
 *
 * The coordinator serves projects, runs and workers from in-memory maps that
 * are hydrated once at startup, so a running coordinator keeps listing purged
 * rows until it is restarted. Restart it after `--execute`.
 */
import { parseArgs } from 'node:util';
import { createDatabase } from '@theforge/db';

const PROTECTED_PROJECT_NAMES = ['TheForge', 'acceptance-fixture'];
// apps/coordinator/src/server.test.ts and tests/worker-loss.integration.test.ts
const FIXTURE_PROJECT_NAMES = [
  'Worker loss fixture',
  'Fixture',
  'Worker fixture',
  'Provider job',
  'Halt fixture',
  'Patch cap',
];
const FIXTURE_PROJECT_IDS = [
  'fixture',
  'worker-fixture-project',
  'provider-job-project',
  'halt-fixture-project',
  'patch-cap-project',
];
const FIXTURE_PROJECT_ID_PATTERNS = ['loss-project-%', 'halt-fixture-project-%'];
// tests/e2e/control-centre.spec.ts
const E2E_OBJECTIVE_PATTERN = 'Build a verified responsive notes feature %';
// apps/coordinator/src/server.test.ts, packages/workflows/src/workflows.test.ts,
// tests/worker-loss.integration.test.ts and tests/e2e/control-centre.spec.ts
const FIXTURE_WORKER_IDS = [
  'w',
  'worker-session-fixture',
  'worker-halt-fixture',
  'provider-worker-fixture',
  'patch-cap-worker-fixture',
];
const FIXTURE_WORKER_ID_PATTERNS = ['browser-worker-%', 'loss-worker-%', 'worker-halt-fixture-%'];
const STALE_WORKER_HOURS = 24;
const COUNTED_TABLES = ['projects', 'runs', 'workers', 'worker_jobs', 'tasks', 'events'];
const RUN_CHILD_TABLES = [
  'tasks',
  'events',
  'messages',
  'findings',
  'decisions',
  'blockers',
  'approvals',
  'artifacts',
  'usage_records',
  'worker_jobs',
];

const { values: options } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    execute: { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
  },
  strict: true,
});
if (options['dry-run'] && options.execute) {
  fail('--dry-run and --execute are mutually exclusive');
}
const execute = options.execute === true;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || !/^postgres(ql)?:/.test(databaseUrl)) {
  fail(
    'DATABASE_URL must be an absolute PostgreSQL URL.\n' +
      'Example: DATABASE_URL=postgres://forge:forge@127.0.0.1:5432/forge',
  );
}

const sql = createDatabase(databaseUrl);
try {
  const before = await countRows(sql);
  const plan = await previewPurge(sql);
  printPreview(plan, before);

  if (!execute) {
    console.log('\nDry run: nothing was deleted. Re-run with --execute --yes to apply.');
  } else if (!options.yes) {
    console.error('\nRefusing to delete without an explicit --yes.');
    process.exitCode = 2;
  } else {
    const deleted = await applyPurge(sql, plan);
    const after = await countRows(sql);
    console.log('\nDeleted:');
    for (const [what, count] of Object.entries(deleted)) console.log(`  ${what}: ${count}`);
    console.log('\nRow counts (before -> after):');
    for (const table of COUNTED_TABLES) {
      console.log(`  ${table.padEnd(12)} ${String(before[table]).padStart(5)} -> ${after[table]}`);
    }
    console.log(
      '\nRestart the coordinator: it hydrates projects, runs and workers into memory at startup and will keep serving the purged rows until then.',
    );
  }
} finally {
  await sql.end({ timeout: 5 });
}

async function previewPurge(sql) {
  const protectedProjects = await sql`
    select id, name from projects where name = any(${PROTECTED_PROJECT_NAMES}::text[])
    order by name, id`;
  const protectedIds = protectedProjects.map((project) => project.id);
  const [{ count: protectedRunCount }] = await sql`
    select count(*)::int as count from runs where project_id = any(${protectedIds}::text[])`;

  const runs = await sql`
    select r.id, r.project_id, p.name as project_name, r.objective, r.state,
      case
        when p.name = any(${FIXTURE_PROJECT_NAMES}::text[])
          or p.id = any(${FIXTURE_PROJECT_IDS}::text[])
          or p.id like any(${FIXTURE_PROJECT_ID_PATTERNS}::text[])
        then 'vitest fixture project ' || quote_literal(p.name)
        else 'e2e objective'
      end as reason
    from runs r join projects p on p.id = r.project_id
    where p.id <> all(${protectedIds}::text[])
      and (
        p.name = any(${FIXTURE_PROJECT_NAMES}::text[])
        or p.id = any(${FIXTURE_PROJECT_IDS}::text[])
        or p.id like any(${FIXTURE_PROJECT_ID_PATTERNS}::text[])
        or r.objective like ${E2E_OBJECTIVE_PATTERN}
      )
    order by r.created_at`;
  const runIds = runs.map((run) => run.id);
  const e2eProjectIds = [
    ...new Set(runs.filter((run) => run.reason === 'e2e objective').map((run) => run.project_id)),
  ];

  const keptProtectedRuns = await sql`
    select r.id, p.name as project_name, r.objective
    from runs r join projects p on p.id = r.project_id
    where p.id = any(${protectedIds}::text[]) and r.objective like ${E2E_OBJECTIVE_PATTERN}
    order by r.created_at`;

  const cascades = [];
  for (const table of RUN_CHILD_TABLES) {
    const [{ count }] = await sql`
      select count(*)::int as count from ${sql(table)} where run_id = any(${runIds}::text[])`;
    cascades.push({ table, count });
  }
  const [{ count: attemptCount }] = await sql`
    select count(*)::int as count from attempts
    where task_id in (select id from tasks where run_id = any(${runIds}::text[]))`;
  cascades.push({ table: 'attempts', count: attemptCount });

  const projects = await sql`
    select p.id, p.name, p.repository_url,
      case
        when p.name = any(${FIXTURE_PROJECT_NAMES}::text[])
          or p.id = any(${FIXTURE_PROJECT_IDS}::text[])
          or p.id like any(${FIXTURE_PROJECT_ID_PATTERNS}::text[])
        then 'fixture project with no remaining runs'
        else 'only ever held e2e runs'
      end as reason
    from projects p
    where p.id <> all(${protectedIds}::text[])
      and (
        p.name = any(${FIXTURE_PROJECT_NAMES}::text[])
        or p.id = any(${FIXTURE_PROJECT_IDS}::text[])
        or p.id like any(${FIXTURE_PROJECT_ID_PATTERNS}::text[])
        or p.id = any(${e2eProjectIds}::text[])
      )
      and not exists (
        select 1 from runs r where r.project_id = p.id and r.id <> all(${runIds}::text[])
      )
    order by p.created_at`;

  const workerCandidates = await sql`
    select w.id, w.name, w.status, w.last_heartbeat_at,
      case
        when w.id = any(${FIXTURE_WORKER_IDS}::text[])
          or w.id like any(${FIXTURE_WORKER_ID_PATTERNS}::text[])
        then 'fixture worker'
        else 'no heartbeat for ' || ${STALE_WORKER_HOURS}::text || ' h and no leased job'
      end as reason,
      (select count(*)::int from worker_jobs j
        where j.worker_id = w.id and j.run_id <> all(${runIds}::text[])) as surviving_job_references
    from workers w
    where w.id = any(${FIXTURE_WORKER_IDS}::text[])
      or w.id like any(${FIXTURE_WORKER_ID_PATTERNS}::text[])
      or (
        w.last_heartbeat_at < now() - make_interval(hours => ${STALE_WORKER_HOURS})
        and not exists (
          select 1 from worker_jobs j
          where j.worker_id = w.id and j.state in ('leased', 'cancel_requested')
        )
      )
    order by w.created_at`;
  const workers = workerCandidates.filter((worker) => worker.surviving_job_references === 0);
  const keptWorkers = workerCandidates.filter((worker) => worker.surviving_job_references > 0);

  const [{ count: orphanQueuedJobs }] = await sql`
    select count(*)::int as count from worker_jobs j
    where j.state = 'queued' and not exists (select 1 from runs r where r.id = j.run_id)`;

  return {
    protectedProjects,
    protectedIds,
    protectedRunCount,
    runs,
    runIds,
    cascades,
    keptProtectedRuns,
    projects,
    workers,
    keptWorkers,
    orphanQueuedJobs,
  };
}

async function applyPurge(sql, plan) {
  const projectIds = plan.projects.map((project) => project.id);
  const workerIds = plan.workers.map((worker) => worker.id);
  return sql.begin(async (tx) => {
    try {
      await tx.savepoint(async (guarded) => {
        await guarded.unsafe(`set local forge.allow_event_delete = 'on'`);
      });
    } catch (error) {
      console.warn(
        `forge.allow_event_delete could not be set (${error instanceof Error ? error.message : String(error)}); continuing without it.`,
      );
    }
    const runs = await tx`delete from runs where id = any(${plan.runIds}::text[]) returning id`;
    const projects = await tx`
      delete from projects where id = any(${projectIds}::text[]) returning id`;
    const workers = await tx`delete from workers where id = any(${workerIds}::text[]) returning id`;
    const orphanQueuedJobs = await tx`
      delete from worker_jobs j
      where j.state = 'queued' and not exists (select 1 from runs r where r.id = j.run_id)
      returning id`;

    const [guard] = await tx`
      select
        (select count(*)::int from projects where id = any(${plan.protectedIds}::text[])) as projects,
        (select count(*)::int from runs where project_id = any(${plan.protectedIds}::text[])) as runs`;
    if (guard.projects !== plan.protectedProjects.length || guard.runs !== plan.protectedRunCount) {
      throw new Error(
        `Protected rows changed inside the transaction (projects ${plan.protectedProjects.length} -> ${guard.projects}, runs ${plan.protectedRunCount} -> ${guard.runs}); rolled back.`,
      );
    }
    if (runs.length !== plan.runIds.length || projects.length !== projectIds.length) {
      throw new Error(
        `Deleted ${runs.length}/${plan.runIds.length} runs and ${projects.length}/${projectIds.length} projects, not the previewed set; rolled back.`,
      );
    }
    return {
      runs: runs.length,
      projects: projects.length,
      workers: workers.length,
      'queued worker_jobs without a run': orphanQueuedJobs.length,
    };
  });
}

async function countRows(sql) {
  const counts = {};
  for (const table of COUNTED_TABLES) {
    const [{ count }] = await sql`select count(*)::int as count from ${sql(table)}`;
    counts[table] = count;
  }
  return counts;
}

function printPreview(plan, before) {
  console.log(`Purge preview (${execute ? 'EXECUTE' : 'dry run'})`);
  console.log('Protected projects, never touched:');
  for (const project of plan.protectedProjects) {
    console.log(`  ${project.id}  ${project.name}`);
  }
  console.log(`  (${plan.protectedRunCount} runs under them)`);
  console.log('\nCurrent public row counts:');
  for (const table of COUNTED_TABLES) console.log(`  ${table.padEnd(12)} ${before[table]}`);

  const rows = [];
  const runsByReason = new Map();
  for (const run of plan.runs)
    runsByReason.set(run.reason, (runsByReason.get(run.reason) ?? 0) + 1);
  for (const [reason, count] of runsByReason) rows.push(['runs', reason, count]);
  if (!runsByReason.size) rows.push(['runs', 'no fixture or e2e run found', 0]);
  for (const { table, count } of plan.cascades) {
    rows.push([`  ${table}`, 'cascade from purged runs', count]);
  }
  const projectsByReason = new Map();
  for (const project of plan.projects) {
    projectsByReason.set(project.reason, (projectsByReason.get(project.reason) ?? 0) + 1);
  }
  for (const [reason, count] of projectsByReason) rows.push(['projects', reason, count]);
  const workersByReason = new Map();
  for (const worker of plan.workers) {
    workersByReason.set(worker.reason, (workersByReason.get(worker.reason) ?? 0) + 1);
  }
  for (const [reason, count] of workersByReason) rows.push(['workers', reason, count]);
  rows.push([
    'worker_jobs',
    'queued with no run (impossible under the foreign key)',
    plan.orphanQueuedJobs,
  ]);
  rows.push([
    'kept: runs',
    'e2e objective under a protected project',
    plan.keptProtectedRuns.length,
  ]);
  rows.push(['kept: workers', 'referenced by a surviving worker job', plan.keptWorkers.length]);

  console.log(
    '\nWhat                    Why                                                       Count',
  );
  for (const [what, why, count] of rows) {
    console.log(`${what.padEnd(24)}${why.padEnd(58)}${String(count).padStart(5)}`);
  }

  if (plan.projects.length) {
    console.log('\nProjects to delete:');
    for (const project of plan.projects) {
      console.log(`  ${project.id}  ${project.name}  ${project.repository_url}`);
    }
  }
  if (plan.workers.length) {
    console.log('\nWorkers to delete:');
    for (const worker of plan.workers) {
      console.log(
        `  ${worker.id}  ${worker.name}  ${worker.status}  last heartbeat ${worker.last_heartbeat_at.toISOString()}  (${worker.reason})`,
      );
    }
  }
  if (plan.keptWorkers.length) {
    console.log('\nWorkers kept because surviving jobs reference them:');
    for (const worker of plan.keptWorkers) {
      console.log(`  ${worker.id}  ${worker.name}  ${worker.surviving_job_references} job(s)`);
    }
  }
  if (plan.keptProtectedRuns.length) {
    console.log(
      '\nRuns kept because their project is protected, although the objective is the e2e one:',
    );
    for (const run of plan.keptProtectedRuns) {
      console.log(`  ${run.id}  ${run.project_name}  ${run.objective}`);
    }
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
