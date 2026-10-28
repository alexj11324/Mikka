-- The sign-in email of a subscription connection, shown only to its owner in
-- Settings. Written after a successful usage read; never a token or account id.
alter table byos_connections add column if not exists "accountLabel" text;
alter table byos_connections drop constraint if exists byos_connections_account_label_check;
alter table byos_connections add constraint byos_connections_account_label_check
  check ("accountLabel" is null or (char_length("accountLabel") <= 256 and "accountLabel" ~ '^[^[:space:]@<>"]+@[^[:space:]@<>"]+$'));
-- 移除 in Settings: a disconnected connection the owner no longer wants listed.
alter table byos_connections add column if not exists "removedAt" timestamptz;
alter table byos_connections drop constraint if exists byos_connections_removed_check;
alter table byos_connections add constraint byos_connections_removed_check
  check ("removedAt" is null or state = 'disconnected');
