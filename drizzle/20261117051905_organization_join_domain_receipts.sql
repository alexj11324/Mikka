-- target: DATABASE_URL
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE mikka_organization_join_domains
  ADD COLUMN "createdByUserId" text,
  ADD COLUMN "createdAt" timestamptz;

-- Both deployed and new writers append this event in the grant transaction.
-- Capture it on the rule before audit retention can remove the event.
CREATE FUNCTION record_organization_join_domain_creation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE mikka_organization_join_domains
     SET "createdByUserId" = NEW."actorId", "createdAt" = NEW."createdAt"
   WHERE "organizationId" = NEW."organizationId" AND id::text = NEW."targetId"
     AND "createdAt" IS NULL;
  RETURN NEW;
END;
$$;
CREATE TRIGGER organization_join_domain_created
  AFTER INSERT ON mikka_organization_audit_events
  FOR EACH ROW WHEN (NEW.action = 'organization.join_domain_added' AND NEW.result = 'success')
  EXECUTE FUNCTION record_organization_join_domain_creation();

-- Earlier deployments stored this information on the audit event alone.
-- Leave legacy grants with no surviving event unknown.
WITH grants AS (
  SELECT DISTINCT ON ("organizationId", "targetId")
         "organizationId", "targetId", "actorId", "createdAt"
    FROM mikka_organization_audit_events
   WHERE action = 'organization.join_domain_added' AND result = 'success'
   ORDER BY "organizationId", "targetId", "createdAt", id
)
UPDATE mikka_organization_join_domains d
   SET "createdByUserId" = g."actorId", "createdAt" = g."createdAt"
  FROM grants g
 WHERE d."organizationId" = g."organizationId" AND d.id::text = g."targetId";

COMMIT;
