-- APP: issued task identifiers and historical aliases are not authorization.
-- Split deployments only read WS team aliases through the server-side store.
ALTER TABLE issues ADD COLUMN IF NOT EXISTS "issuedIdentifier" text;

CREATE TABLE IF NOT EXISTS task_identifier_aliases (
  "issueId" uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  "workspaceId" uuid,
  "ownerId" text NOT NULL,
  identifier text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('owner', 'publication', 'linear', 'team', 'issued')),
  "wasWorkspace" boolean NOT NULL DEFAULT false,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("issueId", identifier, kind)
);
CREATE INDEX IF NOT EXISTS task_identifier_aliases_lookup_idx
  ON task_identifier_aliases ("workspaceId", identifier, "ownerId");

CREATE TABLE IF NOT EXISTS workspace_task_identifier_counters (
  "workspaceId" uuid PRIMARY KEY,
  prefix text NOT NULL UNIQUE,
  "lastNumber" bigint NOT NULL DEFAULT 0 CHECK ("lastNumber" BETWEEN 0 AND 9007199254740991)
);

CREATE OR REPLACE FUNCTION task_owner_identifier(owner_id text, task_content jsonb) RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE prefix_value text; number_value text;
BEGIN
  SELECT coalesce(p.prefix, substring(upper(regexp_replace(split_part(u.email, '@', 1), '[^a-zA-Z]', '', 'g')), 1, 4))
    INTO prefix_value FROM "user" u LEFT JOIN issue_prefixes p ON p."userId"=u.id WHERE u.id=owner_id;
  IF prefix_value IS NULL OR prefix_value !~ '^[A-Z]{4}$' OR EXISTS (
    SELECT 1 FROM linear_team_syncs l WHERE l."ownerId"=owner_id AND upper(l."linearTeamKey")=prefix_value
  ) THEN prefix_value := 'TASK'; END IF;
  number_value := coalesce(task_content #>> '{attrs,mikka,number}', task_content #>> '{attrs,orvilo,number}');
  IF number_value IS NULL OR number_value !~ '^[1-9][0-9]*$' THEN RETURN NULL; END IF;
  RETURN prefix_value || '-' || number_value;
END $$;

-- Freeze the pre-migration owner spelling before a prefix/email changes. Keep
-- all publication spellings, including ones superseded by a former Team move.
INSERT INTO task_identifier_aliases ("issueId", "workspaceId", "ownerId", identifier, kind, "wasWorkspace", "createdAt")
SELECT id, "workspaceId", "userId", task_owner_identifier("userId", content), 'owner', scope='workspace', "createdAt"
FROM issues WHERE "issuedIdentifier" IS NULL AND task_owner_identifier("userId", content) IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO task_identifier_aliases ("issueId", "workspaceId", "ownerId", identifier, kind)
SELECT i.id, i."workspaceId", i."userId", l."linearIdentifier", 'linear'
FROM issues i JOIN linear_issue_links l ON l."issueId"=i.id AND l."ownerId"=i."userId"
WHERE l."linearIdentifier" IS NOT NULL AND l."linearIdentifier"<>'' ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION record_linear_task_identifier_alias() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') AND OLD."linearIdentifier" IS NOT NULL AND OLD."linearIdentifier"<>'' THEN
    INSERT INTO task_identifier_aliases ("issueId","workspaceId","ownerId",identifier,kind)
      SELECT i.id,i."workspaceId",i."userId",OLD."linearIdentifier",'linear' FROM issues i
      WHERE i.id=OLD."issueId" AND i."userId"=OLD."ownerId" ON CONFLICT DO NOTHING;
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') AND NEW."linearIdentifier" IS NOT NULL AND NEW."linearIdentifier"<>'' THEN
    INSERT INTO task_identifier_aliases ("issueId","workspaceId","ownerId",identifier,kind)
      SELECT i.id,i."workspaceId",i."userId",NEW."linearIdentifier",'linear' FROM issues i
      WHERE i.id=NEW."issueId" AND i."userId"=NEW."ownerId" ON CONFLICT DO NOTHING;
  END IF;
  RETURN coalesce(NEW,OLD);
END $$;
DROP TRIGGER IF EXISTS record_linear_task_identifier_alias ON linear_issue_links;
CREATE TRIGGER record_linear_task_identifier_alias AFTER INSERT OR UPDATE OR DELETE ON linear_issue_links
FOR EACH ROW EXECUTE FUNCTION record_linear_task_identifier_alias();
-- Publication receipts remain in run_publications. Import their aliases after
-- P0 has established Task/Run tenancy (230007 and the migration backfill), so
-- creator and peer executions use the same structural proof.

CREATE OR REPLACE FUNCTION allocate_workspace_task_identifier(workspace_id uuid) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE candidate_prefix text; candidate text;
BEGIN
  -- Thirteen characters exceed the Team key's maximum (12), and cannot
  -- overlap a personal prefix (4). The UNIQUE constraint guards UUID prefixes.
  candidate_prefix := 'W' || upper(substring(replace(workspace_id::text, '-', ''), 1, 12));
  BEGIN
    INSERT INTO workspace_task_identifier_counters ("workspaceId", prefix) VALUES (workspace_id, candidate_prefix)
      ON CONFLICT ("workspaceId") DO NOTHING;
  EXCEPTION WHEN unique_violation THEN
    INSERT INTO workspace_task_identifier_counters ("workspaceId", prefix)
      VALUES (workspace_id, 'W' || upper(replace(workspace_id::text, '-', '')))
      ON CONFLICT ("workspaceId") DO NOTHING;
  END;
  LOOP
    UPDATE workspace_task_identifier_counters SET "lastNumber"="lastNumber"+1
      WHERE "workspaceId"=workspace_id AND "lastNumber"<9007199254740991
      RETURNING prefix || '-' || "lastNumber"::text INTO candidate;
    IF candidate IS NULL THEN RAISE EXCEPTION 'Task identifier counter exhausted' USING ERRCODE='23514'; END IF;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM task_identifier_aliases WHERE "workspaceId"=workspace_id AND identifier=candidate);
  END LOOP;
  RETURN candidate;
