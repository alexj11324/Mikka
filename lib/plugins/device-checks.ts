import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { mcpDeviceCheckCommandSchema, mcpDeviceCheckReceiptSchema, scrubMcpCheckTools, type McpDeviceCheckCommand } from '../../packages/protocol/src/mcp-check'
import { notifyDeviceWork } from '@/lib/device-gateway-notify'
import { ownerIntegrationSettingsChanged } from '@/lib/live/lists'
import { PluginError } from './contracts'
import type { PersonalPluginStore } from './store'

/** The queue contains references only. Commands and environment values are
 * decrypted just for the owner's authenticated, explicitly selected device. */
export class McpDeviceChecks {
  constructor(readonly personal: PersonalPluginStore) {}

  async request(userId: string, serverId: string, deviceId: string) {
    if (!z.uuid().safeParse(deviceId).success) throw new PluginError('invalidPluginInput', 400)
    const client = await this.personal.pool.connect()
    let result: { id: string; expiresAt: string }
    try {
      await client.query('BEGIN')
      const { rows: [server] } = await client.query<{ revision: number; transport: string; enabled: boolean }>('SELECT revision,transport,enabled FROM personal_mcp_servers WHERE id=$1 AND user_id=$2 FOR UPDATE', [serverId, userId])
      if (!server) throw new PluginError('mcpNotFound', 404)
      if (server.transport !== 'stdio' || !server.enabled) throw new PluginError('mcpCheckNotAvailable', 409)
      const { rowCount } = await client.query(`SELECT 1 FROM devices WHERE id=$1 AND "ownerId"=$2 AND kind='local' AND "removedAt" IS NULL FOR UPDATE`, [deviceId, userId])
      if (!rowCount) throw new PluginError('mcpCheckDeviceNotFound', 404)
      const { rows: [pending] } = await client.query<{ id: string; expires_at: Date }>(`SELECT id,expires_at FROM mcp_device_checks WHERE server_id=$1 AND device_id=$2 AND revision=$3 AND completed_at IS NULL AND expires_at>now() ORDER BY created_at DESC LIMIT 1`, [serverId, deviceId, server.revision])
      if (pending) result = { id: pending.id, expiresAt: pending.expires_at.toISOString() }
      else {
        await client.query(`UPDATE mcp_device_checks SET completed_at=now(),outcome='superseded' WHERE server_id=$1 AND completed_at IS NULL`, [serverId])
        const id = randomUUID(), expires = new Date(Date.now() + 5 * 60_000)
        await client.query('INSERT INTO mcp_device_checks(id,server_id,device_id,user_id,revision,expires_at) VALUES($1,$2,$3,$4,$5,$6)', [id, serverId, deviceId, userId, server.revision, expires])
        result = { id, expiresAt: expires.toISOString() }
      }
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
    notifyDeviceWork(deviceId)
    return result
  }

  async pending(userId: string, deviceId: string): Promise<McpDeviceCheckCommand[]> {
    const { rows } = await this.personal.pool.query<{ id: string; server_id: string; revision: number; expires_at: Date }>(`SELECT c.id,c.server_id,c.revision,c.expires_at FROM mcp_device_checks c
      JOIN personal_mcp_servers s ON s.id=c.server_id AND s.user_id=c.user_id AND s.revision=c.revision AND s.enabled AND s.transport='stdio'
      JOIN devices d ON d.id=c.device_id AND d."ownerId"=c.user_id AND d.kind='local' AND d."removedAt" IS NULL
      WHERE c.device_id=$1 AND c.user_id=$2 AND c.completed_at IS NULL AND c.expires_at>now() ORDER BY c.created_at LIMIT 1`, [deviceId, userId])
    const commands: McpDeviceCheckCommand[] = []
    for (const row of rows) {
      try {
        const connection = await this.personal.mcpConnection(userId, row.server_id, row.revision)
        if (connection.native?.transport === 'stdio') commands.push(mcpDeviceCheckCommandSchema.parse({ id: row.id, expiresAt: row.expires_at.toISOString(), server: connection.native }))
      } catch (error) { if (!(error instanceof PluginError)) throw error }
    }
    return commands
  }

  async complete(userId: string, deviceId: string, raw: unknown) {
    const parsed = mcpDeviceCheckReceiptSchema.safeParse(raw)
    if (!parsed.success) throw new PluginError('invalidMcpCheckReceipt', 400)
    const receipt = parsed.data
    const client = await this.personal.pool.connect()
    try {
      await client.query('BEGIN')
      const { rows: [check] } = await client.query<{ server_id: string }>(`SELECT c.server_id FROM mcp_device_checks c
        JOIN personal_mcp_servers s ON s.id=c.server_id AND s.user_id=c.user_id AND s.revision=c.revision AND s.enabled AND s.transport='stdio'
        JOIN devices d ON d.id=c.device_id AND d."ownerId"=c.user_id AND d.kind='local' AND d."removedAt" IS NULL
        WHERE c.id=$1 AND c.device_id=$2 AND c.user_id=$3 AND c.completed_at IS NULL AND c.expires_at>now() FOR UPDATE OF c,s,d`, [receipt.id, deviceId, userId])
      if (!check) throw new PluginError('mcpCheckReceiptExpired', 409)
      await client.query('UPDATE mcp_device_checks SET completed_at=now(),outcome=$2 WHERE id=$1', [receipt.id, receipt.status])
      await client.query('UPDATE personal_mcp_servers SET connection_status=$2,last_checked_at=now(),check_failure=$3 WHERE id=$1', [check.server_id, receipt.status, receipt.status === 'check_failed' ? receipt.failureReason : null])
      if (receipt.status === 'connected') {
        const configuration = await this.personal.ownedStdioConfiguration(userId, check.server_id, client)
        const tools = scrubMcpCheckTools(receipt.tools, configuration)
        await client.query('UPDATE mcp_server_tools SET available=false WHERE server_id=$1', [check.server_id])
        for (const tool of tools) await client.query(`INSERT INTO mcp_server_tools(server_id,tool_name,description) VALUES($1,$2,$3)
          ON CONFLICT(server_id,tool_name) DO UPDATE SET description=$3,available=true,updated_at=now()`, [check.server_id, tool.name, tool.description])
      }
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
    await ownerIntegrationSettingsChanged(this.personal.pool, userId)
  }
}
