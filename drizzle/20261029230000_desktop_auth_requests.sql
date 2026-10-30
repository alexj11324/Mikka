-- target: MIKKA_DATABASE_URL
-- Binds a desktop loopback handoff to the signed-in person before the browser
-- opens, so a crafted callback URL cannot receive another person's token.
create table if not exists desktop_auth_requests (
  "stateHash" text primary key,
  "userId" text not null references "user" (id) on delete cascade,
  callback text not null,
  "expiresAt" timestamptz not null,
  "usedAt" timestamptz,
  "createdAt" timestamptz not null default now()
);
create index if not exists desktop_auth_requests_user_idx on desktop_auth_requests ("userId", "expiresAt");
