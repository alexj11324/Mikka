-- R-73 phase 1 (docs/design/proactive.md § 2.2): each person's profile of
-- facts drawn from what reaches them, shown and editable in 记忆, and the
-- person's 记忆 switch with the date their facts were last consolidated.
-- Facts belong to one person, never to a workspace. Mirrors user_facts and
-- memory_settings in lib/db/schema.ts. Additive only; safe to run again.

create table if not exists user_facts (
  id uuid primary key,
  "userId" text not null,
  kind text not null check (kind in ('interest', 'routine', 'place', 'subscription', 'deadline', 'tool', 'person', 'preference')),
  subject text not null,
  -- The subject folded for dedupe: NFKC, lower case, single spaces, no edge punctuation.
  "subjectKey" text not null,
  value jsonb not null default '{}'::jsonb,
  -- References only (source, suggestion id, external id, date), never the source text.
  evidence jsonb not null default '[]'::jsonb,
  confidence real not null check (confidence >= 0 and confidence <= 1),
  "firstSeenAt" timestamptz not null,
  "lastSeenAt" timestamptz not null,
  "expiresAt" timestamptz,
  state text not null default 'active' check (state in ('active', 'dismissed', 'deleted', 'expired')),
  "userEdited" boolean not null default false,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  constraint user_facts_subject_key unique ("userId", kind, "subjectKey")
);

create index if not exists user_facts_state_idx on user_facts ("userId", state);
create index if not exists user_facts_kind_idx on user_facts ("userId", kind);

create table if not exists memory_settings (
  "userId" text primary key,
  enabled boolean not null default true,
  -- The person's local date (YYYY-MM-DD) of the last nightly consolidation.
  "consolidatedOn" text,
  "updatedAt" timestamptz not null default now()
);
