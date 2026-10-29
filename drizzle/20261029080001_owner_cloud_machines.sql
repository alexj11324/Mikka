-- Separate OS/browser identities for each account in the same workspace.
-- Preserve existing machines and desktops; do not share credential profiles.
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='cloud_machines'::regclass AND contype='p' AND array_length(conkey,1)=1) THEN
  ALTER TABLE bot_desktops DROP CONSTRAINT IF EXISTS "bot_desktops_workspaceId_fkey";
  ALTER TABLE cloud_machines DROP CONSTRAINT cloud_machines_pkey;
  ALTER TABLE cloud_machines ADD CONSTRAINT cloud_machines_pkey PRIMARY KEY ("workspaceId","ownerId");
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='bot_desktops'::regclass AND conname='bot_desktops_owner_machine_fk') THEN
  ALTER TABLE bot_desktops ADD CONSTRAINT bot_desktops_owner_machine_fk FOREIGN KEY ("workspaceId","ownerId") REFERENCES cloud_machines("workspaceId","ownerId") ON DELETE CASCADE;
 END IF;
 ALTER TABLE bot_desktops DROP CONSTRAINT IF EXISTS "bot_desktops_workspaceId_display_key";
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='bot_desktops'::regclass AND conname='bot_desktops_owner_display_unique') THEN
  ALTER TABLE bot_desktops ADD CONSTRAINT bot_desktops_owner_display_unique UNIQUE ("workspaceId","ownerId",display);
 END IF;
END $$;
ALTER TABLE cloud_machines ADD COLUMN IF NOT EXISTS "provisionLeaseId" uuid;
ALTER TABLE cloud_machines ADD COLUMN IF NOT EXISTS "provisionLeaseUntil" timestamptz;
