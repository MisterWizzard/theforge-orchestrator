create table if not exists projects (
  id text primary key, name text not null, repository_url text not null,
  default_branch text not null default 'main', policy jsonb not null default '{}',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists runs (
  id text primary key, project_id text not null references projects(id), objective text not null,
  constraints jsonb not null default '[]', state text not null, resume_state text,
  budget jsonb not null, spent jsonb not null, created_at timestamptz not null, updated_at timestamptz not null
);
create table if not exists tasks (
  id text primary key, run_id text not null references runs(id) on delete cascade, title text not null,
  description text not null default '', state text not null, priority integer not null default 0,
  acceptance_criteria jsonb not null, required_capabilities jsonb not null default '[]',
  file_ownership jsonb not null default '[]', attempts integer not null default 0,
  max_attempts integer not null default 3, next_attempt_at timestamptz,
  created_at timestamptz not null, updated_at timestamptz not null
);
create table if not exists task_dependencies (
  task_id text not null references tasks(id) on delete cascade,
  depends_on_id text not null references tasks(id) on delete cascade,
  primary key (task_id, depends_on_id), check (task_id <> depends_on_id)
);
create table if not exists attempts (
  id text primary key, task_id text not null references tasks(id) on delete cascade,
  worker_id text, provider text, provider_session_id text, workspace_path text,
  state text not null, lease_token text unique, lease_expires_at timestamptz,
  started_at timestamptz, finished_at timestamptz, error jsonb
);
create table if not exists events (
  sequence bigserial primary key, id text not null unique, run_id text not null references runs(id) on delete cascade,
  task_id text, attempt_id text, type text not null, payload jsonb not null,
  idempotency_key text not null unique, created_at timestamptz not null
);
create table if not exists messages (
  id text primary key, run_id text not null references runs(id) on delete cascade, task_id text,
  attempt_id text, type text not null, sender jsonb not null, claim text not null,
  requested_action text, evidence jsonb not null, criteria jsonb not null,
  confidence numeric not null, uncertainty text, idempotency_key text not null unique,
  created_at timestamptz not null
);
create table if not exists findings (
  id text primary key, run_id text not null references runs(id) on delete cascade,
  task_id text not null references tasks(id), claim text not null, severity text not null,
  evidence jsonb not null, affected_criterion text not null, requested_action text not null, status text not null
);
create table if not exists decisions (
  id text primary key, run_id text not null references runs(id) on delete cascade,
  title text not null, rationale text not null, status text not null, evidence jsonb not null, created_at timestamptz not null
);
create table if not exists blockers (
  id text primary key, run_id text not null references runs(id) on delete cascade,
  task_id text not null references tasks(id), classification text not null, summary text not null,
  evidence jsonb not null, impact text not null, attempts jsonb not null, workaround text,
  smallest_unblock_action text not null, status text not null, created_at timestamptz not null, updated_at timestamptz not null
);
create table if not exists approvals (
  id text primary key, run_id text not null references runs(id) on delete cascade,
  action_class text not null, action_digest char(64) not null, normalized_action text not null,
  scope text not null, worker_id text, status text not null, expires_at timestamptz not null,
  decided_at timestamptz, created_at timestamptz not null default now()
);
create table if not exists workers (
  id text primary key, name text not null, platform text not null, capabilities jsonb not null,
  policy_profile text not null, credential_digest char(64) not null, status text not null,
  lease_expires_at timestamptz not null, last_heartbeat_at timestamptz not null, created_at timestamptz not null default now()
);
create table if not exists artifacts (
  id text primary key, run_id text not null references runs(id) on delete cascade, task_id text,
  attempt_id text, kind text not null, label text not null, uri text not null, sha256 char(64),
  metadata jsonb not null default '{}', created_at timestamptz not null
);
create table if not exists usage_records (
  id text primary key, run_id text not null references runs(id) on delete cascade, task_id text,
  attempt_id text, provider text not null, model text, input_tokens integer not null default 0,
  output_tokens integer not null default 0, cost_usd numeric not null default 0,
  elapsed_ms integer not null default 0, tools jsonb not null default '[]', created_at timestamptz not null
);
create index if not exists tasks_ready_idx on tasks (state, priority desc, created_at);
create index if not exists attempts_lease_idx on attempts (state, lease_expires_at);
create index if not exists events_run_sequence_idx on events (run_id, sequence);
create index if not exists workers_heartbeat_idx on workers (status, last_heartbeat_at);
