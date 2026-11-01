-- Removes schema that production received on 2026-10-25 from unmerged branches
-- (codex/credential-scheduler-prep-20261025, codex/byos-transfer-executor).
-- main never created, reads or writes any of it; every table here held 0 rows
-- on 2026-11-01 except credential_requests (3 terminal rows, no secret columns).
-- Idempotent and a no-op on a database built from main. No CASCADE: an
-- unexpected dependency fails the deploy instead of dropping main objects.
-- The personal mailbox objects stay; 20261101020100 adopts them on main.
SET LOCAL lock_timeout = '5s';

-- Credential broker: these triggers run an UPDATE on credential_requests on
-- every UPDATE/DELETE of agent_runs, "session" and devices. Triggers first.
DROP TRIGGER IF EXISTS credential_run_lifecycle ON agent_runs;
DROP TRIGGER IF EXISTS credential_auth_lifecycle ON "session";
DROP TRIGGER IF EXISTS credential_device_lifecycle ON devices;
DROP FUNCTION IF EXISTS credential_revoke_run();
DROP FUNCTION IF EXISTS credential_revoke_auth_session();
DROP FUNCTION IF EXISTS credential_revoke_device();
DROP TABLE IF EXISTS credential_requests;

-- Account action intents (main keeps intentKey/operationBinding from its own history).
DROP INDEX IF EXISTS pending_actions_source_slot_key;
ALTER TABLE pending_actions DROP COLUMN IF EXISTS "sourceEventId";
ALTER TABLE pending_actions DROP COLUMN IF EXISTS "actionSlotId";
ALTER TABLE coordinator_events DROP COLUMN IF EXISTS "accountActionBatch";
ALTER TABLE agent_runs DROP COLUMN IF EXISTS "accountActionRefs";

-- Run continuation columns from the branch's mailbox migration (main passes
-- these names in the claim payload, not as columns).
ALTER TABLE agent_runs DROP COLUMN IF EXISTS "continuesRunId";
ALTER TABLE agent_runs DROP COLUMN IF EXISTS "resumeSessionId";
ALTER TABLE agent_runs DROP COLUMN IF EXISTS "followUp";

-- Group artifact review and group mailbox turns. The two mikka_legacy_* tables
-- are the branch's artifacts layout, renamed aside by 20261027164500.
DROP TABLE IF EXISTS group_work_reconciliations;
DROP TABLE IF EXISTS group_mailbox_corrections;
DROP TABLE IF EXISTS group_mailbox_turns;
DROP TABLE IF EXISTS artifact_acceptances;
DROP TABLE IF EXISTS artifact_change_requests;
DROP TABLE IF EXISTS artifact_comments;
DROP TABLE IF EXISTS artifact_threads;
DROP TABLE IF EXISTS mikka_legacy_artifacts_20261027, mikka_legacy_artifact_versions_20261027;
DROP FUNCTION IF EXISTS reject_artifact_version_mutation();
DROP TABLE IF EXISTS conversation_work;
DROP TABLE IF EXISTS conversation_message_keys;
DROP TABLE IF EXISTS conversation_agent_grants;

-- BYOS environment transfers (codex/byos-transfer-executor, never merged).
DROP TABLE IF EXISTS byos_environment_transfers;
