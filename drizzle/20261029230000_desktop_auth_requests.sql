-- target: MIKKA_DATABASE_URL
-- A desktop sign-in handoff. The signed-out desktop registers a nonce, its
-- loopback callback and a PKCE-style challenge; the browser that finishes
-- OAuth binds the row to its person once; the desktop then trades a one-time
-- code plus the verifier it kept for a short-lived sign-in token.
create table if not exists desktop_auth_requests (
  "stateHash" text primary key,
  "userId" text references "user" (id) on delete cascade,
  callback text not null,
  "codeChallenge" text not null,
  "codeHash" text,
  token text,
  "expiresAt" timestamptz not null,
  "boundAt" timestamptz,
  "usedAt" timestamptz,
  "createdAt" timestamptz not null default now()
);
create index if not exists desktop_auth_requests_user_idx on desktop_auth_requests ("userId", "expiresAt");
