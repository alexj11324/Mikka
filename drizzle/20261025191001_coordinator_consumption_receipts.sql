-- target: MIKKA_DATABASE_URL
BEGIN;
ALTER TABLE coordinator_events ADD COLUMN IF NOT EXISTS wake_status text;
ALTER TABLE coordinator_events ADD COLUMN IF NOT EXISTS processed_at timestamptz;
ALTER TABLE coordinator_events ADD COLUMN IF NOT EXISTS processing_holder text;
ALTER TABLE coordinator_events ADD COLUMN IF NOT EXISTS wake_delivery_token uuid;
ALTER TABLE coordinator_events ADD COLUMN IF NOT EXISTS wake_transport_run_id text;
ALTER TABLE coordinator_events ADD COLUMN IF NOT EXISTS wake_replays integer NOT NULL DEFAULT 0;
ALTER TABLE coordinator_events ADD COLUMN IF NOT EXISTS wake_total_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE coordinator_events ADD COLUMN IF NOT EXISTS wake_workspace_id uuid;
ALTER TABLE coordinator_events ADD COLUMN IF NOT EXISTS wake_parent_id uuid REFERENCES coordinator_events(id);
-- deliveredAt on old deployments meant staged input, not successful consumption.
-- An explicitly closed action batch proves append committed. Other historical
-- staged events need reconciliation; never blindly repeat unknown side effects.
UPDATE coordinator_events SET wake_status=CASE
 WHEN "deliveredAt" IS NULL THEN 'pending'
 WHEN "accountActionBatch"->>'closed'='true' THEN 'completed'
 ELSE 'legacy_review' END,
 processed_at=CASE WHEN "accountActionBatch"->>'closed'='true' THEN now() ELSE NULL END
 WHERE wake_status IS NULL;
ALTER TABLE coordinator_events ALTER COLUMN wake_status SET DEFAULT 'pending';
ALTER TABLE coordinator_events ALTER COLUMN wake_status SET NOT NULL;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='coordinator_events'::regclass AND conname='coordinator_events_wake_status_check') THEN
 ALTER TABLE coordinator_events ADD CONSTRAINT coordinator_events_wake_status_check CHECK(wake_status IN ('pending','running','completed','failed','cancelled','legacy_review'));
 END IF;
END $$;
ALTER TABLE coordinator_events ADD COLUMN IF NOT EXISTS wake_generation_state text NOT NULL DEFAULT 'not_started';
ALTER TABLE coordinator_events ADD COLUMN IF NOT EXISTS wake_generation_holder text;
ALTER TABLE coordinator_events ADD COLUMN IF NOT EXISTS wake_checkpoint jsonb;
ALTER TABLE coordinator_events ADD COLUMN IF NOT EXISTS wake_checkpoint_digest text;
ALTER TABLE coordinator_events ADD COLUMN IF NOT EXISTS wake_tool_receipts jsonb NOT NULL DEFAULT '{}';
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='coordinator_events'::regclass AND conname='coordinator_generation_state_check') THEN
 ALTER TABLE coordinator_events ADD CONSTRAINT coordinator_generation_state_check CHECK(wake_generation_state IN ('not_started','sending','returned','uncertain'));
 END IF;
