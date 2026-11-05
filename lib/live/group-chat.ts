import type { PoolClient } from 'pg'
import { afterDatabaseCommit } from '../db/commit-effects'
import { LIVE_ID, type LiveInvalidation } from './events'
import { liveGatewayConfig, type LiveScope } from './scope'

type Database = Pick<PoolClient, 'query'>
type Target = { scope: LiveScope; events: LiveInvalidation[] }

/** An open group chat re-reads its newest page and members on its own key (the
 * group ID), sent to the group's actual participants only, in the group's
 * workspace: the same audience as its list row (groupListTargets). A removed
 * participant may receive the key once, so their open chat learns it is gone. */
export async function groupChatTargets(database: Database, workspaceDatabase: Database, conversationId: string, removedUserId: string | null = null): Promise<Target[]> {
  if (!LIVE_ID.test(conversationId)) return []
  const { groupListTargets } = await import('./lists')
  return (await groupListTargets(database, workspaceDatabase, conversationId, removedUserId))
    .map(target => ({ scope: target.scope, events: [{ kind: 'group_chat', id: conversationId }] }))
}

/** A message stored, a member added or removed, or the group's reply starting,
 * stopping, finishing or failing. Sent after COMMIT; a rollback sends nothing. */
export async function groupChatChanged(executor: object, conversationId: string, removedUserId: string | null = null) {
  if (!liveGatewayConfig(process.env)) return
  const { scheduleLive, sendLiveInvalidations } = await import('./notify')
  afterDatabaseCommit(executor, `group_chat:${conversationId}:${removedUserId ?? ''}`, () => scheduleLive(async () => {
    const { pool, withoutDatabaseClient } = await import('../db/request-scope')
    const { workspacePool } = await import('../workspace-db')
    await withoutDatabaseClient(async () => {
      const targets = await groupChatTargets(pool, workspacePool, conversationId, removedUserId)
      await Promise.all(targets.map(target => sendLiveInvalidations(target.scope, target.events)))
    })
  }))
}
