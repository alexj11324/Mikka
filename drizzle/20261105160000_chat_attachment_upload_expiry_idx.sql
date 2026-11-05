-- Uploads still holding a storage grant, by expiry: the account-deletions due timer and the
-- safety-net check (#1371) read their earliest expiry without scanning chat_attachments.
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE INDEX IF NOT EXISTS chat_attachments_upload_expiry_idx ON chat_attachments ("uploadExpiresAt") WHERE "uploadKey" IS NOT NULL;
COMMIT;
