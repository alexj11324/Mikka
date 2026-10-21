-- Whether the orchestrator may dispatch runs to a device. Off: the device
-- stays registered and visible, but gets no work.
-- Applied with: node --env-file=.env.local scripts/apply-sql.mjs drizzle/0002_device_enabled.sql

alter table devices add column if not exists enabled boolean not null default true;
