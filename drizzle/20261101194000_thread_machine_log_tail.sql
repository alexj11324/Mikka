-- target: MIKKA_DATABASE_URL
-- The last lines a cloud thread worker printed, read back from its sandbox
-- when the machine parks, fails to provision or ends. Kept with the machine
-- row so a failure can be seen after the sandbox is gone. Masked and bounded
-- by the application (8000 characters).
ALTER TABLE thread_machines ADD COLUMN IF NOT EXISTS "logTail" text;
