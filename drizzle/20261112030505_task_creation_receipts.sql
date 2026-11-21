-- target: MIKKA_DATABASE_URL

CREATE TABLE task_creation_receipts (
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "requestId" uuid NOT NULL,
  "workspaceId" uuid NOT NULL,
  fingerprint text NOT NULL,
  "taskId" uuid NOT NULL,
  identifier text NOT NULL,
  PRIMARY KEY ("userId", "requestId"),
  UNIQUE ("taskId")
);
