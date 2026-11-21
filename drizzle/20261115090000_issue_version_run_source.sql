-- Legacy history remains unlinked; only verified run mutations record provenance.
SET LOCAL lock_timeout = '5s';
ALTER TABLE issue_versions ADD COLUMN IF NOT EXISTS source_run_id uuid;
