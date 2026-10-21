-- Whether the orchestrator may dispatch runs to a device. Off: the device
-- stays registered and visible, but gets no work.
-- Applied by scripts/migrate.mjs on production builds.

alter table devices add column if not exists enabled boolean not null default true;
