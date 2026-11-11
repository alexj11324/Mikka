-- #1821 Memory metadata. Historical facts default approved/global, with no fabricated provenance.
-- Additive, idempotent, and safe to run twice. No existing migration is edited.
alter table user_facts add column if not exists "reviewStatus" text not null default 'approved';
alter table user_facts add column if not exists "sourceKind" text;
alter table user_facts add column if not exists "sourceId" text;
alter table user_facts add column if not exists "sourceUrl" text;
alter table user_facts add column if not exists "scopeKind" text not null default 'global';
alter table user_facts add column if not exists "scopeIds" uuid[] not null default '{}'::uuid[];
alter table user_facts add column if not exists "clientRequestId" uuid;

create unique index if not exists user_facts_client_request_unique
  on user_facts ("userId", "clientRequestId") where "clientRequestId" is not null;
create index if not exists user_facts_owner_review_idx
  on user_facts ("userId", "reviewStatus", state);

do $$ begin
  if not exists (select 1 from pg_constraint where conname='user_facts_review_status_check') then
    alter table user_facts add constraint user_facts_review_status_check check ("reviewStatus" in ('approved', 'pending'));
  end if;
  if not exists (select 1 from pg_constraint where conname='user_facts_source_kind_check') then
    alter table user_facts add constraint user_facts_source_kind_check check ("sourceKind" is null or "sourceKind" in ('thread','decision','told','file'));
  end if;
  if not exists (select 1 from pg_constraint where conname='user_facts_scope_kind_check') then
    alter table user_facts add constraint user_facts_scope_kind_check check (
      ("scopeKind" = 'global' and cardinality("scopeIds") = 0) or
      ("scopeKind" in ('workspaces', 'projects') and cardinality("scopeIds") > 0)
    );
  end if;
end $$;

create table if not exists user_fact_undo (
  "factId" uuid primary key references user_facts(id) on delete cascade,
  "userId" text not null,
  snapshot jsonb not null,
  "expiresAt" timestamptz not null
);
create index if not exists user_fact_undo_expires_idx on user_fact_undo ("expiresAt");

create table if not exists user_fact_uses (
  "factId" uuid not null references user_facts(id) on delete cascade,
  "userId" text not null,
  "eventId" uuid not null,
  "targetKind" text not null check ("targetKind" in ('thread','task')),
  "targetId" uuid not null,
  "targetUrl" text,
  "usedAt" timestamptz not null default now(),
  primary key ("factId","eventId")
);
create index if not exists user_fact_uses_recent_idx on user_fact_uses ("userId", "factId", "usedAt" desc);
