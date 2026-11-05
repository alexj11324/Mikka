import type { PoolClient } from 'pg'
import { afterDatabaseCommit } from '../db/commit-effects'
import { LIVE_ID, type LiveInvalidation } from './events'
import { ownerLiveScope } from './owner-scope'
import { liveGatewayConfig, type LiveScope } from './scope'

type Database = Pick<PoolClient, 'query'>

/** An artifact is its owner's alone: its key goes to the owner's real home only.
 * A row that still exists must still be theirs; a deleted one carries only the
 * ID its owner already had, so the open reader learns it is gone. */
export async function artifactTargets(database: Database, workspaceDatabase: Database, ownerId: string, artifactId: string): Promise<{ scope: LiveScope; events: LiveInvalidation[] }[]> {
  if (!LIVE_ID.test(artifactId)) return []
  const { rows: [row] } = await database.query<{ userId: string }>('SELECT "userId" FROM artifacts WHERE id=$1', [artifactId])
  if (row && row.userId !== ownerId) return []
  const scope = await ownerLiveScope(workspaceDatabase, ownerId)
  return scope ? [{ scope, events: [{ kind: 'artifact', id: artifactId }] }] : []
}

/** A new version, a title, a share link or deletion. Sent after COMMIT; a rollback sends nothing. */
export async function artifactChanged(executor: object, ownerId: string, artifactId: string) {
  if (!liveGatewayConfig(process.env)) return
  const { scheduleLive, sendLiveInvalidations } = await import('./notify')
  afterDatabaseCommit(executor, `artifact:${artifactId}`, () => scheduleLive(async () => {
    const { pool, withoutDatabaseClient } = await import('../db/request-scope')
    const { workspacePool } = await import('../workspace-db')
    await withoutDatabaseClient(async () => {
      for (const target of await artifactTargets(pool, workspacePool, ownerId, artifactId)) await sendLiveInvalidations(target.scope, target.events)
    })
  }))
}
