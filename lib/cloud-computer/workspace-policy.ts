import 'server-only'
import type { Pool, PoolClient } from 'pg'
import { ComputerError } from '@/lib/computer/store'

/** Share the computer policy lock with ComputerStore.setPolicy so a denial
 * cannot overtake an in-flight gateway action. This is a workspace ceiling,
 * not a substitute for any action-specific MCP/auto-review decision. */
export async function requireWorkspaceComputerPolicy(client: PoolClient, workspaceId: string) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`computer-policy:${workspaceId}`])
  const row = (await client.query('SELECT permission,version FROM workspace_computer_policies WHERE "workspaceId"=$1', [workspaceId])).rows[0]
  if (row?.permission === 'deny') throw new ComputerError(403, 'Computer use denied')
  if (row && row.permission !== 'ask') throw new ComputerError(503, 'Computer policy unavailable')
  return Number(row?.version ?? 0)
}

export async function withWorkspaceComputerPermission<T>(pool: Pool, workspaceId: string, action: (client: PoolClient, version: number) => Promise<T>) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const version = await requireWorkspaceComputerPolicy(client, workspaceId)
    const result = await action(client, version)
    await client.query('COMMIT')
    return result
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}
