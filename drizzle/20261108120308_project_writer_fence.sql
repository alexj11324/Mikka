-- target: DATABASE_URL
-- A rolling deployment can still have an old Project writer after the backfill
-- commits. Retired JSON fields must not acknowledge writes that canonical
-- readers will never see. Preserve old quarantined rows as migration evidence.
CREATE FUNCTION fence_project_v2_writes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."workspaceId" IS NULL THEN
      RAISE EXCEPTION 'projectWorkspaceRequired' USING ERRCODE = '23514';
    END IF;
    IF NEW."issueIds" IS DISTINCT FROM '[]'::jsonb THEN
      RAISE EXCEPTION 'projectLegacyWriteDenied' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  -- This VOLATILE trigger performs a fresh receipt lookup after acquiring the
  -- row lock, including when an old UPDATE waited behind the backfill commit.
  IF EXISTS (SELECT 1 FROM workspace_project_v2_migrations WHERE "projectId" = OLD.id) THEN
    IF NEW."issueIds" IS DISTINCT FROM OLD."issueIds"
       OR NEW."userId" IS DISTINCT FROM OLD."userId" THEN
      RAISE EXCEPTION 'projectLegacyWriteDenied' USING ERRCODE = '23514';
    END IF;
    IF (NEW.lead IS DISTINCT FROM OLD.lead
        OR NEW.properties->'members' IS DISTINCT FROM OLD.properties->'members')
       AND current_setting('mikka.project_v2_writer', true) IS DISTINCT FROM '1' THEN
      RAISE EXCEPTION 'projectLegacyWriteDenied' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- The transaction-local marker is only a writer-version handshake. It grants
-- no permissions: new APIs still require live Workspace membership, token
-- scope, Project write access and active member IDs before setting it.
CREATE TRIGGER workspace_projects_v2_writer_fence
  BEFORE INSERT OR UPDATE ON workspace_projects
  FOR EACH ROW EXECUTE FUNCTION fence_project_v2_writes();
