-- target: DATABASE_URL

ALTER TABLE mikka_organizations ADD COLUMN IF NOT EXISTS icon text;
