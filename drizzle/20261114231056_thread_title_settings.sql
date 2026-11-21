-- target: MIKKA_DATABASE_URL
-- How threads are named, as Capy's "Thread titles" settings: title
-- instructions and when a generated title is written again. One row per
-- workspace ("userId" = '') holds the workspace default; a row per member
-- adds their own instructions and, optionally, their own triggers.
-- "triggers" NULL on a member row means the workspace default.
CREATE TABLE thread_title_settings (
  "workspaceId" uuid NOT NULL,
  "userId" text NOT NULL DEFAULT '',
  instructions varchar(1000) NOT NULL DEFAULT '',
  triggers text,
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("workspaceId", "userId"),
  CONSTRAINT thread_title_settings_triggers
    CHECK (triggers IS NULL OR triggers IN ('first_run_ended', 'pull_opened', 'either'))
);
