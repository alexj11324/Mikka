-- target: MIKKA_DATABASE_URL
-- Settings › 密钥与环境: an optional note on each entry, shown to members and
-- readable by Agents (Devin's 「Note」). Additive with a default, so existing
-- rows and code keep working. Mirrors lib/db/secrets-schema.ts.
-- Rollback: alter table workspace_secrets drop column note;
--           delete from schema_migrations where name = '20261102220000_workspace_secret_notes.sql';

alter table workspace_secrets add column if not exists note text not null default '' check (length(note) <= 500);
