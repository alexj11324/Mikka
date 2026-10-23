-- Per-agent permission mode: one of the modes the harness CLI lists in its
-- own help (Claude Code's permission mode, Codex's approval policy). Null is
-- Mikka's default, everything allowed inside Mikka's sandbox. Runs keep the
-- mode they were queued with.
-- Applied by scripts/migrate.mjs on production builds.

alter table agents add column if not exists "permissionMode" text;
alter table agent_runs add column if not exists "permissionMode" text;
