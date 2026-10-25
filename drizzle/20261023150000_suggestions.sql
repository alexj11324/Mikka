-- The suggestions list (MIK-41): external notifications from connected apps
-- that the rules or the decision model judged worth showing, plus one
-- briefing per person per local day. Hidden rows are kept only so a repeat
-- delivery is not judged twice; they are never returned. Mirrors suggestions
-- and briefings in lib/db/schema.ts. Applied by scripts/migrate.mjs on
-- production builds.

create table if not exists suggestions (
  id uuid primary key,
  "userId" text not null,
  source text not null,
  "externalId" text not null,
  action text not null,
  title text not null,
  url text,
  actor text,
  shown boolean not null,
  "decidedBy" text not null,
  probability real,
  required boolean not null default false,
  "occurredAt" timestamptz not null,
  "dismissedAt" timestamptz,
  "createdAt" timestamptz not null default now(),
  constraint suggestions_external_key unique ("userId", source, "externalId")
);

create index if not exists suggestions_user_shown_idx on suggestions ("userId", shown, "createdAt");

create table if not exists briefings (
  "userId" text not null,
  "localDate" text not null,
  kind text not null,
  "timeZone" text not null,
  highlights jsonb not null,
  counts jsonb not null,
  total integer not null,
  "createdAt" timestamptz not null default now(),
  primary key ("userId", "localDate")
);
