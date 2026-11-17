-- target: MIKKA_DATABASE_URL
BEGIN;
-- Existing share creation times were never recorded. A later migration or retry
-- must not give them an invented date.
ALTER TABLE drive_file_links ADD COLUMN "createdAt" timestamptz;
ALTER TABLE drive_file_links ALTER COLUMN "createdAt" SET DEFAULT now();

-- Old and new application writers both update the same head entries. Record
-- only material changes, including mode changes and restores.
ALTER TABLE drive_volume_entries ADD COLUMN "changedAt" timestamptz;
ALTER TABLE drive_volume_entries ALTER COLUMN "changedAt" SET DEFAULT now();
CREATE FUNCTION mark_drive_entry_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."changedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER mark_drive_entry_changed BEFORE UPDATE OF mode,"sizeBytes",sha256 ON drive_volume_entries
  FOR EACH ROW WHEN ((OLD.mode,OLD."sizeBytes",OLD.sha256) IS DISTINCT FROM (NEW.mode,NEW."sizeBytes",NEW.sha256))
  EXECUTE FUNCTION mark_drive_entry_changed();
COMMIT;
