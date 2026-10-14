-- 006: hash-chained audit log, notifications, usage ledger indexes.
--
-- Events become a per-run hash chain. A BEFORE INSERT trigger links every row
-- to the previous row of the same run (by sequence) and stores a SHA-256 over
-- a canonical rendering of the row, so a later change to a stored event, or
-- the removal of one from the middle of a run, shows up when the chain is
-- recomputed (verifyEventChain in @theforge/db, `pnpm forge verify-audit`).
-- Rows written before this migration keep NULL hashes; a run's chain starts at
-- its first row inserted afterwards. Every statement here is re-runnable.

alter table events add column if not exists prev_hash char(64);
alter table events add column if not exists row_hash char(64);

create or replace function forge_events_chain() returns trigger language plpgsql as $$
declare
  previous_hash text;
  canonical text;
begin
  -- One writer per run at a time. The coordinator appends events fire-and-forget,
  -- so two inserts for one run can overlap; without the lock both would read the
  -- same predecessor and the chain would fork. Two-key form so this key space is
  -- separate from the single-key session locks the test harness holds.
  perform pg_advisory_xact_lock(7106, hashtext(new.run_id));
  -- Draw the sequence number under the lock rather than keeping the column
  -- default, which was evaluated before the lock was taken. Chain order and
  -- sequence order are then the same thing, which is what the verifier walks.
  new.sequence := nextval(
    pg_get_serial_sequence(format('%I.%I', tg_table_schema, tg_table_name), 'sequence')
  );
  execute format(
    'select row_hash from %I.%I where run_id = $1 order by sequence desc limit 1',
    tg_table_schema, tg_table_name
  ) into previous_hash using new.run_id;
  -- A run with no rows yet, or whose latest row predates this migration, starts
  -- from the genesis hash. The verifier applies the same rule.
  new.prev_hash := coalesce(previous_hash, encode(sha256(convert_to('GENESIS', 'UTF8')), 'hex'));
  -- Canonical form: the jsonb text of a nine-element array. jsonb output is
  -- deterministic - object keys sorted by byte length then bytes, ", " and ": "
  -- separators, numbers without exponents - and canonicalJsonb() in
  -- @theforge/db renders exactly the same text from a JavaScript value. Field
  -- order must stay in step with canonicalEventString() there. created_at is
  -- truncated to milliseconds in UTC because that is all a JavaScript Date holds.
  canonical := jsonb_build_array(
    new.sequence, new.id, new.run_id, new.task_id, new.attempt_id, new.type, new.payload,
    to_char(new.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    new.prev_hash::text
  )::text;
  new.row_hash := encode(sha256(convert_to(canonical, 'UTF8')), 'hex');
  return new;
end
$$;

-- The audit tables are append-only. Retention (and test cleanup) opt out for one
-- transaction with set_config('forge.allow_event_delete', 'on', true); a delete
-- of a run cascades through this trigger too, so run deletion needs it as well.
create or replace function forge_audit_append_only() returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('forge.allow_event_delete', true), '') <> 'on' then
    raise exception 'forge audit: % on % refused, the audit log is append-only (retention sets forge.allow_event_delete=on for its transaction)',
      tg_op, tg_table_name using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$$;

create or replace trigger events_audit_chain
  before insert on events for each row execute function forge_events_chain();
create or replace trigger events_append_only
  before update or delete on events for each row execute function forge_audit_append_only();

-- Retention deletes whole runs, never individual events, so a chain leaves the
-- table intact or not at all. The tombstone records where the chain ended.
create table if not exists audit_tombstones (
  run_id text primary key,
  last_sequence bigint,
  last_row_hash char(64),
  event_count bigint not null default 0,
  deleted_at timestamptz not null default now()
);
create or replace trigger audit_tombstones_append_only
  before update or delete on audit_tombstones for each row execute function forge_audit_append_only();

create table if not exists notifications (
  id text primary key,
  run_id text references runs(id) on delete cascade,
  kind text not null,
  dedupe_key text not null,
  channel text not null,
  status text not null check (
    status in ('pending', 'sent', 'failed', 'skipped', 'duplicate', 'coalesced')
  ),
  attempts integer not null default 0,
  payload jsonb not null,
  last_error jsonb,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  -- The same escalation goes out on every channel; each delivery is its own row.
  unique (dedupe_key, channel)
);
create index if not exists notifications_status_idx on notifications (status, created_at);

-- The spend ledger is read by time window (daily ceiling, digests).
create index if not exists usage_records_run_created_idx on usage_records (run_id, created_at);
create index if not exists usage_records_created_idx on usage_records (created_at);
