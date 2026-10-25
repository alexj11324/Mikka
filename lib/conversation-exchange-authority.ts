import type { Pool, PoolClient } from 'pg'
import { groupDirectory } from './group-conversations-directory'
import type { Directory } from './group-conversations-store'
import { reject } from './group-review-access'

/** Hold active workspace membership across the application read/revoke commit.
 * Application source lock remains first within its own transaction. Workspace
 * membership mutation may wait for a read; this is not a distributed commit. */
export async function withExchangeReadAuthority<T>(workspacePool: Pool, fn: (directory: Directory) => Promise<T>) {
  let workspace: PoolClient | undefined
  let opening: Promise<PoolClient> | undefined
  // Borrow lazily only after the application operation has its app/source
  // locks. Eager borrowing reverses ordinary writer order and exhausts both
  // production max5 pools under one writer plus five concurrent readers.
  const workspaceConnection = () => opening ??= (async () => {
    workspace = await workspacePool.connect()
    await workspace.query('BEGIN')
    await workspace.query("SET LOCAL lock_timeout = '5s'")
    return workspace
  })()
  try {
    const directory = groupDirectory({
      async activeUsers(workspaceId, ids) {
        return (await (await workspaceConnection()).query(`SELECT "userId" FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=ANY($2::text[]) AND status='active' ORDER BY "userId" FOR SHARE`, [workspaceId, ids])).rows.map(row => row.userId)
      },
      async ownedAgents(userId, ids, client) {
        if (!client) return reject(403, 'transaction_required')
        return (await client.query('SELECT id FROM agents WHERE "userId"=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE', [userId, ids])).rows.map(row => row.id)
      },
    })
    const result = await fn(directory)
    if (workspace) await workspace.query('COMMIT')
    return result
  } catch (error) { if (workspace) await workspace.query('ROLLBACK'); throw error }
  finally { workspace?.release() }
}
