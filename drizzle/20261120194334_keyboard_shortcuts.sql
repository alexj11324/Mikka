-- target: MIKKA_DATABASE_URL
-- Additive and replayable. Roll back application code while retaining the
-- shortcut entities and typed setting mirrors; do not drop user preferences.
-- Action identities are declared by the application registry, not a SQL enum:
-- registering another action requires neither a new migration nor an action.
CREATE TABLE IF NOT EXISTS keyboard_shortcuts (
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "actionId" text NOT NULL CHECK (length("actionId") BETWEEN 1 AND 100),
  binding text CHECK (binding IS NULL OR length(binding) <= 80),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("userId", "actionId")
);
