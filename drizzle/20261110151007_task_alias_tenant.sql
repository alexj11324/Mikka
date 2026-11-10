-- APP: finish alias projection only from already proven Task/Run tenancy.
-- The migration runner invokes this in bounded batches after P0 backfill,
-- including tasks whose immutable identifier was issued by an earlier build.
-- A fresh database reaches this file before task_workspace_ownership declares
-- the tenant columns; the trigger below needs both names to exist.
ALTER TABLE issues ADD COLUMN IF NOT EXISTS "workspaceId" uuid;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS "ownershipState" text NOT NULL DEFAULT 'pending';
CREATE OR REPLACE FUNCTION reconcile_bound_task_identifier_aliases(task_ids uuid[])
RETURNS TABLE (bound_aliases bigint, publication_aliases bigint)
LANGUAGE plpgsql AS $$
DECLARE bound_count bigint; publication_count bigint;
BEGIN
  -- Match issuance/deletion order: Task rows first, then their alias rows.
  PERFORM i.id FROM issues i WHERE i.id=ANY(task_ids) AND i."ownershipState"='bound'
    AND i."workspaceId" IS NOT NULL ORDER BY i.id FOR UPDATE;
  UPDATE task_identifier_aliases a SET "workspaceId"=i."workspaceId"
  FROM issues i WHERE i.id=ANY(task_ids) AND a."issueId"=i.id
    AND a."ownerId"=i."userId" AND a."workspaceId" IS NULL
    AND i."ownershipState"='bound' AND i."workspaceId" IS NOT NULL;
  GET DIAGNOSTICS bound_count = ROW_COUNT;

  -- A Run belongs to its executor, who need not be the Task's creator.
  -- Preserve that receipt as an alias of the Task without granting Run access.
  INSERT INTO task_identifier_aliases ("issueId","workspaceId","ownerId",identifier,kind,"createdAt")
  SELECT i.id,i."workspaceId",i."userId",p.identifier,'publication',min(p."createdAt")
  FROM issues i JOIN run_publications p ON p."issueId"=i.id
  JOIN agent_runs r ON r.id=p."runId" AND r."issueId"=p."issueId" AND r."userId"=p."userId"
    AND r."workspaceId"=i."workspaceId"
  WHERE i.id=ANY(task_ids) AND i."ownershipState"='bound' AND i."workspaceId" IS NOT NULL
    AND p.identifier IS NOT NULL AND p.identifier<>''
  GROUP BY i.id,i."workspaceId",i."userId",p.identifier
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS publication_count = ROW_COUNT;
  RETURN QUERY SELECT bound_count, publication_count;
END $$;

CREATE OR REPLACE FUNCTION bind_task_identifier_alias_tenant() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."ownershipState"='bound' AND NEW."workspaceId" IS NOT NULL THEN
    PERFORM * FROM reconcile_bound_task_identifier_aliases(ARRAY[NEW.id]);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS bind_task_identifier_alias_tenant ON issues;
CREATE TRIGGER bind_task_identifier_alias_tenant AFTER UPDATE OF "workspaceId","ownershipState" ON issues
FOR EACH ROW EXECUTE FUNCTION bind_task_identifier_alias_tenant();

-- Reinstall the checked chooser for databases that already applied 230001.
-- An erroneous foreign-owner/foreign-tenant alias is not repaired or adopted.
CREATE OR REPLACE FUNCTION ensure_task_identifier(task_id uuid, team_alias text DEFAULT NULL) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE task_row issues%ROWTYPE; candidate text; legacy_owner text; legacy_workspace boolean;
BEGIN
  SELECT * INTO task_row FROM issues WHERE id=task_id FOR UPDATE;
  IF NOT FOUND OR task_row."workspaceId" IS NULL THEN RETURN NULL; END IF;
  IF task_row."issuedIdentifier" IS NOT NULL THEN RETURN task_row."issuedIdentifier"; END IF;
  SELECT identifier INTO candidate FROM task_identifier_aliases
    WHERE "issueId"=task_id AND "ownerId"=task_row."userId" AND "workspaceId"=task_row."workspaceId"
      AND kind='publication' ORDER BY "createdAt",identifier LIMIT 1;
  SELECT identifier,"wasWorkspace" INTO legacy_owner,legacy_workspace FROM task_identifier_aliases
    WHERE "issueId"=task_id AND "ownerId"=task_row."userId" AND "workspaceId"=task_row."workspaceId"
      AND kind='owner' ORDER BY "createdAt",identifier LIMIT 1;
  IF candidate IS NULL AND coalesce(legacy_workspace,task_row.scope='workspace') AND team_alias IS NOT NULL THEN candidate := team_alias; END IF;
  candidate := coalesce(candidate,legacy_owner);
  IF candidate IS NULL THEN
    IF task_row.scope='workspace' THEN candidate := allocate_workspace_task_identifier(task_row."workspaceId");
    ELSE candidate := task_owner_identifier(task_row."userId",task_row.content); END IF;
  END IF;
  IF candidate IS NULL THEN RAISE EXCEPTION 'Task identifier unavailable' USING ERRCODE='23514'; END IF;
  UPDATE issues SET "issuedIdentifier"=candidate WHERE id=task_id;
  RETURN candidate;
END $$;
