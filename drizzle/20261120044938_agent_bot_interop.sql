-- target: MIKKA_DATABASE_URL
-- S7: Agents and Bots read and message each other
-- (docs/design/decisions/2026-11-19-2200-agent-bot-interop.md).
--
-- 1. A Bot or a run can be the subject of an explicit content grant. Unlike an
--    account, a bot/run subject never inherits ownership or `shared`
--    visibility: only an explicit, unexpired grant on the exact resource
--    authorizes it. For a bot or run each ancestor must be shared within the
--    tenant or carry its own grant; a service still needs its own grant on
--    every ancestor, as before. The tenant and quarantine checks over the
--    whole ancestry are unchanged, so no grant reaches another Workspace.
-- 2. Drive gains the bot, thread and environment scopes. Each such volume and
--    its blobs live in their own storage namespace
--    `drive-scope:<workspace>:<scope>:<scopeId>`, never a person's.
-- 3. Personal access tokens gain the interop scopes.
-- 4. A mailbox envelope may come from another member of the same Workspace;
--    the recipient mailbox still names the row's owner and both mailboxes
--    must share its tenant (previously the sender had to be the same person).
-- 5. A peer's send to a thread keeps one receipt per sender and key, so a
--    retried tool call never starts a second continuation. It stores a digest
--    of the request and the delivered run id, never the text.
-- Rollback: restore the previous CHECK constraints and function body from
--   20261110150005_resource_acl.sql, 20261116170813_workspace_shared_drive.sql
--   and 20261111080200_api_tokens.sql after deleting rows that use the new values,
--   then DROP TABLE interop_thread_sends and restore require_run_child_issue_scope
--   from 20261109035000_task_workspace_ownership.sql.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE resource_access_grants DROP CONSTRAINT "resource_access_grants_subjectKind_check",
  ADD CONSTRAINT "resource_access_grants_subjectKind_check" CHECK ("subjectKind" IN ('account','service','bot','run')),
  -- A bot or run id is a uuid; reject anything else before it can name a principal.
  ADD CONSTRAINT resource_access_grants_agent_subject_shape CHECK ("subjectKind" IN ('account','service')
    OR "subjectId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');

CREATE OR REPLACE FUNCTION mikka_resource_acl_allowed(subject_kind text, subject_id text, tenant uuid, resource_kind text, resource_id uuid, requested_action text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  WITH RECURSIVE ancestry AS (
    SELECT p.*,0 AS depth,ARRAY[p.kind||':'||p.id::text] AS path,false AS cycle
    FROM resource_access_policies p WHERE p.kind=resource_kind AND p.id=resource_id
    UNION ALL
    SELECT p.*,a.depth+1,a.path||(p.kind||':'||p.id::text),(p.kind||':'||p.id::text)=ANY(a.path)
    FROM ancestry a JOIN resource_access_policies p ON p.kind=a."parentKind" AND p.id=a."parentId"
    WHERE a.depth<32 AND NOT a.cycle
  ), decisions AS (
    SELECT a.*,CASE WHEN depth=0 THEN requested_action
      WHEN requested_action IN ('canComment','canSteer') THEN requested_action ELSE 'canReadContent' END AS action
    FROM ancestry a
  )
  SELECT tenant IS NOT NULL AND subject_id IS NOT NULL AND subject_kind IN ('account','service','bot','run')
    AND requested_action=ANY(ARRAY['canDiscover','canReadMetadata','canReadContent','canComment','canSteer','canApprove','canManageAccess','canTransfer','canUseCredential','canUseMachine','canViewUsage','canViewBilling'])
    AND EXISTS(SELECT 1 FROM ancestry WHERE depth=0)
    AND NOT EXISTS(SELECT 1 FROM decisions d WHERE d.cycle OR d.depth>=32 OR d."workspaceId" IS DISTINCT FROM tenant
      OR d.visibility='quarantined'
      OR (d."parentId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM resource_access_policies parent WHERE parent.kind=d."parentKind" AND parent.id=d."parentId"))
      OR NOT coalesce((
        -- Neither ownership nor sharing authorizes personal credentials,
        -- machines or a billing account. Those require their separate grants.
        -- Ownership is account-only: a bot, run or service subject needs a
        -- grant on the exact resource, like a share link. For a bot or run an
        -- ancestor passes when it is shared within the tenant or the subject
        -- holds its own grant there (below), so a private parent keeps every
        -- child closed, exactly as for an account. A service keeps its existing
        -- rule: its own explicit grant on every level, shared or not.
        (subject_kind IN ('bot','run') AND d.depth>0 AND d.visibility='shared'
          AND d.action=ANY(ARRAY['canDiscover','canReadMetadata','canReadContent','canComment','canSteer']))
        OR (subject_kind='account' AND d."ownerId"=subject_id AND d.action=ANY(ARRAY['canDiscover','canReadMetadata','canReadContent','canComment','canSteer','canApprove','canManageAccess','canTransfer','canViewUsage']))
        OR (subject_kind='account' AND d.visibility='shared' AND d.action=ANY(ARRAY['canDiscover','canReadMetadata','canReadContent','canComment','canSteer']))
        OR EXISTS(SELECT 1 FROM resource_access_grants g WHERE g."resourceKind"=d.kind AND g."resourceId"=d.id
          AND g."subjectKind"=subject_kind AND g."subjectId"=subject_id AND (g."expiresAt" IS NULL OR g."expiresAt">statement_timestamp())
          AND (d.action=ANY(g.capabilities) OR (d.action IN ('canDiscover','canReadMetadata') AND 'canReadContent'=ANY(g.capabilities))))
      ),false));
$$;

ALTER TABLE "user" ADD CONSTRAINT user_not_scope_drive_principal CHECK (id NOT LIKE 'drive-scope:%');

ALTER TABLE drive_volumes DROP CONSTRAINT "drive_volumes_driveScope_check",
  ADD CONSTRAINT "drive_volumes_driveScope_check" CHECK ("driveScope" IN ('user','project','project-user','team-workspace','bot','thread','environment')),
  ADD CONSTRAINT drive_volumes_scope_owner CHECK (
    ("driveScope" NOT IN ('bot','thread','environment') AND "ownerId" NOT LIKE 'drive-scope:%')
    OR ("driveScope" IN ('bot','thread','environment') AND "workspaceId" IS NOT NULL AND "scopeUserId" IS NULL
      AND "ownerId"='drive-scope:' || "workspaceId"::text || ':' || "driveScope" || ':' || "scopeId"));

ALTER TABLE drive_blobs DROP CONSTRAINT drive_blob_shared_owner,
  ADD CONSTRAINT drive_blob_shared_owner CHECK (
    ("workspaceId" IS NULL AND "projectId" IS NULL AND "ownerId" NOT LIKE 'drive-project:%' AND "ownerId" NOT LIKE 'drive-team:%'
      AND "ownerId" NOT LIKE 'drive-scope:%')
    OR ("workspaceId" IS NOT NULL AND "projectId" IS NOT NULL AND
        "ownerId"='drive-project:' || "workspaceId"::text || ':' || "projectId"::text AND
        ("storageKey" IS NULL OR "storageKey"='drive/drive-project%3A' || "workspaceId"::text || '%3A' ||
          "projectId"::text || '/' || left(sha256,2) || '/' || sha256))
    OR ("workspaceId" IS NOT NULL AND "projectId" IS NULL AND
        "ownerId"='drive-team:' || "workspaceId"::text AND
        ("storageKey" IS NULL OR "storageKey"='drive/drive-team%3A' || "workspaceId"::text || '/' || left(sha256,2) || '/' || sha256))
    OR ("workspaceId" IS NOT NULL AND "projectId" IS NULL AND
        "ownerId" ~ ('^drive-scope:' || "workspaceId"::text || ':(bot|thread|environment):[0-9a-f-]{36}$') AND
        ("storageKey" IS NULL OR "storageKey"='drive/' || replace("ownerId", ':', '%3A') || '/' || left(sha256,2) || '/' || sha256)));

ALTER TABLE personal_access_tokens DROP CONSTRAINT personal_access_tokens_scopes_check,
  ADD CONSTRAINT personal_access_tokens_scopes_check CHECK (
    cardinality(scopes) BETWEEN 1 AND 14
    AND array_position(scopes, null) IS NULL
    AND scopes <@ ARRAY['tasks:read','tasks:write','runs:read','runs:write','threads:read','threads:write','artifacts:read',
      'drive:read','drive:write','bots:read','bots:write','grants:read','grants:write','legacy:full']::text[]
    AND NOT (scopes @> ARRAY['legacy:full']::text[] AND cardinality(scopes) > 1)),
  -- A new token defaults to the full public set, as the settings page creates it.
  ALTER COLUMN scopes SET DEFAULT ARRAY['tasks:read','tasks:write','runs:read','runs:write','threads:read','threads:write',
    'artifacts:read','drive:read','drive:write','bots:read','bots:write','grants:read','grants:write']::text[];

CREATE TABLE IF NOT EXISTS interop_thread_sends (
  "rootRunId" uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  "senderKind" text NOT NULL CHECK ("senderKind" IN ('account','bot','run','service')),
  "senderId" text NOT NULL CHECK (length("senderId") BETWEEN 1 AND 200),
  key text NOT NULL CHECK (key ~ '^[A-Za-z0-9._:-]{1,128}$'),
  "requestDigest" text NOT NULL CHECK ("requestDigest" ~ '^[0-9a-f]{64}$'),
  result jsonb CHECK (result IS NULL OR jsonb_typeof(result)='object'),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("rootRunId","senderKind","senderId",key)
);

CREATE OR REPLACE FUNCTION require_run_child_issue_scope() RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE tenant uuid; run_owner text; mailbox_tenant text; mailbox_owner text; sender_tenant text; sender_owner text;
BEGIN
  IF NEW."runId" IS NOT NULL THEN
    SELECT "workspaceId", "userId" INTO tenant, run_owner FROM agent_runs WHERE id=NEW."runId" FOR SHARE;
    IF tenant IS NULL THEN RAISE EXCEPTION 'taskWorkspaceUnresolved' USING ERRCODE = '23514'; END IF;
  ELSIF TG_TABLE_NAME <> 'run_messages' THEN
    RAISE EXCEPTION 'taskWorkspaceUnresolved' USING ERRCODE = '23514';
  END IF;
  -- Conversation envelopes intentionally have no run. Their persisted mailbox
  -- is their tenant authority; never infer it from the user's oldest workspace.
  IF TG_TABLE_NAME = 'run_messages' THEN
    IF run_owner IS NOT NULL AND run_owner <> NEW."userId" THEN
      RAISE EXCEPTION 'taskWorkspaceMismatch' USING ERRCODE = '23514';
    END IF;
    IF NEW."mailboxId" IS NOT NULL THEN
      SELECT "workspaceId", "userId" INTO mailbox_tenant, mailbox_owner
        FROM session_mailboxes WHERE id=NEW."mailboxId" FOR SHARE;
      IF mailbox_owner IS DISTINCT FROM NEW."userId" OR mailbox_tenant IS NULL
        OR mailbox_tenant !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION 'taskWorkspaceUnresolved' USING ERRCODE = '23514';
      END IF;
      IF tenant IS NOT NULL AND tenant <> mailbox_tenant::uuid THEN
        RAISE EXCEPTION 'taskWorkspaceMismatch' USING ERRCODE = '23514';
      END IF;
      tenant := mailbox_tenant::uuid;
    END IF;
    IF tenant IS NULL THEN RAISE EXCEPTION 'taskWorkspaceUnresolved' USING ERRCODE = '23514'; END IF;
    IF NEW."senderMailboxId" IS NOT NULL THEN
      SELECT "workspaceId", "userId" INTO sender_tenant, sender_owner
        FROM session_mailboxes WHERE id=NEW."senderMailboxId" FOR SHARE;
      -- A sender may be another member of the same tenant (decision 2026-11-19-2200);
      -- the application checks membership and canSteer. The tenant stays fixed.
      IF sender_owner IS NULL OR sender_tenant IS NULL
        OR lower(sender_tenant) <> tenant::text THEN
        RAISE EXCEPTION 'taskWorkspaceMismatch' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

COMMIT;
