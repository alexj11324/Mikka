-- Actions an agent proposed in the person's own accounts (send an email,
-- create or change a calendar event), waiting for the person to approve.
-- Mirrors pendingActions in lib/db/schema.ts. New table only.
-- Applied by scripts/migrate.mjs on production builds.
create table if not exists pending_actions (
  id uuid primary key,
  "userId" text not null,
  action text not null,
  input jsonb not null,
  context jsonb,
  status text not null default 'pending',
  result jsonb,
  error text,
  "createdAt" timestamptz not null default now(),
  "decidedAt" timestamptz
);
create index if not exists pending_actions_user_status_idx on pending_actions ("userId", status, "createdAt");
