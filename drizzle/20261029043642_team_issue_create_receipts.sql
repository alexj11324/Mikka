-- target: DATABASE_URL
-- A durable receipt makes a removed or changed association distinguishable
-- from a first attempt or a rolled-back workspace transaction.
begin;
create table if not exists team_issue_create_receipts (
  "requestId" uuid primary key, "issueId" uuid not null unique,
  "ownerId" text not null, "teamId" uuid not null, "workspaceId" uuid not null,
  "createdAt" timestamptz not null default now()
);
commit;
