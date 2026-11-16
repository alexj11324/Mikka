-- target: MIKKA_DATABASE_URL

-- A chat's model may run on Mikka 额度: any model of the Gateway catalogue,
-- stored by its `vendor/model` id (decision 2026-11-15-1900). It replaces
-- 「Mikka 默认」, the row with neither a binding nor a key, which now reads as
-- no choice. At most one of binding, key and credits model is set.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
ALTER TABLE bot_model_choices ADD COLUMN IF NOT EXISTS "creditsModel" text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bot_model_choices_credits_one_source' AND conrelid = 'bot_model_choices'::regclass) THEN
    ALTER TABLE bot_model_choices ADD CONSTRAINT bot_model_choices_credits_one_source
      CHECK ("creditsModel" IS NULL OR ("bindingId" IS NULL AND "apiKeyId" IS NULL AND length("creditsModel") <= 128)) NOT VALID;
  END IF;
END $$;
ALTER TABLE bot_model_choices VALIDATE CONSTRAINT bot_model_choices_credits_one_source;
COMMIT;
