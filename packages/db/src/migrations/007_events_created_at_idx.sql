-- 007: events by time window.
--
-- The digests (policy B12, `pnpm forge digest`) read every event of a few
-- types inside a window of hours, across all runs. Until now the only index on
-- events was (run_id, sequence), so that read was a sequential scan of the
-- whole audit log. Re-runnable, like every migration here.

create index if not exists events_created_at_idx on events (created_at);
