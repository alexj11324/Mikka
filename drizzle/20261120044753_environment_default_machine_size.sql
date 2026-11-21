-- target: DATABASE_URL
-- The Cloudflare machine size a run in this Environment gets when the run does not name one (MACHINE_SIZES in
-- lib/cloud-computer/machine-pricing.ts). NULL is Mikka's default. Validated by the writer, so a new size needs no migration.
ALTER TABLE workspace_environments ADD COLUMN IF NOT EXISTS "defaultMachineSize" text
  CHECK ("defaultMachineSize" IS NULL OR "defaultMachineSize" ~ '^[a-z0-9-]{1,40}$');
