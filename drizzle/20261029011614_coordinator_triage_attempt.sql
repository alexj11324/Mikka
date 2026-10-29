-- target: MIKKA_DATABASE_URL
-- Schema-only prerequisite for Coordinator retry/receipt source. No data cleanup.
-- The migration runner must apply this whole file inside its normal transaction.
set local lock_timeout = '5s';
set local statement_timeout = '60s';
alter table coordinator_events add column if not exists "lastTriageAttemptAt" timestamptz;
alter table coordinator_events add column if not exists "triageDecision" jsonb;
