-- target: DATABASE_URL
-- Reuse the authoritative Organization policy; do not copy Workspace membership.
ALTER TABLE mikka_organization_resource_policies ADD COLUMN "privateByDefault" boolean NOT NULL DEFAULT false;
