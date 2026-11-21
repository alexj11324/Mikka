ALTER TABLE conversations ADD COLUMN IF NOT EXISTS "creationPurpose" text NOT NULL DEFAULT 'group'
  CHECK ("creationPurpose" IN ('group','conversation'));
CREATE INDEX IF NOT EXISTS conversations_owner_directory_idx ON conversations("workspaceId","createdBy","createdAt" DESC,id)
  WHERE "creationPurpose"='conversation';
