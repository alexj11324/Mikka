import 'server-only'
import { and, eq } from 'drizzle-orm'
import { db, pool } from '@/lib/db'
import { bots } from '@/lib/db/schema'
import { workspaceDb } from '@/lib/workspace-db'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { builtinAgentDefinition } from './builtin'
import { AgentKitError, AgentKitStore, type AgentScope } from './store'

/** Opt-in deployment; migration must be applied first. No runtime/vendor change is implied. */
export function agentKitEnabled() { return process.env.MIKKA_AGENT_KIT === '1' }
export function agentKitDefaults() {
  return builtinAgentDefinition({ computerEnabled: process.env.MIKKA_CLOUD_COMPUTER_TASKS === '1' && process.env.MIKKA_BYOS_ENABLED === '1' })
}
export const agentKitStore = new AgentKitStore(pool)

/** Identity is derived from the host, never tool input or imported configuration. */
export async function agentScope(ownerId: string, botId: string | null): Promise<AgentScope> {
  if (!botId) return { ownerId,botId:null,workspaceId:null }
  const [bot] = await db.select({ workspaceId:bots.workspaceId }).from(bots).where(and(eq(bots.id,botId),eq(bots.ownerId,ownerId))).limit(1)
  if (!bot) throw new AgentKitError('agentScopeNotFound',404)
  const [membership] = await workspaceDb.select({ status:workspaceMembers.status }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId,bot.workspaceId),eq(workspaceMembers.userId,ownerId),eq(workspaceMembers.status,'active'))).limit(1)
  if (!membership) throw new AgentKitError('agentScopeNotFound',404)
  return { ownerId,botId,workspaceId:bot.workspaceId }
}
