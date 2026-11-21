-- target: MIKKA_DATABASE_URL

BEGIN;
SET LOCAL lock_timeout = '5s';

-- bot_id is the current publication/authorization anchor and may become NULL.
-- Request identity must survive that cleanup without merging two conversations.
ALTER TABLE user_schedules ADD COLUMN request_origin text;
UPDATE user_schedules SET request_origin = CASE WHEN bot_id IS NOT NULL
  THEN 'bot:' || bot_id::text ELSE 'retained:' || id::text END;
ALTER TABLE user_schedules ALTER COLUMN request_origin SET NOT NULL;
ALTER TABLE user_schedules DROP CONSTRAINT user_schedules_owner_id_bot_id_request_id_key;
ALTER TABLE user_schedules ADD CONSTRAINT user_schedules_request_identity
  UNIQUE(owner_id, request_origin, request_id);

CREATE FUNCTION mikka_schedule_request_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Existing writers and restores need not know about the new internal key.
    NEW.request_origin := coalesce(NEW.request_origin, CASE WHEN NEW.bot_id IS NULL
      THEN 'coordinator' ELSE 'bot:' || NEW.bot_id::text END);
  ELSIF NEW.request_origin IS DISTINCT FROM OLD.request_origin THEN
    RAISE EXCEPTION 'schedule request origin is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER schedule_request_origin
  BEFORE INSERT OR UPDATE OF request_origin ON user_schedules
  FOR EACH ROW EXECUTE FUNCTION mikka_schedule_request_origin();

COMMIT;
