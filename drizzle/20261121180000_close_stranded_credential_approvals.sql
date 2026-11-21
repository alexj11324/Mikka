-- #496/#497 cleanup: the credential approval chain is gone, so a pending
-- credential_operation row can never be decided again. Rows still referenced
-- by a subagent's activeActionId get the resume tick's five-minute expiry and
-- are left alone here; the rest would sit 'pending' forever, invisible to the
-- list and undecidable, so close them now.
UPDATE pending_actions SET status='failed', error='browserActionExpired'
WHERE action='credential_operation' AND status='pending'
AND NOT EXISTS (SELECT 1 FROM bot_subagents s WHERE s."activeActionId"=pending_actions.id);
