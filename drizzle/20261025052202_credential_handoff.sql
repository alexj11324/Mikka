-- target: MIKKA_DATABASE_URL
-- A bounded fill failure is terminal and requires owner review via a fresh request.
ALTER TABLE credential_requests DROP CONSTRAINT credential_requests_state_check;
ALTER TABLE credential_requests ADD CONSTRAINT credential_requests_state_check
  CHECK (state IN ('pending','submitting','ready','using','active_session','consumed','cancelled','expired','failed','disconnected','handoff_required'));
