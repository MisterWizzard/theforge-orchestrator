/**
 * Every migration, in the order it must be applied.
 *
 * The runtime migrator (`../migrate.ts`), the PGlite migration test and the
 * per-schema test isolation helper (`../testing.ts`) all apply exactly this
 * list, so a new migration is registered here once and nowhere else.
 */
export const MIGRATION_FILES: readonly string[] = [
  '001_initial.sql',
  '002_worker_jobs.sql',
  '003_scheduler.sql',
  '004_run_configuration.sql',
  '005_worker_workspace_transport.sql',
  '006_audit_chain_and_notifications.sql',
  '007_events_created_at_idx.sql',
  '008_usage_role_and_cache.sql',
];
