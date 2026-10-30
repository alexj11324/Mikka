-- #438 E: sha256 of the ORIGINAL (unmasked) tool input. The stored input and the returned digest
-- are computed on the masked input, so two different inputs that mask alike would replay as one;
-- a repeated requestId must also match this. Server-side only: never selected into a response.
-- Rollback: alter table agent_tool_approvals drop column "inputDigest";
--           delete from schema_migrations where name = '20261030040100_agent_tool_approval_input_digest.sql';
ALTER TABLE agent_tool_approvals ADD COLUMN IF NOT EXISTS "inputDigest" text;
