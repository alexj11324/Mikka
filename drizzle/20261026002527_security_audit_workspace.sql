-- target: DATABASE_URL
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
CREATE OR REPLACE FUNCTION security_audit_membership() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r jsonb; actor text; resource text;
BEGIN
 r:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 IF TG_OP='UPDATE' AND NEW.role=OLD.role AND NEW.status=OLD.status THEN RETURN NEW; END IF;
 actor:=coalesce(nullif(current_setting('mikka.audit_actor',true),''),'system');
 resource:=r->>'userId';
 PERFORM security_audit_append(r->>'workspaceId',gen_random_uuid(),jsonb_build_object(
 'actorId',actor,'actorType',CASE WHEN actor='system' THEN 'system' ELSE 'human' END,
 'subjectId',resource,'resourceId',resource,'action','membership.'||lower(TG_OP),
 'outcome','success','reason',CASE WHEN TG_OP='DELETE' THEN 'removed' ELSE (r->>'role')||'.'||(r->>'status') END));
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS security_audit_membership ON mikka_workspace_members;
CREATE TRIGGER security_audit_membership AFTER INSERT OR UPDATE OR DELETE ON mikka_workspace_members FOR EACH ROW EXECUTE FUNCTION security_audit_membership();
COMMIT;

BEGIN;
CREATE OR REPLACE FUNCTION security_audit_invitation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r jsonb; actor text;
BEGIN
 r:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 IF TG_OP='UPDATE' AND NEW.status=OLD.status AND NEW.role=OLD.role THEN RETURN NEW; END IF;
 actor:=coalesce(nullif(current_setting('mikka.audit_actor',true),''),'system');
 PERFORM security_audit_append(r->>'workspaceId',gen_random_uuid(),jsonb_build_object(
 'actorId',actor,'actorType',CASE WHEN actor='system' THEN 'system' ELSE 'human' END,
 'resourceId',r->>'id','action','invitation.'||lower(TG_OP),'outcome','success','reason',r->>'status'));
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS security_audit_invitation ON mikka_workspace_invitations;
CREATE TRIGGER security_audit_invitation AFTER INSERT OR UPDATE OR DELETE ON mikka_workspace_invitations FOR EACH ROW EXECUTE FUNCTION security_audit_invitation();
COMMIT;
