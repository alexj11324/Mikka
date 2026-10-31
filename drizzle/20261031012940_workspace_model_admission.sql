-- Reuse the existing workspace policy row. NULL means no organization model
-- restriction; a configured policy is rechecked at every model call.
ALTER TABLE workspace_computer_policies
  ADD COLUMN IF NOT EXISTS model_admission jsonb;
