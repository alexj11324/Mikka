-- target: MIKKA_DATABASE_URL
-- Bot custody changes must not cascade through the original Owner's immutable
-- Agent versions, execution snapshots and events. Only the live FK is detached.
ALTER TABLE agent_kit_heads ADD COLUMN detached_bot_id uuid;
ALTER TABLE agent_kit_heads ADD COLUMN detached_workspace_id uuid;
DO $$ DECLARE c record; BEGIN
  FOR c IN SELECT conname FROM pg_constraint
    WHERE conrelid='agent_kit_heads'::regclass AND contype='c'
      AND lower(pg_get_constraintdef(oid)) LIKE '%bot_key%coalesce%'
  LOOP EXECUTE format('ALTER TABLE agent_kit_heads DROP CONSTRAINT %I',c.conname); END LOOP;
END $$;
ALTER TABLE agent_kit_heads ADD CONSTRAINT agent_kit_head_custody_key
  CHECK (bot_key=coalesce(bot_id::text,detached_bot_id::text,'coordinator'));
ALTER TABLE agent_kit_heads ADD CONSTRAINT agent_kit_head_detached_custody
  CHECK ((detached_bot_id IS NULL AND detached_workspace_id IS NULL)
    OR (detached_bot_id IS NOT NULL AND detached_workspace_id IS NOT NULL AND bot_id IS NULL AND workspace_id IS NULL));
