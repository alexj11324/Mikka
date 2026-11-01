-- A bot's saved model may be one an API key or custom provider serves
-- (orchestration.md § 2, C22): exactly one of a subscription binding or an
-- API key with its model. Deleting the key deletes the choice, and the bot
-- falls back to the usual order.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
ALTER TABLE bot_model_choices ALTER COLUMN "bindingId" DROP NOT NULL;
ALTER TABLE bot_model_choices ADD COLUMN IF NOT EXISTS "apiKeyId" uuid REFERENCES model_api_keys(id) ON DELETE CASCADE;
ALTER TABLE bot_model_choices ADD COLUMN IF NOT EXISTS "apiKeyModel" text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bot_model_choices_one_source' AND conrelid = 'bot_model_choices'::regclass) THEN
    ALTER TABLE bot_model_choices ADD CONSTRAINT bot_model_choices_one_source
      CHECK (("bindingId" IS NULL) <> ("apiKeyId" IS NULL) AND (("apiKeyId" IS NULL) = ("apiKeyModel" IS NULL)));
  END IF;
END $$;
COMMIT;
