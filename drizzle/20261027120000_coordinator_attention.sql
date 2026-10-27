-- The attention model (R-20, lib/attention): suggestions get Comma's levels
-- and the matter they belong to; matters at a routed level are handed to the
-- Coordinator, which records each decision; the person can turn it off.
-- Mirrors suggestions, attention_matters, attention_log and
-- coordinator_sessions in lib/db/schema.ts.

alter table suggestions add column if not exists level text;
alter table suggestions add column if not exists "matterKey" text;
-- R-41: the item as a verb-first action line; null falls back to title.
alter table suggestions add column if not exists "actionTitle" text;

alter table coordinator_sessions add column if not exists "attentionEnabled" boolean not null default true;
alter table coordinator_sessions add column if not exists locale text;

create table if not exists attention_matters (
  id uuid primary key,
  "userId" text not null,
  kind text not null check (kind in ('item', 'briefing')),
  "matterKey" text not null,
  source text,
  "suggestionId" uuid references suggestions(id) on delete set null,
  title text not null,
  url text,
  level text not null check (level in ('low', 'normal', 'ask', 'high', 'critical')),
  assessment jsonb not null,
  evidence jsonb not null,
  state text not null check (state in ('waiting', 'handed', 'notified', 'quiet', 'snoozed', 'handled')),
  reason text,
  "runAt" timestamptz,
  recheck boolean not null default false,
  "personAsked" boolean not null default false,
  handoffs integer not null default 0,
  "handedAt" timestamptz,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  constraint attention_matters_key unique ("userId", "matterKey")
);

create index if not exists attention_matters_state_idx on attention_matters ("userId", state, "updatedAt");

create table if not exists attention_log (
  id uuid primary key,
  "userId" text not null,
  "matterId" uuid not null references attention_matters(id) on delete cascade,
  action text not null check (action in ('handoff', 'recheck', 'notify', 'quiet', 'snooze', 'handled')),
  spends boolean not null,
  reason text,
  "runAt" timestamptz,
  "createdAt" timestamptz not null default now()
);

create index if not exists attention_log_budget_idx on attention_log ("userId", action, "createdAt");
