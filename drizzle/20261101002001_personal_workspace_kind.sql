-- target: DATABASE_URL
-- Decision 2026-10-31-2130: every person has exactly one personal workspace,
-- marked by kind. Additive: existing rows default to 'team'; a user without a
-- personal workspace (invited sign-ups, or a default workspace that gained
-- members) gets one lazily in loadWorkspaceContext.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
ALTER TABLE mikka_workspaces ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'team';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'mikka_workspaces'::regclass AND conname = 'mikka_workspaces_kind_check') THEN
    ALTER TABLE mikka_workspaces ADD CONSTRAINT mikka_workspaces_kind_check CHECK (kind IN ('personal', 'team'));
  END IF;
END $$;
-- The default workspace a user was given at sign-up (id derived from
-- orvilo-default:<userId>, as in lib/workspace-access.ts) is personal when its
-- owner is still its only member, active, with no pending invitation.
UPDATE mikka_workspaces w SET kind = 'personal'
WHERE w.kind = 'team'
  AND w.id = (
    SELECT (substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-4' || substr(h, 14, 3) || '-8' || substr(h, 18, 3) || '-' || substr(h, 21, 12))::uuid
    FROM (SELECT encode(sha256(convert_to('orvilo-default:' || w."userId", 'UTF8')), 'hex') AS h) d
  )
  AND EXISTS (SELECT 1 FROM mikka_workspace_members m WHERE m."workspaceId" = w.id AND m."userId" = w."userId" AND m.status = 'active')
  AND NOT EXISTS (SELECT 1 FROM mikka_workspace_members m WHERE m."workspaceId" = w.id AND m."userId" <> w."userId")
  AND NOT EXISTS (SELECT 1 FROM mikka_workspace_invitations i WHERE i."workspaceId" = w.id AND i.status = 'pending')
  -- Re-runs: an owner who already has a personal workspace (made lazily) keeps it.
  AND NOT EXISTS (SELECT 1 FROM mikka_workspaces p WHERE p."userId" = w."userId" AND p.kind = 'personal');
-- One personal workspace per person.
CREATE UNIQUE INDEX IF NOT EXISTS mikka_workspaces_personal_owner_unique ON mikka_workspaces ("userId") WHERE kind = 'personal';
COMMIT;