END $$;
ALTER TABLE coordinator_sessions ADD COLUMN IF NOT EXISTS active_event_id uuid;
ALTER TABLE coordinator_messages ADD COLUMN IF NOT EXISTS source_event_id uuid REFERENCES coordinator_events(id);
CREATE INDEX IF NOT EXISTS coordinator_events_consume_due ON coordinator_events(wake_next_at,sequence) WHERE processed_at IS NULL AND wake_status IN ('pending','running');
CREATE INDEX IF NOT EXISTS coordinator_messages_event ON coordinator_messages(source_event_id);
-- Producers such as complete() already commit their event in the run transaction.
-- Capture their server-owned mailbox/schedule scope here without a second outbox
-- or changing the independently reviewed completion transaction.
CREATE OR REPLACE FUNCTION capture_coordinator_event_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE captured text;
BEGIN
 -- complete() emits a peer result and a lifecycle event atomically. The peer
 -- result wakes once; its lifecycle fact rides in that same consumption ACK.
 IF NEW.kind='run_finished' AND EXISTS(SELECT 1 FROM coordinator_events e WHERE e."userId"=NEW."userId" AND e."runId"=NEW."runId" AND e."dedupeKey"='run_result:'||NEW."runId"::text) THEN NEW.tier='background'; END IF;
 IF NEW.wake_workspace_id IS NULL AND NEW."runId" IS NOT NULL THEN
  SELECT m."workspaceId" INTO captured FROM agent_runs r JOIN devices d ON d.id=r."deviceId"
   JOIN session_mailboxes m ON m.id=r."mailboxId"
   WHERE r.id=NEW."runId" AND r."userId"=NEW."userId" AND d."ownerId"=NEW."userId" AND m."userId"=NEW."userId";
 END IF;
 IF NEW.wake_workspace_id IS NULL AND NEW.kind='schedule_result' THEN
  SELECT s.workspace_id::text INTO captured FROM user_schedules s WHERE s.id::text=NEW.payload->>'scheduleId' AND s.owner_id=NEW."userId";
 END IF;
 -- This reserved id is the daemon protocol partition, not a tenant id.
 -- Legacy personal runs retain owner/device/issue authority; do not invent a
 -- membership or guess a tenant from the owner's currently selected workspace.
 IF captured='00000000-0000-4000-8000-000000000001' THEN captured=NULL; END IF;
 IF NEW.wake_workspace_id IS NULL AND captured ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN NEW.wake_workspace_id=captured::uuid; END IF;
 RETURN NEW;
END $$;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='coordinator_events'::regclass AND tgname='coordinator_event_scope_capture') THEN
 CREATE TRIGGER coordinator_event_scope_capture BEFORE INSERT ON coordinator_events FOR EACH ROW EXECUTE FUNCTION capture_coordinator_event_scope();
 END IF;
END $$;
CREATE OR REPLACE FUNCTION preserve_coordinator_event_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM jsonb_each(OLD.wake_tool_receipts) r WHERE NEW.wake_tool_receipts->r.key IS DISTINCT FROM r.value) THEN RAISE EXCEPTION 'coordinator effect receipt is immutable'; END IF;
 IF OLD.wake_checkpoint IS NOT NULL AND (OLD.wake_checkpoint IS DISTINCT FROM NEW.wake_checkpoint OR OLD.wake_checkpoint_digest IS DISTINCT FROM NEW.wake_checkpoint_digest) THEN RAISE EXCEPTION 'coordinator checkpoint is immutable'; END IF;
 IF OLD."userId" IS DISTINCT FROM NEW."userId" OR OLD.wake_workspace_id IS DISTINCT FROM NEW.wake_workspace_id THEN RAISE EXCEPTION 'coordinator event scope is immutable'; END IF;
 RETURN NEW;
END $$;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='coordinator_events'::regclass AND tgname='coordinator_event_scope_immutable') THEN
 CREATE TRIGGER coordinator_event_scope_immutable BEFORE UPDATE OF "userId",wake_workspace_id ON coordinator_events FOR EACH ROW EXECUTE FUNCTION preserve_coordinator_event_scope();
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='coordinator_events'::regclass AND tgname='coordinator_checkpoint_immutable') THEN
 CREATE TRIGGER coordinator_checkpoint_immutable BEFORE UPDATE OF wake_checkpoint,wake_checkpoint_digest ON coordinator_events FOR EACH ROW EXECUTE FUNCTION preserve_coordinator_event_scope();
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='coordinator_events'::regclass AND tgname='coordinator_effect_receipts_immutable') THEN
 CREATE TRIGGER coordinator_effect_receipts_immutable BEFORE UPDATE OF wake_tool_receipts ON coordinator_events FOR EACH ROW EXECUTE FUNCTION preserve_coordinator_event_scope();
 END IF;
END $$;
COMMIT;
