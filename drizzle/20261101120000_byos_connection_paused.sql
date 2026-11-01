-- 暂停: the owner keeps a connection and its quota view, but Bots stop using it.
-- Not a state: refresh, usage reads and disconnect all still need 'connected'.
alter table byos_connections add column if not exists "paused" boolean not null default false;
