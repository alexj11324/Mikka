-- A grant is limited to one immutable Bot/run binding and disappears with it.
ALTER TABLE computer_run_bindings ADD COLUMN IF NOT EXISTS "approvedForRun" boolean NOT NULL DEFAULT false;
