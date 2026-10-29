-- 移除 in Settings: a disconnected connection the owner no longer wants listed.
alter table byos_connections add column if not exists "removedAt" timestamptz;
alter table byos_connections drop constraint if exists byos_connections_removed_check;
alter table byos_connections add constraint byos_connections_removed_check
  check ("removedAt" is null or state = 'disconnected');
