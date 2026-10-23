import { resolvePermissions } from '@mikka/protocol/agent-policy'
import { and, eq, gt, inArray } from 'drizzle-orm'
import { computerRequests, agentSettings } from '@/lib/db/workspace-schema'
import type { ComputerRequestStore } from './broker'

// All writers (including policy changes) lock the workspace row, so an active
// membership + deny decision is checked at the same serialized claim boundary.
type WorkspaceDb = typeof import('@/lib/workspace-db').workspaceDb
// Inject only trusted server dependencies; no request/model can select these.
export function createComputerRequestStore(workspaceDb: WorkspaceDb, requireWorkspace: typeof import('@/lib/workspace-access').requireWorkspace): ComputerRequestStore {
return {
  async pending(userId, sessionId) {
    return workspaceDb.select().from(computerRequests).where(and(eq(computerRequests.userId, userId), eq(computerRequests.sessionId, sessionId), eq(computerRequests.status, 'pending'), gt(computerRequests.expiresAt, new Date()))).limit(20)
  },
  async insert(request) {
    await workspaceDb.transaction(async tx => {
      await requireWorkspace(tx, request.workspaceId, request.userId)
      const [policy] = await tx.select().from(agentSettings).where(eq(agentSettings.workspaceId, request.workspaceId))
      if (resolvePermissions(policy?.permissions).computer_use === 'deny') throw new Error('Computer use denied by workspace')
      // Missing/unknown policy remains ask. Even allow never forges an exact
      // operation approval; the narrower broker still requires the owner tap.
      await tx.insert(computerRequests).values(request)
    })
  },
  async consume(id, userId, sessionId, target, now, status) {
    return workspaceDb.transaction(async tx => {
      const [queued] = await tx.select().from(computerRequests).where(and(eq(computerRequests.id, id), eq(computerRequests.userId, userId), eq(computerRequests.sessionId, sessionId), eq(computerRequests.target, target))).limit(1)
      if (!queued) return null
      await requireWorkspace(tx, queued.workspaceId, userId)
      const [policy] = await tx.select().from(agentSettings).where(eq(agentSettings.workspaceId, queued.workspaceId))
      if (status === 'executing' && resolvePermissions(policy?.permissions).computer_use === 'deny') return null
      const [claimed] = await tx.update(computerRequests).set({ status }).where(and(eq(computerRequests.id, id), eq(computerRequests.userId, userId), eq(computerRequests.sessionId, sessionId), eq(computerRequests.workspaceId, queued.workspaceId), eq(computerRequests.target, target), eq(computerRequests.status, status === 'executing' ? 'approved' : 'pending'), gt(computerRequests.expiresAt, now))).returning()
      return claimed ?? null
    })
  },
  async read(id, userId, sessionId, target) {
    const [row] = await workspaceDb.select().from(computerRequests).where(and(eq(computerRequests.id, id), eq(computerRequests.userId, userId), eq(computerRequests.sessionId, sessionId), eq(computerRequests.target, target))).limit(1)
    return row ?? null
  },
  async cancel(id, userId, sessionId) {
    await workspaceDb.update(computerRequests).set({ status: 'cancelled' }).where(and(eq(computerRequests.id, id), eq(computerRequests.userId, userId), eq(computerRequests.sessionId, sessionId), inArray(computerRequests.status, ['pending', 'approved'])))
  },
  async approve(id, userId, sessionId, target, now) {
    return workspaceDb.transaction(async tx => {
      const [row] = await tx.select().from(computerRequests).where(and(eq(computerRequests.id, id), eq(computerRequests.userId, userId), eq(computerRequests.sessionId, sessionId), eq(computerRequests.target, target))).limit(1)
      if (!row) return null
      await requireWorkspace(tx, row.workspaceId, userId)
      const [policy] = await tx.select().from(agentSettings).where(eq(agentSettings.workspaceId, row.workspaceId))
      if (resolvePermissions(policy?.permissions).computer_use === 'deny') return null
      const [approved] = await tx.update(computerRequests).set({ status: 'approved' }).where(and(eq(computerRequests.id, id), eq(computerRequests.status, 'pending'), gt(computerRequests.expiresAt, now))).returning()
      return approved ?? null
    })
  },
  async finish(id, status) { await workspaceDb.update(computerRequests).set({ status }).where(and(eq(computerRequests.id, id), eq(computerRequests.status, 'executing'))) },
}

}
