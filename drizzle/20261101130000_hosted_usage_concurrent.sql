-- Hosted (Mikka 默认) calls run concurrently per workspace. Each in-flight call
-- holds an estimated maximum cost at admission; settlement still charges the
-- actual cost, and the hold ends with the row's pending/unknown state.
alter table hosted_usage add column if not exists "holdMicroUsd" bigint not null default 0;
drop index if exists hosted_usage_one_pending;
create index if not exists hosted_usage_in_flight on hosted_usage ("workspaceId") where state in ('pending','unknown');
