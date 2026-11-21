-- Saved logins are themselves the consent: the column was always true, so the
-- two-step credential approval no longer exists. Deleting the saved login
-- (revoked_at) remains the only way to withdraw a grant.
ALTER TABLE credentials DROP COLUMN IF EXISTS unattended_allowed;
