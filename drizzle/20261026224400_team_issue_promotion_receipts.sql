-- target: DATABASE_URL
-- Receipts retain completed and interrupted association choices without cleanup.
begin;
create table if not exists team_issue_promotion_receipts (
  "requestId" uuid primary key, "issueId" uuid not null, "ownerId" text not null,
  "teamId" uuid not null, "workspaceId" uuid not null,
  "createdAt" timestamptz not null default now()
);
commit;
