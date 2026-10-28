-- target: MIKKA_DATABASE_URL
-- Provider device codes / PKCE remain in Infisical, not SQL metadata.
begin;
set local lock_timeout = '5s';
alter table byos_oauth_attempts add column if not exists flow text not null default 'pkce' check (flow in ('pkce','device'));
alter table byos_oauth_attempts add column if not exists "nextPollAt" timestamptz not null default now();
alter table byos_oauth_attempts add column if not exists polling boolean not null default false;
commit;
