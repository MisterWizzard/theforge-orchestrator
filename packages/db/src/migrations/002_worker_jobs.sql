create table if not exists worker_jobs (
  id text primary key,
  run_id text not null references runs(id) on delete cascade,
  action jsonb not null,
  required_capabilities jsonb not null default '[]',
  state text not null check (state in ('queued', 'leased', 'cancel_requested', 'cancelled', 'completed', 'failed')),
  worker_id text references workers(id),
  lease_token text unique,
  lease_expires_at timestamptz,
  approval jsonb,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (state in ('leased', 'cancel_requested') and worker_id is not null and lease_token is not null and lease_expires_at is not null)
    or state not in ('leased', 'cancel_requested')
  )
);

create index if not exists worker_jobs_queue_idx on worker_jobs (state, created_at);
create index if not exists worker_jobs_lease_idx on worker_jobs (state, lease_expires_at);
create index if not exists worker_jobs_run_idx on worker_jobs (run_id, created_at);
