-- target: MIKKA_DATABASE_URL
-- Native MCP configuration is encrypted with the existing per-connection envelope.
ALTER TABLE personal_mcp_servers DROP CONSTRAINT IF EXISTS personal_mcp_servers_transport_check;
ALTER TABLE personal_mcp_servers ADD CONSTRAINT personal_mcp_servers_transport_check CHECK (transport IN ('http','sse','stdio'));
