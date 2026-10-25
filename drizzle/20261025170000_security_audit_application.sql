-- target: MIKKA_DATABASE_URL
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
CREATE TABLE IF NOT EXISTS security_audit_store (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), id uuid NOT NULL DEFAULT gen_random_uuid());
INSERT INTO security_audit_store(singleton) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS security_audit_heads (
 tenant text PRIMARY KEY, seq bigint NOT NULL DEFAULT 0, hash text NOT NULL DEFAULT '',
 floor bigint NOT NULL DEFAULT 0, floor_hash text NOT NULL DEFAULT '',
 retention_days integer NOT NULL DEFAULT 90 CHECK(retention_days BETWEEN 1 AND 3650),
 legal_hold boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS security_audit_events (
 tenant text NOT NULL, seq bigint NOT NULL, id uuid NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 event jsonb NOT NULL, canonical text NOT NULL, prev_hash text NOT NULL, hash text NOT NULL,
 PRIMARY KEY(tenant,seq), UNIQUE(tenant,id)
);
CREATE INDEX IF NOT EXISTS security_audit_time ON security_audit_events(tenant,occurred_at,seq);
-- Hash-only deduplication tombstones survive retention. No tokens, email, prompts or IPs.
CREATE TABLE IF NOT EXISTS security_audit_keys (tenant text NOT NULL, id uuid NOT NULL, digest text NOT NULL, PRIMARY KEY(tenant,id));
CREATE TABLE IF NOT EXISTS security_audit_exports (
 id uuid PRIMARY KEY, tenant text NOT NULL, actor text NOT NULL, lower_seq bigint NOT NULL,
 upper_seq bigint NOT NULL, count bigint NOT NULL, start_hash text NOT NULL, end_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '1 hour'
);
CREATE TABLE IF NOT EXISTS security_audit_checkpoints (
 tenant text NOT NULL, through_seq bigint NOT NULL, hash text NOT NULL, count bigint NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant,through_seq)
);
CREATE OR REPLACE FUNCTION security_audit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' AND EXISTS (SELECT 1 FROM security_audit_checkpoints c WHERE c.tenant=OLD.tenant AND c.through_seq>=OLD.seq) THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'security_audit_immutable';
END $$;
DROP TRIGGER IF EXISTS security_audit_immutable ON security_audit_events;
CREATE TRIGGER security_audit_immutable BEFORE UPDATE OR DELETE ON security_audit_events FOR EACH ROW EXECUTE FUNCTION security_audit_guard();
CREATE OR REPLACE FUNCTION security_audit_append(t text, key uuid, data jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE h security_audit_heads; existing text; d text; body text; stamp timestamptz := clock_timestamp();
BEGIN
 IF t IS NULL OR length(t)>240 OR t !~ '^[a-zA-Z0-9_:.@-]+$' OR jsonb_typeof(data)<>'object' THEN RAISE EXCEPTION 'security_audit_invalid'; END IF;
 IF EXISTS(SELECT FROM jsonb_each(data) kv WHERE jsonb_typeof(kv.value)<>'string') OR EXISTS(SELECT FROM jsonb_each_text(data) kv WHERE kv.key NOT IN ('actorId','actorType','subjectId','resourceId','action','outcome','reason','requestId','runId','operationId') OR length(kv.value)>200 OR kv.value !~ '^[a-zA-Z0-9_:.@-]+$')
 OR NOT data ?& ARRAY['actorId','actorType','resourceId','action','outcome','reason']
 OR data->>'actorType' NOT IN ('human','worker','system','anonymous')
 OR data->>'outcome' NOT IN ('success','denied','failed','uncertain','pending') THEN RAISE EXCEPTION 'security_audit_invalid'; END IF;
 d:=encode(sha256(convert_to(data::text,'UTF8')),'hex');
 INSERT INTO security_audit_heads(tenant) VALUES(t) ON CONFLICT DO NOTHING;
 SELECT * INTO h FROM security_audit_heads WHERE tenant=t FOR UPDATE;
 SELECT digest INTO existing FROM security_audit_keys WHERE tenant=t AND id=key;
 IF FOUND THEN IF existing<>d THEN RAISE EXCEPTION 'security_audit_id_conflict'; END IF; RETURN; END IF;
 body:=jsonb_build_object('version',1,'tenant',t,'id',key,'seq',(h.seq+1)::text,'occurredAt',to_char(stamp AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'data',data)::text;
 INSERT INTO security_audit_events(tenant,seq,id,occurred_at,event,canonical,prev_hash,hash)
 VALUES(t,h.seq+1,key,stamp,data,body,h.hash,encode(sha256(convert_to(h.hash||E'\n'||body,'UTF8')),'hex'));
 INSERT INTO security_audit_keys VALUES(t,key,d);
 UPDATE security_audit_heads SET seq=h.seq+1,hash=encode(sha256(convert_to(h.hash||E'\n'||body,'UTF8')),'hex') WHERE tenant=t;
END $$;
-- Fail closed: triggers run in the business transaction and never swallow write errors.
COMMIT;
BEGIN;
-- Retain captured ownership when an FK cascade removes a parent before its child trigger.
CREATE TABLE IF NOT EXISTS security_audit_resource_scopes (
 source text NOT NULL, resource text NOT NULL, tenant text NOT NULL, owner_id text,
 PRIMARY KEY(source,resource)
);
CREATE OR REPLACE FUNCTION security_audit_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r jsonb; before_row jsonb; tenant_id text; actor text; actor_kind text; owner_id text; resource_ref text; action_name text; result_name text; reason_code text; run_id text; operation_id text; captured_tenant text; parent_id uuid; parent_run record; inherited_tenant text; parent_tenant text; child_mailbox record;
BEGIN
 r:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 before_row:=CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
 owner_id:=coalesce(r->>'owner_id',r->>'ownerId',r->>'userId'); actor:='system'; actor_kind:='system';
 tenant_id:=coalesce(r->>'workspace_id',r->>'workspaceId','personal:'||owner_id);
 resource_ref:=coalesce(r->>'id',r->>'operationId'); run_id:=coalesce(r->>'run_id',r->>'runId'); operation_id:=coalesce(r->>'operationId',r->>'eventId');
 result_name:='success'; reason_code:=lower(TG_OP); action_name:=TG_TABLE_NAME||'.'||lower(TG_OP);
 IF TG_TABLE_NAME='agent_runs' THEN
   IF TG_OP='UPDATE' AND ((NEW."retryOf" IS NOT NULL AND NEW."retryOf" IS DISTINCT FROM OLD."retryOf") OR (NEW."continuesRunId" IS NOT NULL AND NEW."continuesRunId" IS DISTINCT FROM OLD."continuesRunId")) THEN
     RAISE EXCEPTION 'security_audit_lineage_invalid';
   END IF;
   IF TG_OP='INSERT' THEN
     FOREACH parent_id IN ARRAY ARRAY[(r->>'retryOf')::uuid,(r->>'continuesRunId')::uuid] LOOP
       CONTINUE WHEN parent_id IS NULL;
       IF parent_id=(r->>'id')::uuid THEN RAISE EXCEPTION 'security_audit_lineage_invalid'; END IF;
       SELECT p."userId",p."issueId",p."mailboxId",s.tenant INTO parent_run FROM agent_runs p
         LEFT JOIN security_audit_resource_scopes s ON s.source='agent_runs' AND s.resource=p.id::text WHERE p.id=parent_id;
       IF NOT FOUND OR parent_run."userId" IS DISTINCT FROM owner_id OR parent_run."issueId" IS DISTINCT FROM (r->>'issueId')::uuid THEN
         RAISE EXCEPTION 'security_audit_lineage_invalid';
       END IF;
       IF parent_id=(r->>'continuesRunId')::uuid AND (parent_run."mailboxId" IS DISTINCT FROM (r->>'mailboxId')::uuid) THEN
         RAISE EXCEPTION 'security_audit_lineage_invalid';
       END IF;
       parent_tenant:=parent_run.tenant;
       IF parent_tenant IS NULL AND parent_run."mailboxId" IS NOT NULL THEN
         SELECT CASE WHEN "workspaceId"='00000000-0000-4000-8000-000000000001' THEN 'personal:'||owner_id ELSE "workspaceId" END INTO parent_tenant FROM session_mailboxes WHERE id=parent_run."mailboxId";
       END IF;
       IF parent_tenant IS NOT NULL AND inherited_tenant IS NOT NULL AND parent_tenant<>inherited_tenant THEN RAISE EXCEPTION 'security_audit_lineage_invalid'; END IF;
       inherited_tenant:=coalesce(parent_tenant,inherited_tenant);
     END LOOP;
     IF inherited_tenant IS NOT NULL AND (r->>'mailboxId') IS NOT NULL THEN
       SELECT "userId","workspaceId" INTO child_mailbox FROM session_mailboxes WHERE id=(r->>'mailboxId')::uuid;
       IF NOT FOUND OR child_mailbox."userId" IS DISTINCT FROM owner_id OR (child_mailbox."workspaceId"<>'00000000-0000-4000-8000-000000000001' AND child_mailbox."workspaceId"<>inherited_tenant) THEN
         RAISE EXCEPTION 'security_audit_lineage_invalid';
       END IF;
     END IF;
     IF inherited_tenant IS NOT NULL AND nullif(current_setting('mikka.audit_workspace',true),'') IS NOT NULL AND inherited_tenant<>current_setting('mikka.audit_workspace') THEN
       RAISE EXCEPTION 'security_audit_lineage_invalid';
     END IF;
   END IF;
   IF TG_OP='UPDATE' AND r->>'status'=before_row->>'status' AND r->>'stopRequestedAt' IS NOT DISTINCT FROM before_row->>'stopRequestedAt' THEN RETURN NEW; END IF;
   SELECT CASE WHEN "workspaceId"='00000000-0000-4000-8000-000000000001' THEN 'personal:'||owner_id ELSE "workspaceId" END INTO tenant_id FROM session_mailboxes WHERE id=(r->>'mailboxId')::uuid;
   SELECT s.tenant INTO captured_tenant FROM security_audit_resource_scopes s WHERE s.source='agent_runs' AND s.resource=r->>'id';
   tenant_id:=coalesce(captured_tenant,inherited_tenant,nullif(current_setting('mikka.audit_workspace',true),''),tenant_id,'personal:'||owner_id); run_id:=resource_ref;
   reason_code:=r->>'status';
 ELSIF TG_TABLE_NAME='factory_approvals' THEN
   actor:=owner_id; actor_kind:='human';
   IF TG_OP='UPDATE' AND r->>'revokedAt' IS NOT DISTINCT FROM before_row->>'revokedAt' THEN RETURN NEW; END IF;
   action_name:=CASE WHEN r->>'revokedAt' IS NOT NULL THEN 'approval.revoked' ELSE 'approval.granted' END;
 ELSIF TG_TABLE_NAME='factory_attempts' OR TG_TABLE_NAME='factory_publications' THEN
   SELECT "userId" INTO owner_id FROM factory_tasks WHERE id=(r->>'taskId')::uuid;
   actor:='system'; actor_kind:='system'; tenant_id:='personal:'||owner_id;
   reason_code:=r->>'status';
   IF TG_OP='UPDATE' AND r->>'status'=before_row->>'status' THEN RETURN NEW; END IF;
 ELSIF TG_TABLE_NAME='pending_actions' THEN
   reason_code:=r->>'status';
   IF TG_OP='UPDATE' AND reason_code=before_row->>'status' THEN RETURN NEW; END IF;
   IF TG_OP='UPDATE' AND reason_code IN ('running','declined') THEN actor:=owner_id; actor_kind:='human'; END IF;
   operation_id:=resource_ref;
 ELSIF TG_TABLE_NAME='credential_requests' OR TG_TABLE_NAME='byos_connections' OR TG_TABLE_NAME='operation_ledger' THEN
   reason_code:=coalesce(r->>'state',r->>'status');
   IF TG_OP='INSERT' AND TG_TABLE_NAME IN ('credential_requests','byos_connections') THEN actor:=owner_id; actor_kind:='human'; END IF;
   IF TG_OP='UPDATE' AND coalesce(r->>'state',r->>'status')=coalesce(before_row->>'state',before_row->>'status') THEN RETURN NEW; END IF;
 ELSIF TG_TABLE_NAME='session' THEN
   actor:=owner_id; actor_kind:='human';
   IF TG_OP='UPDATE' THEN RETURN NEW; END IF;
   action_name:=CASE WHEN TG_OP='DELETE' THEN 'auth.session_revoked' ELSE 'auth.login' END;
 END IF;
 IF nullif(current_setting('mikka.audit_actor',true),'') IS NOT NULL THEN
   actor:=current_setting('mikka.audit_actor'); actor_kind:=coalesce(nullif(current_setting('mikka.audit_actor_type',true),''),'human');
 END IF;
 IF TG_OP='DELETE' THEN action_name:=TG_TABLE_NAME||'.deleted'; reason_code:='deleted'; END IF;
 IF reason_code IN ('uncertain','outcome_unknown') THEN result_name:='uncertain';
 ELSIF reason_code IN ('declined','failed','blocked','revoked','cancelled','expired','disconnected') THEN result_name:='failed';
 ELSIF reason_code IN ('pending','reserved','waiting','waiting_input') THEN result_name:='pending'; END IF;
 IF TG_TABLE_NAME IN ('factory_approvals','factory_attempts','factory_publications') THEN
   tenant_id:=coalesce(nullif(current_setting('mikka.audit_workspace',true),''),tenant_id);
 END IF;
 SELECT s.tenant INTO captured_tenant FROM security_audit_resource_scopes s WHERE s.source=TG_TABLE_NAME AND s.resource=resource_ref;
 tenant_id:=coalesce(captured_tenant,tenant_id);
 IF TG_OP='DELETE' THEN
   SELECT s.tenant,s.owner_id INTO tenant_id,owner_id FROM security_audit_resource_scopes s WHERE s.source=TG_TABLE_NAME AND s.resource=resource_ref;
   owner_id:=coalesce(owner_id,r->>'owner_id',r->>'ownerId',r->>'userId');
   tenant_id:=coalesce(tenant_id,CASE WHEN owner_id IS NOT NULL THEN 'personal:'||owner_id WHEN actor<>'system' THEN 'personal:'||actor ELSE 'system:legacy' END);
 ELSE
   INSERT INTO security_audit_resource_scopes(source,resource,tenant,owner_id) VALUES(TG_TABLE_NAME,resource_ref,tenant_id,owner_id)
     ON CONFLICT(source,resource) DO NOTHING;
 END IF;
 PERFORM security_audit_append(tenant_id,gen_random_uuid(),jsonb_strip_nulls(jsonb_build_object(
 'actorId',coalesce(actor,'system'),'actorType',actor_kind,'subjectId',owner_id,'resourceId',resource_ref,
 'action',action_name,'outcome',result_name,'reason',coalesce(reason_code,'transition'),'runId',run_id,'operationId',operation_id,'requestId',nullif(current_setting('mikka.audit_request',true),''))));
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['agent_runs','factory_approvals','factory_attempts','factory_publications','credential_requests','byos_connections','operation_ledger','pending_actions','session'] LOOP
   EXECUTE format('DROP TRIGGER IF EXISTS security_audit_transition ON %I',t);
   EXECUTE format('CREATE TRIGGER security_audit_transition AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION security_audit_transition()',t);
 END LOOP;
END $$;
COMMIT;
