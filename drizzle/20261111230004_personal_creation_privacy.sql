-- target: MIKKA_DATABASE_URL
-- A creation preference only. No existing ACL, balance or transcript is changed.
ALTER TABLE user_preferences ADD COLUMN "privateByDefault" boolean NOT NULL DEFAULT false;
