-- A development-era artifact implementation used these names with an
-- incompatible schema. Preserve it under explicit legacy names before the
-- newer mainline artifact migration runs; foreign keys keep their targets.
-- Unknown or partially upgraded layouts fail closed instead of being moved.
DO $$
BEGIN
  IF to_regclass('artifacts') IS NOT NULL AND
     EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='artifacts' AND column_name='conversationId') AND
     NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='artifacts' AND column_name='userId') THEN
    IF to_regclass('artifact_versions') IS NULL OR
       NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='artifact_versions' AND column_name='baseVersionId') OR
       EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='artifact_versions' AND column_name='storageKey') OR
       to_regclass('mikka_legacy_artifacts_20261027') IS NOT NULL OR
       to_regclass('mikka_legacy_artifact_versions_20261027') IS NOT NULL THEN
      RAISE EXCEPTION 'Legacy artifact layout requires manual review';
    END IF;
    ALTER TABLE artifact_versions RENAME TO mikka_legacy_artifact_versions_20261027;
    ALTER TABLE artifacts RENAME TO mikka_legacy_artifacts_20261027;
  END IF;
END $$;
