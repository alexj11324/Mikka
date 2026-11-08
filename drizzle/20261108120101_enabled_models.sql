-- Preserve every previously available model, including manually selected old releases.
ALTER TABLE byos_connections ADD COLUMN IF NOT EXISTS "modelSettings" jsonb;
ALTER TABLE model_api_keys ADD COLUMN IF NOT EXISTS "modelSettings" jsonb;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "hostedModelEnabled" boolean NOT NULL DEFAULT true;
-- Existing deletion fences must keep rejecting writes to retained accounts.
-- Split app databases may not contain the workspace deletion-guard table.
DO $$
DECLARE fenced_workspaces text[] := ARRAY[]::text[];
BEGIN
  IF to_regclass('account_deletion_workspace_guards') IS NOT NULL THEN
    SELECT COALESCE(array_agg("workspaceId"::text), ARRAY[]::text[])
      INTO fenced_workspaces FROM account_deletion_workspace_guards;
  END IF;
  UPDATE byos_connections c SET "modelSettings"=jsonb_build_object('autoEnable',true,'models',COALESCE((
    SELECT jsonb_object_agg(id,jsonb_build_object('enabled',true,'fresh',false,'manual',true))
    FROM (SELECT DISTINCT b."modelId" AS id FROM byos_bindings b WHERE b."connectionId"=c.id
      UNION SELECT jsonb_array_elements_text(c."modelCatalog"->'models')) models), '{}'::jsonb))
    WHERE NOT (c."workspaceId"::text = ANY(fenced_workspaces));
END $$;
UPDATE model_api_keys k SET "modelSettings"=jsonb_build_object('autoEnable',false,'models',COALESCE((
  SELECT jsonb_object_agg(id,jsonb_build_object('enabled',true,'fresh',false,'manual',true))
  FROM jsonb_array_elements_text(k.models) AS items(id)), '{}'::jsonb));

-- Run in the same row lock as catalogue writes. A concurrent toggle cannot be
-- overwritten by an in-flight provider refresh. First-time keys start enabled;
-- newly reported models on an existing key are disabled and marked new.
CREATE OR REPLACE FUNCTION model_api_key_catalogue_settings() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE id text;
BEGIN
  NEW."modelSettings" := COALESCE(NEW."modelSettings", '{"autoEnable":false,"models":{}}'::jsonb);
  FOR id IN SELECT jsonb_array_elements_text(NEW.models) LOOP
    IF NOT (NEW."modelSettings"->'models' ? id) THEN
      NEW."modelSettings" := jsonb_set(NEW."modelSettings", ARRAY['models',id],
        jsonb_build_object('enabled',TG_OP='INSERT','fresh',TG_OP<>'INSERT','manual',false));
    END IF;
  END LOOP;
  -- Failed refreshes preserve the last successful catalogue timestamp.
  IF NEW."modelsError" IS NULL THEN
    NEW."modelSettings" := jsonb_set(NEW."modelSettings", '{refreshedAt}', to_jsonb(statement_timestamp()));
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS model_api_key_catalogue_settings ON model_api_keys;
CREATE TRIGGER model_api_key_catalogue_settings BEFORE INSERT OR UPDATE OF models ON model_api_keys
  FOR EACH ROW EXECUTE FUNCTION model_api_key_catalogue_settings();
