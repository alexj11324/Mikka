-- Task tenancy is independent of its creator, optional team and Linear policy.
-- Cross-database evidence is reconciled by scripts/task-workspace-backfill.mjs
-- after both migration targets are ready. Unproved rows stay quarantined.
ALTER TABLE issues ADD COLUMN IF NOT EXISTS "workspaceId" uuid;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS "ownershipState" text NOT NULL DEFAULT 'pending';
ALTER TABLE issues ADD COLUMN IF NOT EXISTS "linearSyncPolicy" text NOT NULL DEFAULT 'disabled';
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS "workspaceId" uuid;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS "workspaceId" uuid;
ALTER TABLE factory_tasks ADD COLUMN IF NOT EXISTS "workspaceId" uuid;
ALTER TABLE linear_team_syncs ADD COLUMN IF NOT EXISTS "workspaceId" uuid;
DROP INDEX IF EXISTS linear_team_syncs_one_active_per_owner_key;
CREATE UNIQUE INDEX linear_team_syncs_one_active_per_workspace_key ON linear_team_syncs ("ownerId","workspaceId")
WHERE active AND "workspaceId" IS NOT NULL;
ALTER TABLE issues ADD CONSTRAINT issues_workspace_binding_check CHECK (
  ("ownershipState" = 'bound' AND "workspaceId" IS NOT NULL) OR
  ("ownershipState" = 'pending' AND "workspaceId" IS NULL)
);
ALTER TABLE issues ADD CONSTRAINT issues_linear_sync_policy_check CHECK ("linearSyncPolicy" IN ('disabled', 'explicit'));
CREATE INDEX issues_workspace_updated_idx ON issues ("workspaceId", "updatedAt" DESC) WHERE "ownershipState" = 'bound';
CREATE INDEX agent_runs_workspace_created_idx ON agent_runs ("workspaceId", "createdAt" DESC) WHERE "workspaceId" IS NOT NULL;
CREATE INDEX artifacts_workspace_updated_idx ON artifacts ("workspaceId", "updatedAt" DESC) WHERE "workspaceId" IS NOT NULL;
CREATE INDEX factory_tasks_workspace_updated_idx ON factory_tasks ("workspaceId", "updatedAt" DESC) WHERE "workspaceId" IS NOT NULL;

CREATE TABLE issue_workspace_repairs (
  "issueId" uuid PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (reason IN ('missing_evidence', 'conflicting_evidence', 'missing_workspace')),
  evidence jsonb NOT NULL DEFAULT '[]',
  "checkedAt" timestamptz NOT NULL DEFAULT now()
);

-- Preserve verified existing provider bindings, without adding a binding or
-- queuing any provider side effect. Scope and syncBlocked remain compatible.
UPDATE issues i SET "linearSyncPolicy" = 'explicit'
WHERE i.scope = 'workspace' AND NOT i."linearSyncBlocked" AND EXISTS (
  SELECT 1 FROM linear_issue_links l
  WHERE l."issueId" = i.id AND l."ownerId" = i."userId" AND l."externalTargetVerified"
);

CREATE FUNCTION preserve_task_workspace() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."workspaceId" IS NOT NULL
    AND NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId" THEN
    RAISE EXCEPTION 'taskWorkspaceTransferDenied' USING ERRCODE = '23514';
  END IF;
  NEW."ownershipState" := CASE WHEN NEW."workspaceId" IS NULL THEN 'pending' ELSE 'bound' END;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_task_workspace BEFORE INSERT OR UPDATE OF "workspaceId", "ownershipState" ON issues
FOR EACH ROW EXECUTE FUNCTION preserve_task_workspace();

-- Keep the existing publication generation as a stale-work fence while
-- provider policy is edited independently of the immutable tenant.
CREATE OR REPLACE FUNCTION advance_issue_scope_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."scopeVersion" := OLD."scopeVersion" + CASE WHEN NEW.scope IS DISTINCT FROM OLD.scope
    OR NEW."linearSyncPolicy" IS DISTINCT FROM OLD."linearSyncPolicy" THEN 1 ELSE 0 END;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS advance_issue_scope_generation ON issues;
CREATE TRIGGER advance_issue_scope_generation BEFORE UPDATE OF scope,"scopeVersion","linearSyncPolicy" ON issues
FOR EACH ROW EXECUTE FUNCTION advance_issue_scope_generation();

