-- target: DATABASE_URL

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE mikka_organization_join_domains (
  id uuid PRIMARY KEY,
  "organizationId" uuid NOT NULL REFERENCES mikka_organizations(id) ON DELETE CASCADE,
  domain varchar(253) NOT NULL CHECK (domain = lower(btrim(domain))),
  CONSTRAINT mikka_org_join_domain_unique UNIQUE ("organizationId", domain)
);
CREATE INDEX mikka_org_join_domain_idx ON mikka_organization_join_domains (domain);

COMMIT;
