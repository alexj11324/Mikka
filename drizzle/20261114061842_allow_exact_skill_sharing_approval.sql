-- target: DATABASE_URL
-- Skill sharing uses the same reviewed Organization approval as MCP servers.
ALTER TABLE mikka_organization_resource_approvals
  DROP CONSTRAINT mikka_organization_resource_approvals_kind_check,
  ADD CONSTRAINT mikka_organization_resource_approvals_kind_check
    CHECK (kind IN ('subscription', 'api_key', 'mcp', 'skill'));