-- A run is admitted to the task's frozen tenant. Checking only its owner's id
-- used to allow the same account to dispatch a task through a foreign Bot.
CREATE FUNCTION require_run_task_workspace() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tenant uuid; task_tenant uuid; bot_tenant uuid; frozen text; origin text; parents uuid[];
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."userId" IS DISTINCT FROM OLD."userId" THEN
    RAISE EXCEPTION 'taskWorkspaceMismatch' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."workspaceId" IS NOT NULL AND NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId" THEN
    RAISE EXCEPTION 'taskWorkspaceTransferDenied' USING ERRCODE = '23514';
  END IF;
  -- Revocation and terminal reporting must remain possible for quarantined
  -- historical runs. No new execution or credential can be admitted that way.
  IF TG_OP = 'UPDATE' AND NEW.status IN ('cancelled','stopped','failed','succeeded')
    AND NEW."issueId" IS NOT DISTINCT FROM OLD."issueId" AND NEW."botId" IS NOT DISTINCT FROM OLD."botId"
    AND NEW."agentDefinition" IS NOT DISTINCT FROM OLD."agentDefinition"
    AND NEW."retryOf" IS NOT DISTINCT FROM OLD."retryOf" AND NEW."continuesRunId" IS NOT DISTINCT FROM OLD."continuesRunId"
    AND NEW."questionContinuation" IS NOT DISTINCT FROM OLD."questionContinuation"
    AND NEW."workspaceId" IS NOT DISTINCT FROM OLD."workspaceId" THEN RETURN NEW; END IF;
  tenant := NEW."workspaceId";
  IF NEW."issueId" IS NOT NULL THEN
    SELECT "workspaceId" INTO task_tenant FROM issues WHERE id = NEW."issueId" FOR SHARE;
    IF task_tenant IS NULL THEN RAISE EXCEPTION 'taskWorkspaceUnresolved' USING ERRCODE = '23514'; END IF;
    IF tenant IS NOT NULL AND tenant <> task_tenant THEN RAISE EXCEPTION 'taskWorkspaceMismatch' USING ERRCODE = '23514'; END IF;
    tenant := task_tenant;
  END IF;
  IF NEW."botId" IS NOT NULL THEN
    SELECT "workspaceId" INTO bot_tenant FROM bots WHERE id = NEW."botId";
    IF bot_tenant IS NULL OR (tenant IS NOT NULL AND bot_tenant <> tenant) THEN
      RAISE EXCEPTION 'taskWorkspaceMismatch' USING ERRCODE = '23514';
    END IF;
    tenant := bot_tenant;
  END IF;
  frozen := NEW."agentDefinition"->'executionIdentity'->>'workspaceId';
  IF frozen IS NOT NULL THEN
    IF tenant IS NOT NULL AND frozen IS DISTINCT FROM tenant::text THEN
      RAISE EXCEPTION 'taskWorkspaceMismatch' USING ERRCODE = '23514';
    END IF;
    tenant := frozen::uuid;
  END IF;
  -- New lineage never grants a different owner's or tenant's execution. A
  -- metadata-only tenant backfill may encounter its parent later in the same
  -- batch; unchanged historical edges are fenced by every chain read instead.
  IF TG_OP = 'INSERT' OR (NEW."retryOf" IS NOT NULL AND NEW."retryOf" IS DISTINCT FROM OLD."retryOf")
    OR (NEW."continuesRunId" IS NOT NULL AND NEW."continuesRunId" IS DISTINCT FROM OLD."continuesRunId")
    OR (NEW."questionContinuation" IS NOT NULL AND NEW."questionContinuation" IS DISTINCT FROM OLD."questionContinuation")
    OR NEW."agentDefinition" IS DISTINCT FROM OLD."agentDefinition"
    OR (NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('queued','preparing','running','waiting_input','finishing','paused')) THEN
    origin := NEW."questionContinuation"->>'originRunId';
    parents := ARRAY[NEW."retryOf", NEW."continuesRunId",
      CASE WHEN origin ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN origin::uuid END];
    IF EXISTS (SELECT 1 FROM unnest(parents) p(id) LEFT JOIN agent_runs r ON r.id=p.id
      WHERE p.id IS NOT NULL AND (r.id IS NULL OR tenant IS NULL OR r."workspaceId" IS DISTINCT FROM tenant OR r."userId" IS DISTINCT FROM NEW."userId")) THEN
      RAISE EXCEPTION 'taskWorkspaceMismatch' USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW."workspaceId" := tenant;
  RETURN NEW;
