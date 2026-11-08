-- A successful response is safe only under the exact secret set used to
-- validate its complete, memory-only proof. Old in-flight receipts have no
-- such evidence and are rejected until the caller makes a fresh request.
ALTER TABLE coding_workspace_requests ADD COLUMN IF NOT EXISTS "maskPolicy" text
  CHECK ("maskPolicy" ~ '^[a-f0-9]{64}$');
