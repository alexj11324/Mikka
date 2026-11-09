-- Round-zero settings and inbox consumption commit before prompt preparation.
-- Receipts carry no credentials and confer no lease or execution authority.
CREATE TABLE coordinator_startup_receipts (
  "userId" text NOT NULL,
  "botId" uuid NOT NULL,
  holder text NOT NULL,
  round integer NOT NULL CONSTRAINT coordinator_startup_receipts_round_check CHECK (round = 0),
  version integer NOT NULL DEFAULT 1 CONSTRAINT coordinator_startup_receipts_version_check CHECK (version = 1),
  settings jsonb NOT NULL CONSTRAINT coordinator_startup_receipts_settings_check CHECK (jsonb_typeof(settings) = 'object'),
  inbox jsonb NOT NULL CONSTRAINT coordinator_startup_receipts_inbox_check CHECK (jsonb_typeof(inbox) = 'object'),
  PRIMARY KEY ("userId", "botId", holder, round),
  FOREIGN KEY ("userId", "botId") REFERENCES coordinator_sessions ("userId", "botId") ON DELETE CASCADE
);
