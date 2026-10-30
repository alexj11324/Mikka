begin;
set local lock_timeout = '5s';
create table if not exists hosted_verifications (
  "workspaceId" uuid primary key,
  "customerId" text,
  fingerprint text,
  "verifiedAt" timestamptz not null default now()
);
-- No workspace FK: deleting a workspace must never release a card claim.
create table if not exists hosted_card_claims (fingerprint text primary key, "workspaceId" uuid not null, "claimedAt" timestamptz not null default now());
create table if not exists hosted_setup_intents (id text primary key, "workspaceId" uuid not null, "customerId" text not null);
create table if not exists hosted_allowances ("workspaceId" uuid primary key, remaining bigint not null check (remaining >= 0));
create table if not exists hosted_usage (
  id text primary key,
  "workspaceId" uuid not null,
  model text not null,
  state text not null check (state in ('pending','settled','failed','unknown')),
  "reservedUnpaid" bigint not null default 0,
  "unpaidMicroUsd" bigint not null default 0,
  "reservedFree" bigint not null default 0,
  "reservedPurchased" bigint not null default 0,
  "costMicroUsd" bigint,
  "freeMicroUsd" bigint not null default 0,
  "purchasedMicroUsd" bigint not null default 0,
  "inputTokens" bigint not null default 0,
  "outputTokens" bigint not null default 0,
  "generationId" text,
  "createdAt" timestamptz not null default now(),
  "settledAt" timestamptz
);
create index if not exists hosted_usage_window on hosted_usage ("createdAt") where "reservedFree">0 or "freeMicroUsd">0;
create index if not exists hosted_usage_workspace on hosted_usage ("workspaceId","createdAt");
create unique index if not exists hosted_usage_one_pending on hosted_usage ("workspaceId") where state in ('pending','unknown');
create table if not exists hosted_abuse_alerts (key text primary key, kind text not null, "createdAt" timestamptz not null default now(), "deliveredAt" timestamptz);
create table if not exists signup_email_claims (normalized text primary key, "userId" text not null unique references "user"(id) on delete cascade);
create table if not exists "rateLimit" (id text primary key, key text not null unique, count integer not null, "lastRequest" bigint not null);
-- Keep legacy aliases working, but prevent any new account from claiming them.
create or replace function mikka_normalized_signup_email(value text) returns text language sql immutable as $$
  select split_part(case when lower(split_part(value,'@',2)) in ('gmail.com','googlemail.com') then replace(split_part(lower(value),'@',1),'.','') else split_part(lower(value),'@',1) end,'+',1)
    || '@' || case when lower(split_part(value,'@',2))='googlemail.com' then 'gmail.com' else lower(split_part(value,'@',2)) end
$$;
insert into signup_email_claims (normalized,"userId") select distinct on (mikka_normalized_signup_email(email)) mikka_normalized_signup_email(email),id from "user" order by mikka_normalized_signup_email(email),id on conflict do nothing;
create or replace function mikka_claim_signup_email() returns trigger language plpgsql as $$
begin
  if TG_OP='UPDATE' and mikka_normalized_signup_email(OLD.email)=mikka_normalized_signup_email(NEW.email) then return NEW; end if;
  delete from signup_email_claims where "userId"=NEW.id;
  insert into signup_email_claims (normalized,"userId") values (mikka_normalized_signup_email(NEW.email),NEW.id);
  return NEW;
end $$;
drop trigger if exists mikka_signup_email_claim on "user";
create trigger mikka_signup_email_claim after insert or update of email on "user" for each row execute function mikka_claim_signup_email();

commit;
