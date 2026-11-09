import type { PoolClient } from 'pg'
import { afterDatabaseCommit } from '../db/commit-effects'
import { LIVE_ID, type LiveInvalidation } from './events'
import { liveGatewayConfig, type LiveScope } from './scope'

type Database = Pick<PoolClient, 'query'>

/** The owner ACL is preserved, on the artifact's actual tenant channel. A
 * deletion carries its previously authorized tenant, never a guessed home. */
export async function artifactTargets(database: Database, workspaceDatabase: Database, ownerId: string, artifactId: string, deletedWorkspaceId?: string): Promise<{ scope: LiveScope; events: LiveInvalidation[] }[]> {
  if (!LIVE_ID.test(artifactId)) return []
  const { rows: [row] } = await database.query<{ userId: string; workspaceId: string | null }>('SELECT "userId","workspaceId" FROM artifacts WHERE id=$1', [artifactId])
  if (row && row.userId !== ownerId) return []
  const workspaceId = row?.workspaceId ?? (!row ? deletedWorkspaceId : undefined)
  if (!workspaceId) return []
  const { rows: [scope] } = await workspaceDatabase.query<LiveScope>(`SELECT m."userId" AS "ownerId",w.id AS "workspaceId"
    FROM mikka_workspace_members m JOIN mikka_workspaces w ON w.id=m."workspaceId"
    WHERE m."userId"=$1 AND m."workspaceId"=$2 AND m.status='active' AND (w.kind='team' OR w."userId"=m."userId")`, [ownerId, workspaceId])
  return scope ? [{ scope, events: [{ kind: 'artifact', id: artifactId }] }] : []
}

/** A new version, a title, a share link or deletion. Sent after COMMIT; a rollback sends nothing. */
export async function artifactChanged(executor: object, ownerId: string, artifactId: string, deletedWorkspaceId?: string) {
  if (!liveGatewayConfig(process.env)) return
  await (await import('./project-map')).projectMapArtifactChanged(executor, artifactId)
  const { scheduleLive, sendLiveInvalidations } = await import('./notify')
  afterDatabaseCommit(executor, `artifact:${artifactId}`, () => scheduleLive(async () => {
    const { pool, withoutDatabaseClient } = await import('../db/request-scope')
    const { workspacePool } = await import('../workspace-db')
    await withoutDatabaseClient(async () => {
      for (const target of await artifactTargets(pool, workspacePool, ownerId, artifactId, deletedWorkspaceId)) await sendLiveInvalidations(target.scope, target.events)
    })
  }))
}
