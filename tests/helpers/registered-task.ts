import type { Pool, PoolClient } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'

/** Seed through the production registration contract. Lazy imports preserve a
 * suite's split-database routing, which it selects before creating fixtures. */
export async function registeredTask<T>(application: Pick<Pool, 'connect'>, ownerId: string, workspaceId: string, id: string,
  insert: (client: PoolClient) => Promise<T>): Promise<T> {
  const { withTaskWorkspace } = await import('../../lib/task-workspace')
  const { registerTaskResourceAccess } = await import('../../lib/task-resource-registration')
  return withTaskWorkspace(ownerId, workspaceId, async workspace => {
    const client = await application.connect()
    try {
      await client.query('BEGIN')
      const result = await insert(client)
      await registerTaskResourceAccess(drizzle(client), { id, ownerId, workspaceId, workspaceKind: workspace.kind })
      await client.query('COMMIT')
      return result
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
  })
}
