-- A bot's model can be Mikka 默认 on purpose, picked in its composer
-- (decision 2026-10-31-2330). That choice has no subscription binding behind
-- it, so a NULL "bindingId" stands for it; a missing row still means nothing
-- was picked. Existing rows keep their binding.
ALTER TABLE bot_model_choices ALTER COLUMN "bindingId" DROP NOT NULL;
