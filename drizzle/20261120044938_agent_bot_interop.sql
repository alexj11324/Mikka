-- target: MIKKA_DATABASE_URL
-- S7: Agents and Bots read and message each other
-- (docs/design/decisions/2026-11-19-2200-agent-bot-interop.md).
--
-- 1. A Bot or a run can be the subject of an explicit content grant. Unlike an
--    account, a bot/run subject never inherits ownership or `shared`
--    visibility: only an explicit, unexpired grant on the exact resource
--    authorizes it, and the tenant and quarantine checks over the whole
--    ancestry are unchanged, so no grant reaches another Workspace.
-- 2. Drive gains the bot, thread and environment scopes. Each such volume and
--    its blobs live in their own storage namespace
--    `drive-scope:<workspace>:<scope>:<scopeId>`, never a person's.
-- 3. Personal access tokens gain the interop scopes.
-- 4. A peer's send to a thread keeps one receipt per sender and key, so a
--    retried tool call never starts a second continuation. It stores a digest
--    of the request and the delivered run id, never the text.
-- Rollback: restore the previous CHECK constraints and function body from
--   20261110150005_resource_acl.sql, 20261116170813_workspace_shared_drive.sql
--   and 20261111080200_api_tokens.sql after deleting rows that use the new values,
--   then DROP TABLE interop_thread_sends.

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
        -- Ownership and visibility are account-only: a bot, run or service
        -- subject needs a grant on the exact resource, like a share link. Its
        -- ancestors still bind the tenant and quarantine above but do not need
        -- their own grant. (A service's existing grants are all depth-0 Project
        -- grants, so this widens nothing that exists.)
        (subject_kind IN ('bot','run','service') AND d.depth>0)
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

COMMIT;
