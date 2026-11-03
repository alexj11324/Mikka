-- 「API 与订阅」: whether a custom OpenAI-protocol provider serves the
-- Responses API, which Codex runs on (decision 2026-11-02-1900). Probed free
-- when the key is added and on 重新获取模型: an empty POST {base}/responses
-- that a 404/405/501 marks false. A key without it still serves bot chats.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
ALTER TABLE model_api_keys ADD COLUMN IF NOT EXISTS "responsesApi" boolean NOT NULL DEFAULT true;
COMMIT;
