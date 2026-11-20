-- target: MIKKA_DATABASE_URL

-- Bot settings aligned with Capy's Captain (decision 2026-11-19, S6). A Bot binds
-- one Environment instead of a repository; the Environment lives in the workspace
-- database, so there is no foreign key: writers check it, and
-- scripts/bot-environment-backfill.mjs moves each old "repository" into an
-- Environment's repository list. "repository" stays readable until every caller
-- reads the Environment (lib/bot-environment.ts); nothing writes it any more.
ALTER TABLE bots
  ADD COLUMN IF NOT EXISTS "environmentId" uuid,
  -- Slack `@Mikka bot=<alias>`; unique per workspace, case-insensitive.
  ADD COLUMN IF NOT EXISTS alias text,
  -- Where the tasks this Bot dispatches run by default (lib/task-destination.ts shape).
  ADD COLUMN IF NOT EXISTS "crewTarget" jsonb,
  -- The Agent and Agent profile those tasks use by default.
  ADD COLUMN IF NOT EXISTS "defaultAgent" text,
  ADD COLUMN IF NOT EXISTS "defaultProfileId" uuid,
  -- Where the Bot itself runs: {"kind":"cloud"} or {"kind":"device","deviceId":…,"checkout":"worktree"|"linked"}.
  ADD COLUMN IF NOT EXISTS "runsOn" jsonb;

DO $$ BEGIN
  ALTER TABLE bots ADD CONSTRAINT bots_alias_format CHECK (alias IS NULL OR alias ~ '^[a-z0-9][a-z0-9_-]{0,31}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE bots ADD CONSTRAINT bots_default_agent_known CHECK ("defaultAgent" IS NULL OR "defaultAgent" IN ('claude_code','codex'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE bots ADD CONSTRAINT bots_crew_target_shape CHECK ("crewTarget" IS NULL OR "crewTarget"->>'kind' IN ('cloud','device'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE bots ADD CONSTRAINT bots_runs_on_shape CHECK ("runsOn" IS NULL OR "runsOn"->>'kind' IN ('cloud','device'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS bots_workspace_alias_key ON bots ("workspaceId", alias) WHERE alias IS NOT NULL;

-- People who follow a Bot they do not own: it shows in their sidebar and they get its notifications.
-- Who may follow is decided by the Bot's resource_access_policies row (kind 'bot').
CREATE TABLE IF NOT EXISTS bot_subscribers (
  "botId" uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("botId", "userId")
);
CREATE INDEX IF NOT EXISTS bot_subscribers_user_idx ON bot_subscribers ("userId");

-- Reasoning effort for the Bot's chat model (lib/model-routing.ts MODEL_ROUTING_EFFORTS); null is the model's default.
ALTER TABLE bot_model_choices ADD COLUMN IF NOT EXISTS effort text;
DO $$ BEGIN
  ALTER TABLE bot_model_choices ADD CONSTRAINT bot_model_choices_effort_known CHECK (effort IS NULL OR effort IN ('low','medium','high','xhigh','max'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A Slack thread started with `@Mikka bot=<alias>` keeps going to that Bot (lib/slack/thread-bots.ts):
-- one row per person's Slack link, channel and thread. A deleted Bot drops its routes.
CREATE TABLE IF NOT EXISTS slack_thread_bots (
  "linkId" uuid NOT NULL,
  "channelId" text NOT NULL,
  "threadTs" text NOT NULL,
  "ownerId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "botId" uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("linkId", "channelId", "threadTs")
);
CREATE INDEX IF NOT EXISTS slack_thread_bots_bot_idx ON slack_thread_bots ("botId");
