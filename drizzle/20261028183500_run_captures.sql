-- target: MIKKA_DATABASE_URL
-- Run captures: screenshots and screen recordings a thread keeps as evidence
-- (lib/captures). Files live in the artifacts R2 bucket; these tables keep the
-- owner, the run and share links. Mirrors runCaptures and runCaptureShares in
-- lib/db/schema.ts. New tables only; IF NOT EXISTS makes a retry safe.
set local lock_timeout = '5s';
select pg_advisory_xact_lock(hashtextextended(current_schema() || '.run_captures', 0));
create table if not exists run_captures (
  id uuid primary key,
  "userId" text not null,
  "runId" uuid not null references agent_runs(id) on delete cascade,
  "issueId" uuid references issues(id) on delete set null,
  "botId" uuid references bots(id) on delete set null,
  kind text not null check (kind in ('image', 'video')),
  "contentType" text not null check ("contentType" in ('image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm')),
  source text not null check (source in ('cloud_computer', 'local')),
  status text not null check (status in ('recording', 'uploading', 'ready', 'failed')),
  title varchar(200) not null,
  "storageKey" text,
  "inlineContent" bytea,
  size integer check (size >= 0),
  sha256 text,
  "durationMs" integer check ("durationMs" >= 0),
  display integer check (display between 1 and 999),
  "expiresAt" timestamptz,
  error text,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  constraint run_captures_ready_file check (status <> 'ready' or ("storageKey" is not null and size is not null and sha256 is not null))
);
create index if not exists run_captures_run_idx on run_captures ("runId", "createdAt");
create index if not exists run_captures_user_idx on run_captures ("userId", "createdAt");
-- One recording at a time per run; a finished or failed one frees the slot.
create unique index if not exists run_captures_recording_key on run_captures ("runId") where status = 'recording';
create table if not exists run_capture_shares (
  id uuid primary key,
  "captureId" uuid not null references run_captures(id) on delete cascade,
  "tokenHash" text not null,
  "createdBy" text not null,
  "revokedAt" timestamptz,
  "createdAt" timestamptz not null default now()
);
create unique index if not exists run_capture_shares_token_key on run_capture_shares ("tokenHash");
create index if not exists run_capture_shares_capture_idx on run_capture_shares ("captureId");
