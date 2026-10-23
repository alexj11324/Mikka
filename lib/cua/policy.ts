import { resolvePermissions } from '@mikka/protocol/agent-policy'
import 'server-only'
import { eq, sql } from 'drizzle-orm'
import { workspaceDb } from '@/lib/workspace-db'
import { agentSettings, computerRequests } from '@/lib/db/workspace-schema'
import { requireWorkspace } from '@/lib/workspace-access'
import { and } from 'drizzle-orm'
import type { DesktopConfig } from './operation'

export async function workspaceComputerAccess(userId: string, config: DesktopConfig) {
  return workspaceDb.transaction(async tx => {
    await requireWorkspace(tx, config.workspaceId, userId)
    const [policy] = await tx.select().from(agentSettings).where(eq(agentSettings.workspaceId, config.workspaceId))
    return resolvePermissions(policy?.permissions).computer_use === 'deny' ? 'deny' : resolvePermissions(policy?.permissions).computer_use === 'allow' ? 'allow' : 'ask'
  })
}
export async function setWorkspaceComputerAccess(userId: string, workspaceId: string, decision: 'allow' | 'ask' | 'deny') {
  await workspaceDb.transaction(async tx => {
    await requireWorkspace(tx, workspaceId, userId, true)
    await tx.insert(agentSettings).values({ workspaceId, permissions: { computer_use: decision }, updatedBy: userId }).onConflictDoUpdate({ target: agentSettings.workspaceId, set: { permissions: sql`jsonb_set(${agentSettings.permissions}, '{computer_use}', ${JSON.stringify(decision)}::jsonb, true)`, updatedBy: userId, updatedAt: new Date() } })
    if (decision === 'deny') await tx.update(computerRequests).set({ status: 'denied' }).where(and(eq(computerRequests.workspaceId, workspaceId), eq(computerRequests.status, 'pending')))
  })
}
