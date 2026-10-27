-- Internal computer identity for the built-in Coordinator. The visible chat
-- remains the Coordinator's null-bot conversation; this row only supplies
-- the same owner/workspace boundary used by every other browser.
CREATE TABLE IF NOT EXISTS coordinator_web_bots (
  "workspaceId" uuid NOT NULL,
  "ownerId" text NOT NULL,
  "botId" uuid NOT NULL UNIQUE,
  PRIMARY KEY ("workspaceId", "ownerId"),
  FOREIGN KEY ("botId", "workspaceId", "ownerId") REFERENCES bots(id, "workspaceId", "ownerId") ON DELETE RESTRICT
);
