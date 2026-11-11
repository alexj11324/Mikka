-- target: MIKKA_DATABASE_URL
-- M4 PAT scopes + in-place rotation. Existing tokens
-- become legacy-only (`legacy:full`) and keep working on the pre-M4 API
-- surface; new tokens get the public /api/v1 scopes only. A mixed row is
-- rejected so a token's audience is never ambiguous. Only sha256(token) is
-- stored; the plaintext is shown once at creation/rotation and never again.
-- Rollback: ALTER TABLE personal_access_tokens DROP CONSTRAINT personal_access_tokens_scopes_check;
--           ALTER TABLE personal_access_tokens DROP COLUMN "rotatedAt";
--           ALTER TABLE personal_access_tokens DROP COLUMN scopes;

alter table personal_access_tokens add column if not exists scopes text[];
-- Every row that existed before this migration is a pre-M4 token: it keeps
-- working on the legacy surface and can never acquire a public scope.
update personal_access_tokens set scopes = ARRAY['legacy:full']::text[] where scopes is null;
alter table personal_access_tokens alter column scopes set default ARRAY['tasks:read','tasks:write','runs:read','runs:write']::text[];
alter table personal_access_tokens alter column scopes set not null;
alter table personal_access_tokens drop constraint if exists personal_access_tokens_scopes_check;
alter table personal_access_tokens add constraint personal_access_tokens_scopes_check check (
  cardinality(scopes) between 1 and 5
  and array_position(scopes, null) is null
  and scopes <@ ARRAY['tasks:read','tasks:write','runs:read','runs:write','legacy:full']::text[]
  and not (scopes @> ARRAY['legacy:full']::text[] and scopes && ARRAY['tasks:read','tasks:write','runs:read','runs:write']::text[])
);
alter table personal_access_tokens add column if not exists "rotatedAt" timestamptz;
