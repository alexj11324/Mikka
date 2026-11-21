-- target: MIKKA_DATABASE_URL
ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS "organizationInvitationEmails" boolean NOT NULL DEFAULT true;
