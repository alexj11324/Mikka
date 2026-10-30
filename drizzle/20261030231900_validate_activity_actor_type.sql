-- migrate: no-transaction
-- Validate separately from metadata changes so table writes remain available
ALTER TABLE issue_versions VALIDATE CONSTRAINT issue_versions_actor_type_check;
