-- Each person's IANA time zone, so the daily briefing is written at 08:00
-- their time by the briefings cron (app/api/cron/briefings). Mirrors
-- userTimeZones in lib/db/schema.ts. Applied by scripts/migrate.mjs on
-- production builds.

create table if not exists user_time_zones (
  "userId" text primary key,
  "timeZone" text not null,
  "updatedAt" timestamptz not null default now()
);

create index if not exists user_time_zones_zone_idx on user_time_zones ("timeZone");
