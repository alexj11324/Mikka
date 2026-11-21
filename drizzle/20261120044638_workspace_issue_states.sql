-- target: MIKKA_DATABASE_URL
-- A workspace's own task states, as Capy's Issue states: each state has a name, an icon, a colour and one of the
-- seven workflow categories (backlog … duplicate), which fixes its type (open or closed). Each category keeps one
-- default state, which is where automatic moves (lib/task-status-advance.ts) and status-only writers land.
--
-- issues.status stays the category of the task's state, kept by a trigger in both directions, so every existing
-- reader and writer of `status` keeps its meaning while callers move to state_id:
--   * a write that sets state_id sets status to that state's category;
--   * a write that sets only status keeps the current state if it is of that category, else takes the category's
--     default (seeding the seven built-in states for a workspace that has none yet).
BEGIN;

CREATE TABLE IF NOT EXISTS workspace_issue_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  -- NULL: the category's own (translated) name. A rename stores the person's name.
  name varchar(60),
  icon text NOT NULL,
  color text NOT NULL,
  category text NOT NULL,
  type text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  position integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_issue_states_name_check CHECK (name IS NULL OR length(btrim(name)) BETWEEN 1 AND 60),
  CONSTRAINT workspace_issue_states_category_check CHECK (category IN ('backlog', 'todo', 'doing', 'review', 'done', 'canceled', 'duplicate')),
  CONSTRAINT workspace_issue_states_type_check CHECK (type = CASE WHEN category IN ('done', 'canceled', 'duplicate') THEN 'closed' ELSE 'open' END),
  CONSTRAINT workspace_issue_states_icon_check CHECK (icon IN ('dashed', 'empty', 'half', 'progress', 'check', 'x', 'slash', 'hand', 'question', 'alert', 'urgent')),
  CONSTRAINT workspace_issue_states_color_check CHECK (color IN ('gray', 'yellow', 'green', 'blue', 'purple', 'red')),
  CONSTRAINT workspace_issue_states_workspace_id_key UNIQUE (workspace_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_issue_states_default_idx ON workspace_issue_states (workspace_id, category) WHERE is_default;
CREATE UNIQUE INDEX IF NOT EXISTS workspace_issue_states_name_idx ON workspace_issue_states (workspace_id, lower(btrim(name))) WHERE name IS NOT NULL;
CREATE INDEX IF NOT EXISTS workspace_issue_states_position_idx ON workspace_issue_states (workspace_id, position);

-- The seven built-in states, once per workspace. Safe to call again and from concurrent writers.
CREATE OR REPLACE FUNCTION mikka_ensure_issue_states(target uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF target IS NULL OR EXISTS (SELECT 1 FROM workspace_issue_states WHERE workspace_id = target) THEN RETURN; END IF;
  INSERT INTO workspace_issue_states (workspace_id, icon, color, category, type, is_default, position)
  SELECT target, b.icon, b.color, b.category, CASE WHEN b.category IN ('done', 'canceled', 'duplicate') THEN 'closed' ELSE 'open' END, true, b.position
  FROM (VALUES ('backlog', 'dashed', 'gray', 1000), ('todo', 'empty', 'gray', 2000), ('doing', 'half', 'yellow', 3000),
               ('review', 'progress', 'green', 4000), ('done', 'check', 'purple', 5000), ('canceled', 'x', 'gray', 6000),
               ('duplicate', 'slash', 'gray', 7000)) AS b(category, icon, color, position)
  ON CONFLICT DO NOTHING;
END $$;

ALTER TABLE issues ADD COLUMN IF NOT EXISTS state_id uuid;

CREATE OR REPLACE FUNCTION mikka_sync_issue_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE chosen text;
BEGIN
  IF NEW."workspaceId" IS NULL THEN NEW.state_id := NULL; RETURN NEW; END IF;
  IF NEW.state_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.state_id IS DISTINCT FROM OLD.state_id) THEN
    SELECT category INTO chosen FROM workspace_issue_states WHERE id = NEW.state_id AND workspace_id = NEW."workspaceId";
    IF chosen IS NULL THEN
      RAISE EXCEPTION 'issue state % is not in workspace %', NEW.state_id, NEW."workspaceId" USING ERRCODE = 'foreign_key_violation';
    END IF;
    NEW.status := chosen;
    RETURN NEW;
  END IF;
  IF NEW.state_id IS NOT NULL THEN
    SELECT category INTO chosen FROM workspace_issue_states WHERE id = NEW.state_id AND workspace_id = NEW."workspaceId";
    IF chosen = NEW.status THEN RETURN NEW; END IF;
  END IF;
  PERFORM mikka_ensure_issue_states(NEW."workspaceId");
  SELECT id INTO NEW.state_id FROM workspace_issue_states WHERE workspace_id = NEW."workspaceId" AND category = NEW.status AND is_default;
  RETURN NEW;
END $$;

-- Named after preserve_task_workspace so the workspace is settled before the state is chosen (BEFORE triggers run by name).
DROP TRIGGER IF EXISTS sync_issue_state ON issues;
CREATE TRIGGER sync_issue_state BEFORE INSERT OR UPDATE OF status, state_id, "workspaceId" ON issues
  FOR EACH ROW EXECUTE FUNCTION mikka_sync_issue_state();

-- Backfill: seed every workspace that has tasks, then give every task its category's default state.
SELECT mikka_ensure_issue_states(w) FROM (SELECT DISTINCT "workspaceId" AS w FROM issues WHERE "workspaceId" IS NOT NULL) seeded;
UPDATE issues i SET state_id = s.id FROM workspace_issue_states s
  WHERE i.state_id IS NULL AND s.workspace_id = i."workspaceId" AND s.category = i.status AND s.is_default;

ALTER TABLE issues DROP CONSTRAINT IF EXISTS issues_state_fk;
ALTER TABLE issues ADD CONSTRAINT issues_state_fk FOREIGN KEY ("workspaceId", state_id)
  REFERENCES workspace_issue_states (workspace_id, id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS issues_state_idx ON issues (state_id);

COMMIT;
