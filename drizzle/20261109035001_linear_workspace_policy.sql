-- Provider authority is an explicit Task policy and a persisted tenant match.
-- Team grouping and the compatibility scope column never authorize publication.
CREATE OR REPLACE FUNCTION preserve_linear_workspace_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."workspaceId" IS NOT NULL AND (NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId"
    OR NEW."ownerId" IS DISTINCT FROM OLD."ownerId" OR NEW."linearTeamId" IS DISTINCT FROM OLD."linearTeamId") THEN
    RAISE EXCEPTION 'Linear workspace binding is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_linear_workspace_binding BEFORE UPDATE OF "workspaceId","ownerId","linearTeamId" ON linear_team_syncs
FOR EACH ROW EXECUTE FUNCTION preserve_linear_workspace_binding();

CREATE OR REPLACE FUNCTION prevent_blocked_linear_publish() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target issues%ROWTYPE; verified boolean;
BEGIN
  SELECT * INTO target FROM issues WHERE id=NEW."issueId" FOR SHARE;
  IF TG_TABLE_NAME='linear_sync_outbox' THEN
    IF NEW.operation='archive' THEN
      IF TG_OP='INSERT' AND (current_setting('mikka.personal_scope_request',true) IS DISTINCT FROM NEW."issueId"::text
        OR target.id IS NULL OR target."ownershipState" IS DISTINCT FROM 'bound'
        OR target."linearSyncPolicy" IS DISTINCT FROM 'disabled' OR target."scopeSetBy" IS DISTINCT FROM 'user'
        OR target."userId" IS DISTINCT FROM NEW."archiveTarget"->>'ownerId'
        OR target."scopeVersion" IS DISTINCT FROM NEW."scopeVersion"+1) THEN
        RAISE EXCEPTION 'Explicit owner provider-disable request required for Linear archive' USING ERRCODE='23514';
      END IF;
      -- Older workers cannot claim an archive as an ordinary stale sync.
      IF TG_OP='UPDATE' AND NEW.status='processing' AND
        (OLD.status IS DISTINCT FROM NEW.status OR OLD."claimToken" IS DISTINCT FROM NEW."claimToken") AND
        current_setting('mikka.linear_archive_claim',true) IS DISTINCT FROM NEW.id::text||':'||NEW."claimToken"::text THEN
        RETURN NULL;
      END IF;
      RETURN NEW;
    END IF;
    SELECT EXISTS (SELECT 1 FROM linear_issue_links l JOIN linear_team_syncs t ON t.id=l."teamSyncId"
      AND t."ownerId"=l."ownerId" AND t."workspaceId"=target."workspaceId" AND t.active
      WHERE l."issueId"=target.id AND l."ownerId"=target."userId" AND l."externalTargetVerified" AND l."remoteRemovedAt" IS NULL) INTO verified;
    IF target.id IS NULL OR target."ownershipState" IS DISTINCT FROM 'bound' OR target."linearSyncPolicy" IS DISTINCT FROM 'explicit'
      OR target."linearSyncBlocked" OR NEW."scopeVersion" IS DISTINCT FROM target."scopeVersion" OR NOT verified THEN
      IF TG_OP='INSERT' THEN RETURN NULL; END IF;
      IF NEW.status IN ('queued','processing') THEN
        NEW.status := 'failed'; NEW."claimToken" := NULL;
        NEW."lastError" := 'No active verified Linear issue link for this task';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF target.id IS NULL OR target."ownershipState" IS DISTINCT FROM 'bound' OR target."linearSyncPolicy" IS DISTINCT FROM 'explicit'
    OR target."linearSyncBlocked" OR target."userId" IS DISTINCT FROM NEW."ownerId"
    OR NOT EXISTS (SELECT 1 FROM linear_team_syncs t WHERE t.id=NEW."teamSyncId" AND t."ownerId"=target."userId"
      AND t."workspaceId"=target."workspaceId" AND t.active) THEN
    RAISE EXCEPTION 'Task has no authorized Linear target in this workspace' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION reject_detached_linear_link() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target issues%ROWTYPE; publication linear_issue_publications%ROWTYPE;
