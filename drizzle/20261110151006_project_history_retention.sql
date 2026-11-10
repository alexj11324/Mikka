-- APP: account identity is historical provenance, not the lifetime of a shared
-- Project decision. Account/workspace deletion explicitly cleans unretained rows.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$
DECLARE owned_constraint record;
BEGIN
  FOR owned_constraint IN
    SELECT c.conrelid::regclass AS relation, c.conname
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    WHERE c.contype = 'f' AND cardinality(c.conkey) = 1 AND a.attname = 'ownerId'
      AND c.conrelid IN ('project_decisions'::regclass, 'project_decision_sources'::regclass)
      AND c.confrelid = '"user"'::regclass
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', owned_constraint.relation, owned_constraint.conname);
  END LOOP;
END;
$$;
COMMIT;
