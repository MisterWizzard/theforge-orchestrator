alter table worker_jobs add column if not exists task_id text references tasks(id) on delete cascade;
alter table worker_jobs add column if not exists attempt_id text unique references attempts(id) on delete cascade;
alter table worker_jobs add column if not exists idempotency_key text unique;
alter table worker_jobs add column if not exists priority integer not null default 0;
alter table worker_jobs add column if not exists available_at timestamptz not null default now();

create unique index if not exists worker_jobs_active_task_idx
  on worker_jobs (task_id)
  where task_id is not null and state in ('queued', 'leased', 'cancel_requested');
create index if not exists worker_jobs_available_idx
  on worker_jobs (state, priority desc, available_at, created_at);
