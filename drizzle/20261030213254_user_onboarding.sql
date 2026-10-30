-- First-run onboarding (docs/design/onboarding.md): when the person finished
-- or skipped it. No row means they have not seen it yet. Everyone who already
-- has an account is marked done, so only new sign-ups see the guide. The
-- backfill only runs while the table is empty, so a re-run cannot mark
-- people who signed up later as done.
begin;
set local lock_timeout = '5s';

create table if not exists user_onboarding (
  "userId" text primary key references "user"(id) on delete cascade,
  "completedAt" timestamptz not null default now()
);

insert into user_onboarding ("userId", "completedAt")
select id, now() from "user"
where not exists (select 1 from user_onboarding);

commit;
