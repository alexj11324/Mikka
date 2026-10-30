-- Reuse the existing management queue for owner-requested daemon removal.
ALTER TABLE device_management_commands DROP CONSTRAINT IF EXISTS device_management_commands_kind_check;
ALTER TABLE device_management_commands ADD CONSTRAINT device_management_commands_kind_check CHECK (kind IN ('redetect', 'restart', 'update', 'uninstall'));
