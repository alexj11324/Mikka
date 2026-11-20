-- target: MIKKA_DATABASE_URL
-- Typed setting values; NULL means inherit. Legacy columns stay readable.
-- Rollback: deploy the previous application; retain these additive tables and
-- their values. No schema/data deletion is required. Legacy writes are mirrored.
CREATE TABLE IF NOT EXISTS personal_setting_values (
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "workspaceId" uuid,
  key text NOT NULL,
  "booleanValue" boolean,
  "integerValue" integer,
  "textValue" text,
  "textArrayValue" text[],
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT personal_setting_values_scope_key UNIQUE NULLS NOT DISTINCT ("userId", "workspaceId", key),
  CONSTRAINT personal_setting_values_one_type CHECK (num_nonnulls("booleanValue", "integerValue", "textValue", "textArrayValue") <= 1)
);
CREATE TABLE IF NOT EXISTS workspace_setting_values (
  "workspaceId" uuid NOT NULL,
  key text NOT NULL,
  "booleanValue" boolean,
  "integerValue" integer,
  "textValue" text,
  "textArrayValue" text[],
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("workspaceId", key),
  CONSTRAINT workspace_setting_values_one_type CHECK (num_nonnulls("booleanValue", "integerValue", "textValue", "textArrayValue") <= 1)
);

-- Preserve every existing explicit preference, including 0 (never archive).
INSERT INTO personal_setting_values ("userId", key, "integerValue")
SELECT "userId", 'archiveIdleAfterDays', "archiveIdleAfterDays" FROM user_preferences
ON CONFLICT ("userId", "workspaceId", key) DO NOTHING;
INSERT INTO personal_setting_values ("userId", "workspaceId", key, "textValue")
SELECT t."userId", t."workspaceId", v.key, v.value FROM thread_title_settings t
JOIN "user" u ON u.id=t."userId"
CROSS JOIN LATERAL (VALUES ('threadTitleInstructions', t.instructions), ('threadTitleTriggers', t.triggers)) v(key, value)
WHERE t."userId" <> ''
ON CONFLICT ("userId", "workspaceId", key) DO NOTHING;
INSERT INTO workspace_setting_values ("workspaceId", key, "textValue")
SELECT t."workspaceId", v.key, v.value FROM thread_title_settings t
CROSS JOIN LATERAL (VALUES ('threadTitleInstructions', t.instructions), ('threadTitleTriggers', t.triggers)) v(key, value)
WHERE t."userId" = ''
ON CONFLICT ("workspaceId", key) DO NOTHING;
