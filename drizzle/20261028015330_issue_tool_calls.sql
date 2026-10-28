-- Durable issue mutation receipts. Replaying this migration leaves existing data intact.
CREATE TABLE IF NOT EXISTS issue_tool_calls (
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "toolCallId" text NOT NULL,
  operation text NOT NULL,
  "inputHash" text NOT NULL,
  "issueId" uuid NOT NULL,
  result jsonb NOT NULL,
  effects jsonb NOT NULL DEFAULT '[]'::jsonb,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("userId", "toolCallId")
);
