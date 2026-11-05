-- target: MIKKA_DATABASE_URL
-- The acquisition sweep records a safe reason when a sign-in deadline passes.
begin;
set local lock_timeout = '5s';

alter table byos_connections drop constraint if exists "byos_connections_lastErrorCode_check";
alter table byos_connections add constraint "byos_connections_lastErrorCode_check"
  check ("lastErrorCode" in
    ('publication_failed', 'refresh_failed', 'publication_missing', 'integrity_failed', 'acquire_expired'));

commit;
