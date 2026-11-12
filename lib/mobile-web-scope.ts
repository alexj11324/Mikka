import { isCloudEdition } from './edition'
import { mobileMembersPage, mobileWebTarget } from './mobile-web-target'

export class MobileWebScopeError extends Error { constructor() { super('mobile_handoff_scope_unavailable') } }

/** A target's workspace belongs to the token's authenticated person. Bot
 * identity comes from owner-scoped metadata, never an asserted workspace. */
export async function mobileWebWorkspace(userId: string, target: string, sessionId: string): Promise<string | null> {
  const url = new URL(mobileWebTarget(target), 'https://mikka.invalid')
  let workspaceId = url.searchParams.get('workspace')
  const botId = url.searchParams.get('bot')
  if (botId) {
    let owned: string | undefined
    try {
      const { pool } = await import('./db')
      owned = (await pool.query<{ workspaceId: string }>('SELECT "workspaceId" FROM bots WHERE id=$1 AND "ownerId"=$2', [botId, userId])).rows[0]?.workspaceId
    } catch { throw new MobileWebScopeError() }
    if (!owned || (workspaceId && owned !== workspaceId)) throw new MobileWebScopeError()
    workspaceId = owned
  }
  if (workspaceId) {
    const selected = workspaceId
    try {
      const [{ workspaceDb }, { requireWorkspace }] = await Promise.all([import('./workspace-db'), import('./workspace-access')])
      const members = url.pathname === mobileMembersPage
      if (members && !isCloudEdition()) throw new MobileWebScopeError()
      await workspaceDb.transaction(async tx => {
        const row = await requireWorkspace(tx, selected, userId, members, members ? { kind: 'session', sessionId } : undefined)
        if (members && row.workspace.kind !== 'team') throw new MobileWebScopeError()
      })
    }
    catch { throw new MobileWebScopeError() }
  }
  return workspaceId
}
