-- Personal settings in a workspace, matching bots' owner/workspace scope.
CREATE TABLE IF NOT EXISTS execution_rules (
  id uuid PRIMARY KEY,
  "ownerId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "workspaceId" uuid NOT NULL,
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
  place text NOT NULL DEFAULT 'auto',
  harness text NOT NULL DEFAULT 'auto' CHECK (harness IN ('auto','claude_code','codex','cursor')),
  model text NOT NULL DEFAULT 'auto',
  position integer NOT NULL CHECK (position >= 0),
  UNIQUE ("ownerId","workspaceId",position) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS execution_rules_scope_idx ON execution_rules ("ownerId","workspaceId");
CREATE TABLE IF NOT EXISTS bot_model_choices (
  "ownerId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "workspaceId" uuid NOT NULL,
  "botKey" text NOT NULL,
  "bindingId" uuid NOT NULL REFERENCES byos_bindings(id) ON DELETE CASCADE,
  PRIMARY KEY ("ownerId","workspaceId","botKey")
);
