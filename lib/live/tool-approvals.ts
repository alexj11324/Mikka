import { afterDatabaseCommit } from '../db/commit-effects'
import { liveGatewayConfig, type LiveScope } from './scope'
import type { LiveInvalidation } from './events'

/** The personal workspace a person's cards live in; same scope as pending actions. */
async function ownerScopes(ownerId: string): Promise<LiveScope[]> {
  const { workspacePool } = await import('../workspace-db')
  const { rows } = await workspacePool.query<LiveScope>(
    `SELECT w."userId" AS "ownerId",w.id AS "workspaceId" FROM mikka_workspaces w
      JOIN mikka_workspace_members m ON m."workspaceId"=w.id AND m."userId"=w."userId" AND m.status='active'
      WHERE w."userId"=$1 AND w.kind='personal'`, [ownerId],
  )
  return rows
}

/**
 * One Ask request was created or decided: the owner's approval surface should
 * reread. It reuses the existing `pending_actions` kind (a card waiting for
 * the person), so no Worker or client kind changes.
 */
export async function toolApprovalsChanged(executor: object, ownerId: string) {
  if (!liveGatewayConfig(process.env)) return
  const { scheduleLive, sendLiveInvalidations } = await import('./notify')
  afterDatabaseCommit(executor, `tool-approvals:${ownerId}`, () => scheduleLive(async () => {
    const { withoutDatabaseClient } = await import('../db/request-scope')
    await withoutDatabaseClient(async () => {
      const scopes = await ownerScopes(ownerId)
      await Promise.all(scopes.map(scope => {
        const events: LiveInvalidation[] = [{ kind: 'pending_actions', id: scope.workspaceId }]
        return sendLiveInvalidations(scope, events)
      }))
    })
  }))
}
