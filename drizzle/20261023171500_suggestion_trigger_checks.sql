-- When each person's Composio trigger subscriptions were last checked, so
-- opening the suggestions list re-checks them at most once an hour. Mirrors
-- suggestionTriggerChecks in lib/db/schema.ts. Applied by scripts/migrate.mjs
-- on production builds.

create table if not exists suggestion_trigger_checks (
  "userId" text primary key,
  "checkedAt" timestamptz not null
);
