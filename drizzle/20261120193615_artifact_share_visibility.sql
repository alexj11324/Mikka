-- target: MIKKA_DATABASE_URL

-- Existing bearer links remain link-scoped. Only new links consume settings.
ALTER TABLE artifact_shares ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'link';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'artifact_shares'::regclass AND conname = 'artifact_shares_visibility_check') THEN
    ALTER TABLE artifact_shares ADD CONSTRAINT artifact_shares_visibility_check CHECK (visibility IN ('private', 'workspace', 'link'));
  END IF;
END $$;
