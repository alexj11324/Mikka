-- The Coordinator is a bot (glossary): each owner's Coordinator in a workspace
-- is an ordinary row in bots, named here. Its cloud runtime, desktop and run
-- bindings hang off that row like any bot's, so it never borrows another
-- bot's runtime (#727). Workspaces live in another database, so rows are
-- created on first use (ensureCoordinatorBot), not backfilled here.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
CREATE TABLE IF NOT EXISTS coordinator_bots (
  "ownerId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "workspaceId" uuid NOT NULL,
  "botId" uuid NOT NULL UNIQUE REFERENCES bots(id) ON DELETE CASCADE,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("ownerId", "workspaceId")
);
COMMIT;
