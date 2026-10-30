-- Settings backend (docs/settings-backend/prefs.md): the composer's send key,
-- the person's instructions for their Bots, the daily suggestions switch and
-- which connected apps feed it, and where the person's time zone came from.
-- Every new column has a default, so existing rows keep today's behaviour.
-- Mirrors userPreferences and userTimeZones in lib/db/schema.ts. Additive and safe to re-run.
begin;
set local lock_timeout = '5s';

alter table user_preferences add column if not exists "sendKey" text not null default 'enter';
alter table user_preferences add column if not exists "personalInstructions" text not null default '';
alter table user_preferences add column if not exists "dailySuggestions" boolean not null default true;
-- Composio app id -> false for each app the person turned off; a missing app is on.
alter table user_preferences add column if not exists "suggestionSources" jsonb not null default '{}'::jsonb;

-- 'auto': the browser or IP decides; 'manual': the person picked "timeZone" and reports no longer replace it.
alter table user_time_zones add column if not exists "source" text not null default 'auto';
-- The zone last reported by the browser or IP, kept while a manual zone is in force.
alter table user_time_zones add column if not exists "detectedTimeZone" text;
update user_time_zones set "detectedTimeZone" = "timeZone" where "detectedTimeZone" is null and "source" = 'auto';

commit;
