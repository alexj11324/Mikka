-- target: DATABASE_URL
-- WS retains Team aliases independently of Team lifetime. Aliases grant no ACL.
CREATE TABLE IF NOT EXISTS mikka_task_identifier_aliases (
  "issueId" uuid NOT NULL,
  "workspaceId" uuid NOT NULL REFERENCES mikka_workspaces(id) ON DELETE CASCADE,
  "ownerId" text NOT NULL,
  identifier text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("issueId", identifier)
);
CREATE INDEX IF NOT EXISTS mikka_task_identifier_aliases_lookup_idx
  ON mikka_task_identifier_aliases ("workspaceId", identifier, "ownerId");
INSERT INTO mikka_task_identifier_aliases ("issueId", "workspaceId", "ownerId", identifier, "createdAt")
SELECT l."issueId", l."workspaceId", l."userId", t.identifier || '-' || l.number::text, l."createdAt"
FROM mikka_team_issues l JOIN mikka_teams t ON t.id=l."teamId" AND t."workspaceId"=l."workspaceId"
WHERE l.number>0 ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION record_team_task_identifier_alias() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    INSERT INTO mikka_task_identifier_aliases ("issueId", "workspaceId", "ownerId", identifier)
      SELECT OLD."issueId", OLD."workspaceId", OLD."userId", t.identifier || '-' || OLD.number::text
      FROM mikka_teams t WHERE t.id=OLD."teamId" AND t."workspaceId"=OLD."workspaceId" AND OLD.number>0
        AND EXISTS (SELECT 1 FROM mikka_workspaces w WHERE w.id=OLD."workspaceId")
      ON CONFLICT DO NOTHING;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    INSERT INTO mikka_task_identifier_aliases ("issueId", "workspaceId", "ownerId", identifier)
      SELECT NEW."issueId", NEW."workspaceId", NEW."userId", t.identifier || '-' || NEW.number::text
      FROM mikka_teams t WHERE t.id=NEW."teamId" AND t."workspaceId"=NEW."workspaceId" AND NEW.number>0
        AND EXISTS (SELECT 1 FROM mikka_workspaces w WHERE w.id=NEW."workspaceId")
      ON CONFLICT DO NOTHING;
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;
DROP TRIGGER IF EXISTS record_team_task_identifier_alias ON mikka_team_issues;
CREATE TRIGGER record_team_task_identifier_alias AFTER INSERT OR UPDATE OR DELETE ON mikka_team_issues
FOR EACH ROW EXECUTE FUNCTION record_team_task_identifier_alias();

CREATE OR REPLACE FUNCTION record_renamed_team_task_aliases() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.identifier IS DISTINCT FROM OLD.identifier THEN
    INSERT INTO mikka_task_identifier_aliases ("issueId", "workspaceId", "ownerId", identifier)
      SELECT l."issueId", l."workspaceId", l."userId", key || '-' || l.number::text
      FROM mikka_team_issues l CROSS JOIN unnest(ARRAY[OLD.identifier, NEW.identifier]) AS key
      WHERE l."teamId"=NEW.id AND l."workspaceId"=NEW."workspaceId" AND l.number>0 ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS record_renamed_team_task_aliases ON mikka_teams;
CREATE TRIGGER record_renamed_team_task_aliases AFTER UPDATE OF identifier ON mikka_teams
FOR EACH ROW EXECUTE FUNCTION record_renamed_team_task_aliases();