END $$;

CREATE OR REPLACE FUNCTION preserve_issued_task_identifier() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD."issuedIdentifier" IS NOT NULL AND NEW."issuedIdentifier" IS DISTINCT FROM OLD."issuedIdentifier" THEN
    RAISE EXCEPTION 'An issued task identifier is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' AND NEW."issuedIdentifier" IS NULL AND NEW."workspaceId" IS NOT NULL THEN
    IF NEW.scope='workspace' THEN NEW."issuedIdentifier" := allocate_workspace_task_identifier(NEW."workspaceId");
    ELSE NEW."issuedIdentifier" := task_owner_identifier(NEW."userId", NEW.content); END IF;
  END IF;
  IF TG_OP='INSERT' AND NEW."workspaceId" IS NOT NULL AND (NEW."issuedIdentifier" IS NULL OR NEW."issuedIdentifier"='') THEN
    RAISE EXCEPTION 'A new bound task requires an issued identifier' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS preserve_issued_task_identifier ON issues;
-- assign_issue_number runs first; every new bound task is issued in its APP transaction.
CREATE TRIGGER preserve_issued_task_identifier BEFORE INSERT OR UPDATE OF "issuedIdentifier" ON issues
FOR EACH ROW EXECUTE FUNCTION preserve_issued_task_identifier();

CREATE OR REPLACE FUNCTION record_issued_task_identifier() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."issuedIdentifier" IS NOT NULL THEN
    INSERT INTO task_identifier_aliases ("issueId", "workspaceId", "ownerId", identifier, kind)
      VALUES (NEW.id, NEW."workspaceId", NEW."userId", NEW."issuedIdentifier", 'issued') ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS record_issued_task_identifier ON issues;
CREATE TRIGGER record_issued_task_identifier AFTER INSERT OR UPDATE OF "issuedIdentifier" ON issues
FOR EACH ROW EXECUTE FUNCTION record_issued_task_identifier();

