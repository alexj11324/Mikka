-- target: MIKKA_DATABASE_URL
-- Ready thread machines (#1507): per owner and official template, one paused
-- instance with Mikka's worker already installed, so a dispatch resumes it
-- instead of creating and bootstrapping a new one (~60 s). The instance runs
-- on the owner's own E2B key; it has no device identity until it is claimed.
CREATE TABLE IF NOT EXISTS thread_machine_pool (
  id uuid PRIMARY KEY,
  "ownerId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  template text NOT NULL,
  "workerSha" text NOT NULL,
  state text NOT NULL CHECK (state IN ('warming','ready')),
  "sandboxId" text UNIQUE,
  "claimedBy" uuid UNIQUE,
  "claimedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "readyAt" timestamptz
);
-- One unclaimed slot per owner and template.
CREATE UNIQUE INDEX IF NOT EXISTS thread_machine_pool_slot ON thread_machine_pool ("ownerId", template) WHERE "claimedBy" IS NULL;
