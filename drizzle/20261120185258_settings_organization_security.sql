-- target: MIKKA_DATABASE_URL

-- P7 uses Better Auth's native encrypted TOTP and recovery-code storage.
-- Rollback: retain these additive fields and records; disable requireTwoFactor
-- through the authenticated organization security writer before reverting code.
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "twoFactorEnabled" boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS "twoFactor" (
  id text PRIMARY KEY,
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  secret text NOT NULL,
  "backupCodes" text NOT NULL,
  verified boolean NOT NULL DEFAULT true,
  "failedVerificationCount" integer NOT NULL DEFAULT 0,
  "lockedUntil" timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS two_factor_user_unique ON "twoFactor" ("userId");
ALTER TABLE session ADD COLUMN IF NOT EXISTS "twoFactorVerifiedAt" timestamptz;
ALTER TABLE session ADD COLUMN IF NOT EXISTS "twoFactorMethod" text;
ALTER TABLE enterprise_org_policy ADD COLUMN IF NOT EXISTS "requireTwoFactor" boolean NOT NULL DEFAULT false;
ALTER TABLE enterprise_org_policy ADD COLUMN IF NOT EXISTS "twoFactorGraceDays" integer NOT NULL DEFAULT 7;
ALTER TABLE enterprise_org_policy ADD COLUMN IF NOT EXISTS "twoFactorRequiredAt" timestamptz;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='enterprise_org_two_factor_grace') THEN
    ALTER TABLE enterprise_org_policy ADD CONSTRAINT enterprise_org_two_factor_grace CHECK ("twoFactorGraceDays" BETWEEN 0 AND 30);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='session_two_factor_method') THEN
    ALTER TABLE session ADD CONSTRAINT session_two_factor_method CHECK ("twoFactorMethod" IS NULL OR "twoFactorMethod" IN ('totp','recovery'));
  END IF;
END $$;
-- Re-enrollment must not revive an old session's assurance.
CREATE OR REPLACE FUNCTION mikka_invalidate_two_factor_assurance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."twoFactorEnabled" IS DISTINCT FROM NEW."twoFactorEnabled" THEN
    UPDATE session SET "twoFactorVerifiedAt"=NULL,"twoFactorMethod"=NULL WHERE "userId"=NEW.id;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS mikka_user_two_factor_changed ON "user";
CREATE TRIGGER mikka_user_two_factor_changed AFTER UPDATE OF "twoFactorEnabled" ON "user"
FOR EACH ROW EXECUTE FUNCTION mikka_invalidate_two_factor_assurance();