END;
$$;
CREATE TRIGGER require_run_task_workspace BEFORE INSERT OR UPDATE OF "workspaceId", "issueId", "botId", "agentDefinition", status, "userId", "retryOf", "continuesRunId", "questionContinuation" ON agent_runs
FOR EACH ROW EXECUTE FUNCTION require_run_task_workspace();
-- Scope now controls provider publication only. Shared tasks need no Team link.
DROP TRIGGER IF EXISTS require_run_issue_scope ON agent_runs;

CREATE FUNCTION require_factory_task_workspace() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tenant uuid; bot_tenant uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."workspaceId" IS NOT NULL AND NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId" THEN
    RAISE EXCEPTION 'taskWorkspaceTransferDenied' USING ERRCODE = '23514';
  END IF;
  SELECT "workspaceId" INTO tenant FROM issues WHERE id=NEW."issueId" FOR SHARE;
  IF tenant IS NULL THEN RAISE EXCEPTION 'taskWorkspaceUnresolved' USING ERRCODE = '23514'; END IF;
  IF NEW."workspaceId" IS NOT NULL AND NEW."workspaceId" <> tenant THEN
    RAISE EXCEPTION 'taskWorkspaceMismatch' USING ERRCODE = '23514';
  END IF;
  IF NEW."botId" IS NOT NULL THEN
    SELECT "workspaceId" INTO bot_tenant FROM bots WHERE id=NEW."botId";
    IF bot_tenant IS NULL OR bot_tenant <> tenant THEN RAISE EXCEPTION 'taskWorkspaceMismatch' USING ERRCODE = '23514'; END IF;
  END IF;
  NEW."workspaceId" := tenant;
  RETURN NEW;
END;
$$;
CREATE TRIGGER require_factory_task_workspace BEFORE INSERT OR UPDATE OF "workspaceId","issueId","botId" ON factory_tasks
FOR EACH ROW EXECUTE FUNCTION require_factory_task_workspace();

CREATE OR REPLACE FUNCTION require_run_child_issue_scope() RETURNS trigger LANGUAGE plpgsql AS $$
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
      IF sender_owner IS DISTINCT FROM NEW."userId" OR sender_tenant IS NULL
        OR lower(sender_tenant) <> tenant::text THEN
        RAISE EXCEPTION 'taskWorkspaceMismatch' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION require_artifact_task_workspace() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tenant uuid; task_tenant uuid; run_task uuid; run_tenant uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."workspaceId" IS NOT NULL AND NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId" THEN
    RAISE EXCEPTION 'taskWorkspaceTransferDenied' USING ERRCODE = '23514';
  END IF;
  tenant := NEW."workspaceId";
  IF NEW."issueId" IS NOT NULL THEN
    SELECT "workspaceId" INTO task_tenant FROM issues WHERE id = NEW."issueId" FOR SHARE;
    IF task_tenant IS NULL THEN RAISE EXCEPTION 'taskWorkspaceUnresolved' USING ERRCODE = '23514'; END IF;
    IF tenant IS NOT NULL AND tenant <> task_tenant THEN RAISE EXCEPTION 'taskWorkspaceMismatch' USING ERRCODE = '23514'; END IF;
    tenant := task_tenant;
  END IF;
  IF NEW."runId" IS NOT NULL THEN
    SELECT r."issueId", r."workspaceId" INTO run_task, run_tenant
    FROM agent_runs r WHERE r.id=NEW."runId" AND r."userId"=NEW."userId" FOR SHARE;
    IF run_tenant IS NULL OR (NEW."issueId" IS NOT NULL AND run_task IS DISTINCT FROM NEW."issueId")
      OR (tenant IS NOT NULL AND tenant <> run_tenant) THEN
      RAISE EXCEPTION 'taskWorkspaceMismatch' USING ERRCODE = '23514';
    END IF;
    tenant := run_tenant;
  END IF;
  NEW."workspaceId" := tenant;
  RETURN NEW;
END;
$$;
CREATE TRIGGER require_artifact_task_workspace BEFORE INSERT OR UPDATE OF "workspaceId", "runId", "issueId", "userId" ON artifacts
FOR EACH ROW EXECUTE FUNCTION require_artifact_task_workspace();

