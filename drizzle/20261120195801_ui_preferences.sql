-- target: MIKKA_DATABASE_URL

ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS "uiPreferences" jsonb NOT NULL DEFAULT '{}'::jsonb;
