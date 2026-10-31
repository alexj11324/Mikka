BEGIN;
SET LOCAL lock_timeout = '5s';
-- Retained by default: policy must explicitly authorize expiry of restore suppression records.
CREATE TABLE IF NOT EXISTS account_deletion_guards (
  "subjectId" text PRIMARY KEY,
  "jobId" uuid NOT NULL,
  "requestedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE account_deletion_jobs (
 id uuid PRIMARY KEY,
 "subjectUserId" text NOT NULL,
 "subjectEmailHash" text NOT NULL CHECK(length("subjectEmailHash")=64),
 "requestedAt" timestamptz NOT NULL DEFAULT now(),
 stage text NOT NULL CHECK(stage IN ('preparing','requested','external_pending','main_deleted','workspace_deleted','storage_pending','completed','cancelled')),
 plan jsonb,
 "pendingObjects" jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof("pendingObjects")='array'),
 "storageNotBefore" timestamptz,
 "blockedReasons" jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof("blockedReasons")='array'),
 "completedAt" timestamptz,
 "retentionUntil" timestamptz,
 "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX account_deletion_active_subject ON account_deletion_jobs("subjectUserId") WHERE stage<>'cancelled';
CREATE INDEX account_deletion_pending_idx ON account_deletion_jobs(stage,"requestedAt") WHERE stage NOT IN ('completed','cancelled');
CREATE TABLE account_storage_retirements (
 "userId" text NOT NULL,
 "storageKey" text NOT NULL,
 PRIMARY KEY("userId","storageKey")
);
CREATE OR REPLACE FUNCTION mikka_account_assert_writable(subject text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF subject IS NULL THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('mikka-account-write:' || subject, 0));
  IF EXISTS(SELECT 1 FROM account_deletion_guards WHERE "subjectId"=subject) THEN
    RAISE EXCEPTION 'account_deletion_pending' USING ERRCODE='55000';
  END IF;
END $$;
CREATE OR REPLACE FUNCTION mikka_account_guard_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE column_name text;
BEGIN
  FOREACH column_name IN ARRAY TG_ARGV LOOP
    PERFORM mikka_account_assert_writable(to_jsonb(NEW)->>column_name);
  END LOOP;
  RETURN NEW;
END $$;
-- Existing owner columns are the same inventory used by account deletion.
DO $$ DECLARE owned record; BEGIN
  FOR owned IN
    SELECT c.table_name,string_agg(quote_literal(c.column_name),',' ORDER BY c.column_name) AS arguments
    FROM information_schema.columns c JOIN information_schema.tables t USING(table_schema,table_name)
    WHERE c.table_schema=current_schema() AND t.table_type='BASE TABLE'
      AND (c.column_name IN ('userId','ownerId','owner_id','user_id') OR (c.table_name='user' AND c.column_name='id'))
      AND c.table_name NOT IN ('account_deletion_jobs','account_deletion_guards')
      AND c.table_name NOT LIKE 'improvement\_%' ESCAPE '\'
    GROUP BY c.table_name
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS account_deletion_insert_guard ON %I', owned.table_name);
    EXECUTE format('CREATE TRIGGER account_deletion_insert_guard BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION mikka_account_guard_insert(%s)',owned.table_name,owned.arguments);
  END LOOP;
END $$;
COMMIT;
