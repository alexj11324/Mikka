import { resolvePermissions } from '@mikka/protocol/agent-policy'
import 'server-only'
import { and, eq, gt } from 'drizzle-orm'
import { workspaceDb } from '@/lib/workspace-db'
import { computerRequests, agentSettings } from '@/lib/db/workspace-schema'
import { requireWorkspace } from '@/lib/workspace-access'
import type { ComputerRequestStore } from './broker'

// All writers (including policy changes) lock the workspace row, so an active
// membership + deny decision is checked at the same serialized claim boundary.
export const computerRequestStore: ComputerRequestStore = {
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
      const [claimed] = await tx.update(computerRequests).set({ status }).where(and(eq(computerRequests.id, id), eq(computerRequests.userId, userId), eq(computerRequests.sessionId, sessionId), eq(computerRequests.workspaceId, queued.workspaceId), eq(computerRequests.target, target), eq(computerRequests.status, 'pending'), gt(computerRequests.expiresAt, now))).returning()
      return claimed ?? null
    })
  },
  async finish(id, status) { await workspaceDb.update(computerRequests).set({ status }).where(and(eq(computerRequests.id, id), eq(computerRequests.status, 'executing'))) },
}