BEGIN
  SELECT * INTO target FROM issues WHERE id=NEW."issueId" FOR SHARE;
  IF target.id IS NULL OR target."ownershipState" IS DISTINCT FROM 'bound' OR target."linearSyncPolicy" IS DISTINCT FROM 'explicit'
    OR target."linearSyncBlocked" OR target."userId" IS DISTINCT FROM NEW."ownerId"
    OR NOT EXISTS (SELECT 1 FROM linear_team_syncs t WHERE t.id=NEW."teamSyncId" AND t."ownerId"=target."userId"
      AND t."workspaceId"=target."workspaceId" AND t.active)
    OR EXISTS (SELECT 1 FROM linear_issue_detachments WHERE "linearIssueId"=NEW."linearIssueId") THEN
    RAISE EXCEPTION 'Unauthorized or retired Linear identity cannot be linked' USING ERRCODE='23514';
  END IF;
  SELECT * INTO publication FROM linear_issue_publications WHERE "issueId"=NEW."issueId" AND "scopeVersion"=target."scopeVersion";
  IF NOT FOUND THEN
    INSERT INTO linear_issue_publications(id,"issueId","ownerId","teamSyncId","scopeVersion","linearIssueId")
      VALUES(coalesce(NEW."publicationId",gen_random_uuid()),NEW."issueId",NEW."ownerId",NEW."teamSyncId",target."scopeVersion",NEW."linearIssueId") RETURNING * INTO publication;
  END IF;
  IF publication."retiredAt" IS NOT NULL OR publication."linearIssueId"<>NEW."linearIssueId" OR publication."teamSyncId"<>NEW."teamSyncId"
    OR (NEW."publicationId" IS NOT NULL AND NEW."publicationId"<>publication.id) THEN
    RAISE EXCEPTION 'Linear link does not belong to the current publication' USING ERRCODE='23514';
  END IF;
  NEW."publicationId" := publication.id;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION preserve_linear_publication_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF OLD.id<>NEW.id OR OLD."issueId"<>NEW."issueId" OR OLD."ownerId"<>NEW."ownerId" OR OLD."teamSyncId"<>NEW."teamSyncId"
      OR OLD."scopeVersion"<>NEW."scopeVersion" OR OLD."linearIssueId"<>NEW."linearIssueId"
      OR (OLD."retiredAt" IS NOT NULL AND OLD."retiredAt" IS DISTINCT FROM NEW."retiredAt") THEN
      RAISE EXCEPTION 'Linear publication identity is immutable' USING ERRCODE='23514';
    END IF;
  ELSE
    PERFORM 1 FROM issues i JOIN linear_team_syncs t ON t.id=NEW."teamSyncId" AND t."ownerId"=i."userId"
      AND t."workspaceId"=i."workspaceId" AND t.active
      WHERE i.id=NEW."issueId" AND i."userId"=NEW."ownerId" AND i."ownershipState"='bound'
      AND i."linearSyncPolicy"='explicit' AND NOT i."linearSyncBlocked" AND i."scopeVersion"=NEW."scopeVersion" FOR SHARE;
    IF NOT FOUND OR EXISTS(SELECT 1 FROM linear_issue_detachments WHERE "linearIssueId"=NEW."linearIssueId") THEN
      RAISE EXCEPTION 'Linear publication is outside its authorized workspace generation' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION protect_verified_linear_target() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."externalTargetVerified" AND (TG_OP='INSERT' OR NOT OLD."externalTargetVerified") AND
    (current_setting('mikka.linear_sync_source',true) IS DISTINCT FROM 'linear'
      OR NOT EXISTS (SELECT 1 FROM issues i JOIN linear_team_syncs t ON t.id=NEW."teamSyncId" AND t."ownerId"=i."userId"
        AND t."workspaceId"=i."workspaceId" AND t.active
        WHERE i.id=NEW."issueId" AND i."userId"=NEW."ownerId" AND i."ownershipState"='bound'
          AND i."linearSyncPolicy"='explicit' AND NOT i."linearSyncBlocked")) THEN
    RAISE EXCEPTION 'Verified Linear target requires an authorized workspace import' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enqueue_linear_issue_sync() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_id uuid; target issues%ROWTYPE; old_metadata jsonb; new_metadata jsonb; target_metadata jsonb;
BEGIN
  IF current_setting('mikka.linear_sync_source',true)='linear' THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='issues' THEN
    target_id := NEW.id;
    IF TG_OP='UPDATE' THEN
      old_metadata := coalesce(nullif(OLD.content->'attrs'->'mikka','null'::jsonb),OLD.content->'attrs'->'orvilo');
      new_metadata := coalesce(nullif(NEW.content->'attrs'->'mikka','null'::jsonb),NEW.content->'attrs'->'orvilo');
      IF NOT (OLD.title IS DISTINCT FROM NEW.title OR OLD.status IS DISTINCT FROM NEW.status OR OLD.priority IS DISTINCT FROM NEW.priority
        OR OLD."linearSyncPolicy" IS DISTINCT FROM NEW."linearSyncPolicy"
        OR (OLD.content-'attrs') IS DISTINCT FROM (NEW.content-'attrs')
        OR old_metadata->>'assignee' IS DISTINCT FROM new_metadata->>'assignee'
        OR old_metadata->>'labels' IS DISTINCT FROM new_metadata->>'labels'
        OR old_metadata->>'dueDate' IS DISTINCT FROM new_metadata->>'dueDate'
        OR old_metadata->>'deletedAt' IS DISTINCT FROM new_metadata->>'deletedAt') THEN
        UPDATE linear_issue_links SET "appSyncedAt"=NEW."updatedAt","updatedAt"=now()
          WHERE "issueId"=NEW.id AND "appSyncedAt" IS NOT NULL AND "appSyncedAt">=OLD."updatedAt";
        RETURN NEW;
      END IF;
    END IF;
  ELSE target_id := NEW."issueId";
  END IF;
  SELECT * INTO target FROM issues WHERE id=target_id;
  target_metadata := coalesce(nullif(target.content->'attrs'->'mikka','null'::jsonb),target.content->'attrs'->'orvilo');
  IF target.id IS NULL OR target."ownershipState" IS DISTINCT FROM 'bound' OR target."linearSyncPolicy" IS DISTINCT FROM 'explicit'
    OR target."linearSyncBlocked" OR target_metadata->>'deletedAt' IS NOT NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM linear_issue_links l JOIN linear_team_syncs t ON t.id=l."teamSyncId" AND t."ownerId"=l."ownerId"
    AND t."workspaceId"=target."workspaceId" AND t.active
    WHERE l."issueId"=target.id AND l."ownerId"=target."userId" AND l."externalTargetVerified" AND l."remoteRemovedAt" IS NULL) THEN RETURN NEW; END IF;
  UPDATE linear_sync_outbox SET status='done',"lastError"=NULL,"updatedAt"=now()
    WHERE "issueId"=target.id AND operation='sync' AND status='failed';
  INSERT INTO linear_sync_outbox(id,"issueId","scopeVersion") VALUES(gen_random_uuid(),target.id,target."scopeVersion")
    ON CONFLICT ("issueId") WHERE operation='sync' AND status IN ('queued','processing')
    DO UPDATE SET "availableAt"=now(),"lastError"=NULL,"updatedAt"=now();
  RETURN NEW;
END;
$$;
