-- Worker actions created before workspace transport contain coordinator-local paths and
-- cannot be executed safely by a remote worker. Preserve the rows for audit history,
-- but close active leases/attempts so they cannot block replacement work.
update attempts
set state = 'cancelled',
    finished_at = coalesce(finished_at, now()),
    error = coalesce(error, '{"code":"LEGACY_WORKSPACE_ACTION","message":"Cancelled during workspace transport upgrade"}'::jsonb)
where id in (
  select attempt_id
  from worker_jobs
  where not (action ? 'workspace') and attempt_id is not null
)
and state in ('queued', 'leased', 'running', 'cancel_requested');

update worker_jobs
set state = 'cancelled',
    worker_id = null,
    lease_token = null,
    lease_expires_at = null,
    updated_at = now()
where not (action ? 'workspace')
and state in ('queued', 'leased', 'cancel_requested');
