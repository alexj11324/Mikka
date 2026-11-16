-- target: MIKKA_DATABASE_URL
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE mobile_push_tokens ADD COLUMN IF NOT EXISTS label text
  CHECK (label IS NULL OR char_length(label) BETWEEN 1 AND 80);

-- Older app versions can also rebind a token. A personal label never transfers
-- with it, while a fresh native session for the same person keeps their label.
CREATE OR REPLACE FUNCTION clear_reassigned_mobile_push_label() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.label := NULL;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER clear_reassigned_mobile_push_label
BEFORE UPDATE OF "userId" ON mobile_push_tokens
FOR EACH ROW WHEN (OLD."userId" IS DISTINCT FROM NEW."userId")
EXECUTE FUNCTION clear_reassigned_mobile_push_label();

COMMIT;
