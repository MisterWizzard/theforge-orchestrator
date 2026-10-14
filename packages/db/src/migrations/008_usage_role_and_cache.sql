-- 008: attribute spend to a role, and record cached input tokens.
--
-- Two gaps the 04/10/2026 cost review (S14.6) could not answer around.
--
-- `role`. The pipeline has always emitted it: `usage.recorded` carries
-- `role: 'planner' | 'critic' | 'builder' | 'reviewer'` (workflows/src/index.ts,
-- `accountUsage`), and every one of the 31 stored events has it. The
-- coordinator's event handler simply never read the field, so it was dropped at
-- the persistence boundary and no query could group by it. That made
-- ROLE_ESTIMATES_USD - the per-role guesses the router uses to decide cloud
-- against local - unfalsifiable: there was no measured per-role cost to check
-- them against. Nullable, because a record whose event predates the field, or
-- which was written by something other than the pipeline, honestly has no role.
--
-- `cached_input_tokens`. Claude's input token counts were not credible: 4, 4, 4,
-- 28, 8, 11 tokens of input for calls that produced 2,000-16,000 tokens of
-- output and cost up to $1.27. Codex, over the same window, reported 27,490. The
-- cause is an asymmetry between the two CLIs' usage objects:
--
--   - Claude's `input_tokens` EXCLUDES cache, with the real volume in
--     `cache_creation_input_tokens` and `cache_read_input_tokens`. Claude Code
--     caches by default, so almost everything landed in those two fields and
--     what we recorded was the uncached residual.
--   - Codex's `input_tokens` INCLUDES cache, with `cached_input_tokens` as a
--     subset of it. Which is why its figure looked sane all along.
--
-- Both now report a true input total plus the cached portion, so the two are
-- comparable and a cache-read token (a tenth of the price) is distinguishable
-- from a fresh one. Cost is unaffected either way: `cost_usd` comes from
-- Claude's own `total_cost_usd`, which was always right.
--
-- Backfill is deliberately not written here. Events are the source of truth and
-- the coordinator replays them on boot, so `role` repopulates itself from the
-- existing events for free. Cached token counts genuinely cannot be recovered -
-- the figures were never read from the CLI - so they stay 0 for historical rows
-- rather than being invented. Re-runnable, like every migration here.

alter table usage_records add column if not exists role text;
alter table usage_records
  add column if not exists cached_input_tokens integer not null default 0;

-- The cost review's central question is "what did each role cost over a
-- window", which is this index exactly.
create index if not exists usage_records_role_created_idx on usage_records (role, created_at);
