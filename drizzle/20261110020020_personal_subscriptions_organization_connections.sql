-- #1849: preserve old credential grants as evidence; revoke their authority.
-- Rollback keeps the personal-only barrier. No secret, balance, payment or private content is moved.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE workspace_subscription_shares ADD COLUMN IF NOT EXISTS "legacyAllowOthers" boolean;
ALTER TABLE workspace_subscription_shares ADD COLUMN IF NOT EXISTS "sharingRevokedAt" timestamptz;
UPDATE workspace_subscription_shares SET "legacyAllowOthers"="allowOthers", "sharingRevokedAt"=CASE WHEN "allowOthers" THEN now() ELSE NULL END
  WHERE "legacyAllowOthers" IS NULL;
INSERT INTO workspace_audit_events (id,"workspaceId","actorType","actorName",action,category,"targetType","targetId",metadata)
  SELECT md5('1849:subscription-revoked:'||"ownerId"||':'||"workspaceId")::uuid,"workspaceId",'system','Mikka',
    'credential.revoked','security','subscription',"ownerId",'{}'::jsonb
  FROM workspace_subscription_shares WHERE "allowOthers" ON CONFLICT (id) DO NOTHING;
UPDATE workspace_subscription_shares SET "allowOthers"=false WHERE "allowOthers";
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='workspace_subscription_personal_only' AND conrelid='workspace_subscription_shares'::regclass) THEN
    ALTER TABLE workspace_subscription_shares ADD CONSTRAINT workspace_subscription_personal_only CHECK (NOT "allowOthers");
  END IF;
END $$;

-- The existing run control/lease protocol stops injected borrowed credentials.
-- Durable stop flags survive a deployment retry; the normal gateway/worker renewals deny them immediately.
WITH stopped AS (
  UPDATE agent_runs r SET "stopRequestedAt"=clock_timestamp(),"leaseExpiresAt"=LEAST(r."leaseExpiresAt",clock_timestamp()),"updatedAt"=clock_timestamp()
  WHERE r."stopRequestedAt" IS NULL AND r.status IN ('queued','preparing','running','paused','waiting_input','finishing')
    AND EXISTS (SELECT 1 FROM byos_bindings b WHERE b.id::text=r."agentDefinition"#>>'{subscription,bindingId}' AND b."ownerId"<>r."userId"
      UNION ALL SELECT 1 FROM byos_native_runs n JOIN byos_bindings b ON b.id=n."bindingId" WHERE n."runId"=r.id AND b."ownerId"<>r."userId")
  RETURNING r."deviceId"
) SELECT pg_notify('mikka_device_work',"deviceId"::text) FROM (SELECT DISTINCT "deviceId" FROM stopped WHERE "deviceId" IS NOT NULL) d;

ALTER TABLE model_api_keys ADD COLUMN IF NOT EXISTS ownership text NOT NULL DEFAULT 'personal';
ALTER TABLE model_api_keys ADD COLUMN IF NOT EXISTS "organizationId" uuid;
ALTER TABLE model_api_keys ADD COLUMN IF NOT EXISTS "createdBy" text;
ALTER TABLE model_api_keys ADD COLUMN IF NOT EXISTS "connectionKind" text NOT NULL DEFAULT 'api_key';
ALTER TABLE model_api_keys ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
ALTER TABLE model_api_keys ADD COLUMN IF NOT EXISTS "revokedAt" timestamptz;
UPDATE model_api_keys SET "createdBy"="ownerId" WHERE "createdBy" IS NULL AND ownership='personal';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='model_api_keys_ownership' AND conrelid='model_api_keys'::regclass) THEN
    ALTER TABLE model_api_keys ADD CONSTRAINT model_api_keys_ownership CHECK (
      (ownership='personal' AND "organizationId" IS NULL) OR
      (ownership='organization' AND "organizationId" IS NOT NULL AND "ownerId"='organization:'||"organizationId"::text));
    ALTER TABLE model_api_keys ADD CONSTRAINT model_api_keys_connection_kind CHECK ("connectionKind" IN ('api_key','gateway','custom_endpoint'));
    ALTER TABLE model_api_keys ADD CONSTRAINT model_api_keys_revision CHECK (revision>0);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS model_api_keys_organization_idx ON model_api_keys ("organizationId") WHERE "revokedAt" IS NULL;
-- A frozen run cannot silently receive a rotated credential, a changed endpoint or a revived key.
CREATE OR REPLACE FUNCTION model_api_key_identity_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."ownerId",NEW.ownership,NEW."organizationId") IS DISTINCT FROM (OLD."ownerId",OLD.ownership,OLD."organizationId") THEN
    RAISE EXCEPTION 'model_api_key_owner_immutable' USING ERRCODE='23514';
  END IF;
  IF (NEW.ciphertext,NEW.iv,NEW."keyVersion",NEW."baseUrl",NEW.protocol,NEW."revokedAt")
    IS DISTINCT FROM (OLD.ciphertext,OLD.iv,OLD."keyVersion",OLD."baseUrl",OLD.protocol,OLD."revokedAt") THEN
    NEW.revision := OLD.revision+1;
  ELSE NEW.revision := OLD.revision;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS model_api_key_identity_revision ON model_api_keys;
CREATE TRIGGER model_api_key_identity_revision BEFORE UPDATE ON model_api_keys FOR EACH ROW EXECUTE FUNCTION model_api_key_identity_revision();

-- The old default true cannot establish informed authorization to spend.
-- Preserve it for audit/rollback analysis without re-enabling it on rollback.
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "legacyApiKeyAfterQuota" boolean;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "apiKeyFallbackAuthorizedAt" timestamptz;
UPDATE "user" SET "legacyApiKeyAfterQuota"="apiKeyAfterQuota","apiKeyAfterQuota"=false WHERE "legacyApiKeyAfterQuota" IS NULL;
ALTER TABLE "user" ALTER COLUMN "apiKeyAfterQuota" SET DEFAULT false;
COMMIT;
