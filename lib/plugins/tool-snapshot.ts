import type { PoolClient } from 'pg'
import type { McpConnectionStatus } from './connection-contracts'

export async function saveToolSnapshot(client: PoolClient, serverId: string, status: McpConnectionStatus, failure: string | null, tools: readonly { name: string; description?: string }[]) {
  await client.query('UPDATE personal_mcp_servers SET connection_status=$2,last_checked_at=now(),check_failure=$3 WHERE id=$1', [serverId, status, failure])
  if (status !== 'connected') return
  await client.query('UPDATE mcp_server_tools SET available=false WHERE server_id=$1', [serverId])
  for (const tool of tools) await client.query(`INSERT INTO mcp_server_tools(server_id,tool_name,description) VALUES($1,$2,$3)
    ON CONFLICT(server_id,tool_name) DO UPDATE SET description=$3,available=true,updated_at=now()`, [serverId, tool.name, (tool.description ?? '').slice(0, 4000)])
}
