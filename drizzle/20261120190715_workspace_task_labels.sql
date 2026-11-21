-- target: MIKKA_DATABASE_URL

-- Additive and repeatable. Existing issue_versions remain immutable. Historical
-- tasks without a workspace, and malformed legacy label metadata, stay untouched.
-- Rollback: first revert callers, then remove the two triggers/functions and the
-- new tables/index. Keep the compatibility labels snapshots on tasks; no old
-- migration is edited and no production data needs to be deleted.

CREATE TABLE IF NOT EXISTS workspace_issue_labels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  name varchar(40) NOT NULL CHECK (name=btrim(name) AND length(name)>0),
  color text NOT NULL CHECK (color IN ('violet','blue','green','yellow','red','gray')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_issue_labels_name_key ON workspace_issue_labels(workspace_id,lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS issues_id_workspace_labels_key ON issues(id,"workspaceId");

CREATE TABLE IF NOT EXISTS issue_label_refs (
  issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  label_id uuid NOT NULL,
  position smallint NOT NULL CHECK (position BETWEEN 0 AND 11),
  PRIMARY KEY (issue_id,label_id),
  FOREIGN KEY (workspace_id,label_id) REFERENCES workspace_issue_labels(workspace_id,id),
  FOREIGN KEY (issue_id,workspace_id) REFERENCES issues(id,"workspaceId") DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS issue_label_refs_label_idx ON issue_label_refs(workspace_id,label_id,issue_id);

-- Only readable legacy arrays participate. Case-insensitive duplicates become
-- one entity; its spelling/color comes from the earliest task, then array order.
WITH candidates AS (
  SELECT i.id,i."workspaceId" AS workspace_id,i."createdAt",l.value,l.ordinality
  FROM issues i CROSS JOIN LATERAL (SELECT coalesce(i.content->'attrs'->'mikka',i.content->'attrs'->'orvilo')->'labels' AS labels) m
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(m.labels)='array' THEN m.labels ELSE '[]'::jsonb END) WITH ORDINALITY l(value,ordinality)
  WHERE i."workspaceId" IS NOT NULL AND jsonb_typeof(m.labels)='array' AND jsonb_array_length(m.labels)<=12
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(m.labels) v WHERE jsonb_typeof(v->'name') IS DISTINCT FROM 'string'
      OR length(btrim(v->>'name')) NOT BETWEEN 1 AND 40 OR (v->>'color') IS NULL OR v->>'color' NOT IN ('violet','blue','green','yellow','red','gray'))
), chosen AS (
  SELECT DISTINCT ON (workspace_id,lower(btrim(value->>'name'))) workspace_id,btrim(value->>'name') AS name,value->>'color' AS color
  FROM candidates ORDER BY workspace_id,lower(btrim(value->>'name')),"createdAt",id,ordinality
)
INSERT INTO workspace_issue_labels(workspace_id,name,color) SELECT workspace_id,name,color FROM chosen
ON CONFLICT (workspace_id,lower(name)) DO NOTHING;

CREATE OR REPLACE FUNCTION mikka_canonical_issue_labels(target uuid,incoming jsonb,previous jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  requested jsonb; item jsonb; label workspace_issue_labels%ROWTYPE;
  by_id boolean; ids jsonb := '[]'::jsonb; snapshots jsonb := '[]'::jsonb;
BEGIN
  IF jsonb_typeof(incoming) IS DISTINCT FROM 'object' THEN RETURN incoming; END IF;
  IF NOT (incoming ? 'labels') AND NOT (incoming ? 'labelIds') THEN RETURN incoming; END IF;
  by_id := incoming ? 'labelIds' AND (previous IS NULL OR incoming->'labelIds' IS DISTINCT FROM previous->'labelIds'
    OR incoming->'labels' IS NOT DISTINCT FROM previous->'labels');
  requested := CASE WHEN by_id THEN incoming->'labelIds' ELSE incoming->'labels' END;
  -- Corrupt historical documents already read as no metadata. Do not rewrite
  -- them or infer labels from an invalid array while backfilling another field.
  IF NOT by_id AND (jsonb_typeof(requested) IS DISTINCT FROM 'array' OR jsonb_array_length(requested)>12) THEN RETURN incoming; END IF;
  IF jsonb_typeof(requested) IS DISTINCT FROM 'array' OR jsonb_array_length(requested)>12 THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Invalid task label references',CONSTRAINT='issue_labels_workspace_reference';
  END IF;
  IF NOT by_id AND EXISTS (SELECT 1 FROM jsonb_array_elements(requested) v WHERE jsonb_typeof(v->'name') IS DISTINCT FROM 'string'
      OR length(btrim(v->>'name')) NOT BETWEEN 1 AND 40 OR (v->>'color') IS NULL OR v->>'color' NOT IN ('violet','blue','green','yellow','red','gray')) THEN RETURN incoming; END IF;
  IF NOT by_id AND jsonb_array_length(requested)=0 AND NOT (incoming ? 'labelIds') THEN RETURN incoming; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(requested) LOOP
    IF by_id THEN
      IF jsonb_typeof(item) IS DISTINCT FROM 'string' OR (item#>>'{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Invalid task label references',CONSTRAINT='issue_labels_workspace_reference';
      END IF;
      SELECT * INTO label FROM workspace_issue_labels WHERE workspace_id=target AND id=(item#>>'{}')::uuid FOR SHARE NOWAIT;
    ELSE
      SELECT * INTO label FROM workspace_issue_labels WHERE workspace_id=target AND lower(name)=lower(btrim(item->>'name')) FOR SHARE NOWAIT;
    END IF;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Task label must reference an existing workspace label',CONSTRAINT='issue_labels_workspace_reference';
    END IF;
    IF NOT ids @> jsonb_build_array(label.id) THEN
      ids := ids || jsonb_build_array(label.id);
      snapshots := snapshots || jsonb_build_array(jsonb_build_object('name',label.name,'color',label.color));
    END IF;
  END LOOP;
  RETURN incoming || jsonb_build_object('labelIds',ids,'labels',snapshots);
END $$;

CREATE OR REPLACE FUNCTION mikka_sync_issue_labels() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE metadata_key text; incoming jsonb; previous jsonb; canonical jsonb;
BEGIN
  IF NEW."workspaceId" IS NULL THEN RETURN NEW; END IF;
  metadata_key := CASE WHEN NEW.content->'attrs' ? 'mikka' THEN 'mikka' ELSE 'orvilo' END;
  incoming := NEW.content->'attrs'->metadata_key;
  IF TG_OP='UPDATE' THEN
    previous := coalesce(OLD.content->'attrs'->'mikka',OLD.content->'attrs'->'orvilo');
    IF NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId" THEN
      -- An explicit tenant move may only resolve names already present in the
      -- destination. A source label ID can never become a cross-tenant ref.
      incoming := incoming-'labelIds'; previous := NULL;
    END IF;
  END IF;
  canonical := mikka_canonical_issue_labels(NEW."workspaceId",incoming,previous);
  IF canonical IS DISTINCT FROM incoming THEN
    NEW.content := jsonb_set(NEW.content,ARRAY['attrs',metadata_key],canonical,true);
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION mikka_sync_issue_label_refs() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE metadata jsonb;
BEGIN
  DELETE FROM issue_label_refs WHERE issue_id=NEW.id;
  metadata := coalesce(NEW.content->'attrs'->'mikka',NEW.content->'attrs'->'orvilo');
  IF NEW."workspaceId" IS NOT NULL AND jsonb_typeof(metadata->'labelIds')='array' THEN
    INSERT INTO issue_label_refs(issue_id,workspace_id,label_id,position)
      SELECT NEW.id,NEW."workspaceId",(value#>>'{}')::uuid,(ordinality-1)::smallint
      FROM jsonb_array_elements(metadata->'labelIds') WITH ORDINALITY;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS sync_issue_labels ON issues;
CREATE TRIGGER sync_issue_labels BEFORE INSERT OR UPDATE OF content,"workspaceId" ON issues FOR EACH ROW EXECUTE FUNCTION mikka_sync_issue_labels();
DROP TRIGGER IF EXISTS sync_issue_label_refs ON issues;
CREATE TRIGGER sync_issue_label_refs AFTER INSERT OR UPDATE OF content,"workspaceId" ON issues FOR EACH ROW EXECUTE FUNCTION mikka_sync_issue_label_refs();

UPDATE issues SET content=content WHERE "workspaceId" IS NOT NULL
  AND jsonb_typeof(coalesce(content->'attrs'->'mikka',content->'attrs'->'orvilo')->'labels')='array';