-- Retain Linear archival/tombstone semantics while decoupling tenant ACL.
create or replace function detach_personal_issue() returns trigger
language plpgsql as $$
declare archive_target jsonb;
begin
  if (new.scope='personal' and old.scope is distinct from new.scope)
    or (new."linearSyncPolicy"='disabled' and old."linearSyncPolicy"='explicit') then
    if new."scopeSetBy"='user' and current_setting('mikka.personal_scope_request',true)=new.id::text then
      select jsonb_build_object('ownerId',new."userId",'teamSyncId',l."teamSyncId",'linearTeamId',t."linearTeamId",
        'linearIssueId',l."linearIssueId",'sourceLinkId',l.id,'publicationId',l."publicationId",'organizationId',c."organizationId",
        'targetVerified',coalesce(l."externalTargetVerified" and l."ownerId"=new."userId" and t."ownerId"=new."userId"
          and new."ownershipState"='bound' and t."workspaceId"=new."workspaceId",false))
        into archive_target from linear_issue_links l join linear_team_syncs t on t.id=l."teamSyncId"
        left join linear_connections c on c."userId"=new."userId" where l."issueId"=new.id;
      if archive_target is null and (exists(select 1 from linear_issue_publications where "issueId"=new.id and "retiredAt" is null)
        or exists(select 1 from linear_sync_outbox where "issueId"=new.id and operation='sync' and status in ('queued','processing','failed'))) then
        -- Retain an unresolved legacy publication for review. An absent link is
        -- not authority to guess a team or mutate a remote issue.
        archive_target=jsonb_build_object('ownerId',new."userId",'teamSyncId',null,'linearTeamId',null,
          'linearIssueId',new.id::text,'sourceLinkId',null,'publicationId',null,'organizationId',null,'targetVerified',false);
      end if;
    end if;
    insert into linear_issue_detachments("linearIssueId","issueId","ownerId","teamSyncId","linearIdentifier","sourceLinkId","publicationId","externalTargetVerified")
      select "linearIssueId","issueId","ownerId","teamSyncId","linearIdentifier",id,"publicationId","externalTargetVerified"
      from linear_issue_links where "issueId"=new.id
      on conflict ("linearIssueId") do nothing;
    -- Includes a create whose HTTP response has not returned and has no link yet.
    insert into linear_issue_detachments("linearIssueId","issueId","ownerId","teamSyncId","publicationId")
      select "linearIssueId","issueId","ownerId","teamSyncId",id from linear_issue_publications
      where "issueId"=new.id and "retiredAt" is null
      on conflict ("linearIssueId") do update set "publicationId"=coalesce(linear_issue_detachments."publicationId",excluded."publicationId");
    -- Fence the legacy app-UUID identity even if an older create has no response
    -- or reservation. A guard-only row is not proof of a remote issue to archive.
    insert into linear_issue_detachments("linearIssueId","issueId","ownerId")
      values(new.id::text,new.id,new."userId") on conflict ("linearIssueId") do nothing;
    update linear_issue_publications set "retiredAt"=now() where "issueId"=new.id and "retiredAt" is null;
    delete from linear_issue_links where "issueId"=new.id;
    update linear_sync_outbox set status='done',"claimToken"=null,"lastError"=null,"updatedAt"=now()
      where "issueId"=new.id and operation='sync' and status in ('queued','processing','failed');
    if archive_target is not null then
      insert into linear_sync_outbox(id,"issueId","scopeVersion",operation,"archiveTarget")
        values(gen_random_uuid(),new.id,old."scopeVersion",'archive',archive_target);
    end if;
    -- Publication settings cannot revoke collaboration in a bound tenant.
    if new."workspaceId" is null then
      update run_tokens set "revokedAt"=now() where "revokedAt" is null and "runId" in
        (select id from agent_runs where "issueId"=new.id and "userId"<>new."userId");
      update agent_runs set status='cancelled',"stopRequestedAt"=now(),"finishedAt"=now(),"leaseExpiresAt"=null,
        "stopReason"='Task became personal',"updatedAt"=now()
        where "issueId"=new.id and "userId"<>new."userId" and status in ('queued','preparing','running','waiting_input','finishing');
    end if;
  end if;
  return new;
end;
$$;
DROP TRIGGER IF EXISTS detach_personal_issue ON issues;
CREATE TRIGGER detach_personal_issue AFTER UPDATE OF scope,"linearSyncPolicy" ON issues
FOR EACH ROW EXECUTE FUNCTION detach_personal_issue();
