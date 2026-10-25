import type { Pool } from 'pg'
import { groupDirectory } from './group-conversations-directory'
import type { Directory } from './group-conversations-store'
import { reject } from './group-review-access'

/** Hold active workspace membership across the application read/revoke commit.
 * Application source lock remains first within its own transaction. Workspace
 * membership mutation may wait for a read; this is not a distributed commit. */
export async function withExchangeReadAuthority<T>(workspacePool: Pool, fn: (directory: Directory) => Promise<T>) {
  const workspace = await workspacePool.connect()
  try {
    await workspace.query('BEGIN')
    await workspace.query("SET LOCAL lock_timeout = '5s'")
    const directory = groupDirectory({
      async activeUsers(workspaceId, ids) {
        return (await workspace.query(`SELECT "userId" FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=ANY($2::text[]) AND status='active' ORDER BY "userId" FOR SHARE`, [workspaceId, ids])).rows.map(row => row.userId)
      },
      async ownedAgents(userId, ids, client) {
        if (!client) return reject(403, 'transaction_required')
        return (await client.query('SELECT id FROM agents WHERE "userId"=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE', [userId, ids])).rows.map(row => row.id)
      },
    })
    const result = await fn(directory)
    await workspace.query('COMMIT')
    return result
  } catch (error) { await workspace.query('ROLLBACK'); throw error }
  finally { workspace.release() }
}
