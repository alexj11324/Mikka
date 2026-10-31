ALTER TABLE hosted_verifications ADD COLUMN last4 text;
ALTER TABLE hosted_setup_intents ADD COLUMN "createdAt" timestamptz NOT NULL DEFAULT now();
CREATE INDEX hosted_setup_intents_workspace_created_idx ON hosted_setup_intents ("workspaceId", "createdAt" DESC);
