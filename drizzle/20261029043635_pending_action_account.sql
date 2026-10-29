-- Existing pending actions have no verified account binding and cannot execute.
begin;
set local lock_timeout = '5s';
alter table pending_actions add column if not exists "connectedAccountId" text;
commit;
