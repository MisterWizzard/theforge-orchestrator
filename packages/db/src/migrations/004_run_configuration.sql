alter table runs add column if not exists configuration jsonb not null default '{}';
