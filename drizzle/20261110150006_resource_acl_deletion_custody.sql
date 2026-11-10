-- target: MIKKA_DATABASE_URL
-- Authority may be reduced during account deletion, but never recreated or
-- widened. Append-only ACL audit records are evidence, not owned content.
CREATE FUNCTION mikka_resource_acl_deletion_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id text; tenant uuid;
BEGIN
  IF TG_TABLE_NAME='resource_access_policies' THEN
    IF TG_OP='UPDATE' AND (NEW.kind,NEW.id,NEW."workspaceId",NEW."ownerId",NEW.visibility,NEW."parentKind",NEW."parentId",NEW.provenance)
      IS NOT DISTINCT FROM (OLD.kind,OLD.id,OLD."workspaceId",OLD."ownerId",OLD.visibility,OLD."parentKind",OLD."parentId",OLD.provenance) THEN
      -- A grant deletion bumps its policy revision under the same lock. It
      -- changes no authority fields and must remain possible after freezing.
      RETURN NEW;
    END IF;
    owner_id:=NEW."ownerId"; tenant:=NEW."workspaceId";
  ELSE
    SELECT "ownerId","workspaceId" INTO owner_id,tenant FROM resource_access_policies
      WHERE kind=NEW."resourceKind" AND id=NEW."resourceId" FOR UPDATE;
    IF NEW."subjectKind"='account' THEN PERFORM mikka_account_assert_writable(NEW."subjectId"); END IF;
  END IF;
  PERFORM mikka_account_assert_writable(owner_id);
  IF EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='account_deletion_workspace_guards') THEN
    IF EXISTS(SELECT 1 FROM account_deletion_workspace_guards WHERE "workspaceId"=tenant) THEN
      RAISE EXCEPTION 'account_deletion_pending' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER resource_acl_deletion_guard BEFORE INSERT OR UPDATE ON resource_access_policies FOR EACH ROW EXECUTE FUNCTION mikka_resource_acl_deletion_guard();
CREATE TRIGGER resource_acl_grant_deletion_guard BEFORE INSERT OR UPDATE ON resource_access_grants FOR EACH ROW EXECUTE FUNCTION mikka_resource_acl_deletion_guard();
