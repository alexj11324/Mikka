-- target: MIKKA_DATABASE_URL
-- A private browser generation cannot be shared by two live intake requests/services.
CREATE UNIQUE INDEX credential_requests_browser_session ON credential_requests
  (owner_id, workspace_id, run_id, execution_session)
  WHERE mode='browser_login' AND state IN ('pending','submitting','ready','using','active_session');
