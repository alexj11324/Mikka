-- 「API 与订阅」: a key's model list is what the provider's /models answered
-- (decision 2026-11-02-1200). 重新获取模型 asks again; when that fails, the
-- reason is kept here for the key's row (invalid: 401/403; unavailable:
-- anything else) and the last list the provider gave stays as it was.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
ALTER TABLE model_api_keys ADD COLUMN IF NOT EXISTS "modelsError" text CHECK ("modelsError" IN ('invalid', 'unavailable'));
COMMIT;