-- A row lock, the chosen identifier, and its aliases commit in APP together.
-- The WS candidate is a historical snapshot, never a caller-supplied API field.
CREATE OR REPLACE FUNCTION ensure_task_identifier(task_id uuid, team_alias text DEFAULT NULL) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE task_row issues%ROWTYPE; candidate text; legacy_owner text; legacy_workspace boolean;
BEGIN
  SELECT * INTO task_row FROM issues WHERE id=task_id FOR UPDATE;
  IF NOT FOUND OR task_row."workspaceId" IS NULL THEN RETURN NULL; END IF;
  IF task_row."issuedIdentifier" IS NOT NULL THEN RETURN task_row."issuedIdentifier"; END IF;
  SELECT identifier INTO candidate FROM task_identifier_aliases
    WHERE "issueId"=task_id AND "ownerId"=task_row."userId" AND "workspaceId"=task_row."workspaceId"
      AND kind='publication' ORDER BY "createdAt", identifier LIMIT 1;
  SELECT identifier, "wasWorkspace" INTO legacy_owner, legacy_workspace FROM task_identifier_aliases
    WHERE "issueId"=task_id AND "ownerId"=task_row."userId" AND "workspaceId"=task_row."workspaceId"
      AND kind='owner' ORDER BY "createdAt", identifier LIMIT 1;
  IF candidate IS NULL AND coalesce(legacy_workspace, task_row.scope='workspace') AND team_alias IS NOT NULL THEN candidate := team_alias; END IF;
  candidate := coalesce(candidate, legacy_owner);
  IF candidate IS NULL THEN
    IF task_row.scope='workspace' THEN candidate := allocate_workspace_task_identifier(task_row."workspaceId");
    ELSE candidate := task_owner_identifier(task_row."userId", task_row.content); END IF;
  END IF;
  IF candidate IS NULL THEN RAISE EXCEPTION 'Task identifier unavailable' USING ERRCODE='23514'; END IF;
  UPDATE issues SET "issuedIdentifier"=candidate WHERE id=task_id;
  RETURN candidate;
END $$;

-- Existing tasks are issued only after both databases and P0 ownership have
-- migrated. A peer's earlier publication is authoritative too, but its Run
-- tenant cannot be proved until P0 backfill finishes. Issuing an owner prefix
-- here would freeze the wrong spelling before that receipt is imported.

-- Current metadata adopts distinct responsibility/delegation. Version history
-- and frozen Run/AgentProfile/publication receipts remain byte-for-byte intact.
UPDATE issues i SET content=jsonb_set(i.content, '{attrs}',
  (coalesce(i.content->'attrs', '{}'::jsonb)-'orvilo') || jsonb_build_object('mikka',
    (coalesce(i.content #> '{attrs,mikka}', i.content #> '{attrs,orvilo}')-'assignee') ||
    jsonb_build_object('assignee', NULL, 'delegate', CASE
      WHEN coalesce(i.content #> '{attrs,mikka}', i.content #> '{attrs,orvilo}') ? 'delegate'
        THEN coalesce(i.content #> '{attrs,mikka,delegate}', i.content #> '{attrs,orvilo,delegate}')
      WHEN EXISTS (SELECT 1 FROM bots b WHERE b.id::text=coalesce(i.content #>> '{attrs,mikka,assignee,id}',i.content #>> '{attrs,orvilo,assignee,id}') AND b."workspaceId"=i."workspaceId")
        THEN coalesce(i.content #> '{attrs,mikka,assignee}', i.content #> '{attrs,orvilo,assignee}') || '{"kind":"bot"}'::jsonb
      ELSE coalesce(i.content #> '{attrs,mikka,assignee}', i.content #> '{attrs,orvilo,assignee}') END)))
WHERE coalesce(i.content #>> '{attrs,mikka,assignee,kind}', i.content #>> '{attrs,orvilo,assignee,kind}')='agent';
