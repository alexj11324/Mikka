-- When Mikka last asked a provider for a Composio account's email
-- (app/api/integrations/composio GET backfill): "emailCheckedAt" once the
-- provider gave a final answer (an email, or none), "lastAttemptAt" for every
-- try, so a provider that keeps failing is retried about hourly rather than on
-- every load. Additive and safe to re-run.
begin;
set local lock_timeout = '5s';

alter table composio_accounts add column if not exists "emailCheckedAt" timestamptz;
alter table composio_accounts add column if not exists "lastAttemptAt" timestamptz;

commit;
