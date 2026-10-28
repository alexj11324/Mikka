CREATE TABLE IF NOT EXISTS task_request_bindings (
  "eventId" uuid PRIMARY KEY REFERENCES coordinator_events(id) ON DELETE CASCADE,
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "botId" uuid,
  "deviceId" uuid NOT NULL REFERENCES devices(id),
  "issueId" uuid NOT NULL UNIQUE REFERENCES issues(id) ON DELETE CASCADE,
  "toolCallId" text NOT NULL,
  "inputHash" text NOT NULL,
  "eventHash" text NOT NULL
);
