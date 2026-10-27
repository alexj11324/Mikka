-- The iOS app (apps/mobile): where to push, and what the person wants pushed.
-- mobile_push_tokens: one Expo push token per installed app; removed on sign-out.
-- user_preferences: the app's push and 记忆 settings (docs/design/mobile.md,
-- "Settings"); 主动消息 is attention_settings.enabled. A person without a row
-- has the defaults.
-- Additive and safe to re-run.
begin;
set local lock_timeout = '5s';

create table if not exists mobile_push_tokens (
  id uuid primary key,
  "userId" text not null references "user"(id) on delete cascade,
  token text not null,
  platform text not null,
  "deviceName" text,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);
create unique index if not exists mobile_push_tokens_token_key on mobile_push_tokens (token);
create index if not exists mobile_push_tokens_user_idx on mobile_push_tokens ("userId");

create table if not exists user_preferences (
  "userId" text primary key references "user"(id) on delete cascade,
  "pushDecide" boolean not null default true,
  "pushReview" boolean not null default true,
  "pushFinished" boolean not null default false,
  "pushBriefing" boolean not null default true,
  "pushWhen" text not null default 'always',
  "memoryEnabled" boolean not null default true,
  "updatedAt" timestamptz not null default now()
);

commit;
