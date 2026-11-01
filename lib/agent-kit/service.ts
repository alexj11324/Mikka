import 'server-only'
import { cloudComputerTasksEnabled } from '@/lib/cloud-computer-flag'
import { and, eq } from 'drizzle-orm'
import { db, pool } from '@/lib/db'
import { bots } from '@/lib/db/schema'
import { workspaceDb } from '@/lib/workspace-db'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { builtinAgentDefinition } from './builtin'
import { AgentKitError, AgentKitStore, type AgentScope } from './store'
import type { PoolClient } from 'pg'

/** Opt-in deployment; migration must be applied first. No runtime/vendor change is implied. */
export function agentKitEnabled() { return process.env.MIKKA_AGENT_KIT === '1' }
export function agentKitDefaults() {
  return builtinAgentDefinition({ computerEnabled: cloudComputerTasksEnabled() && process.env.MIKKA_BYOS_ENABLED === '1' })
}
export const agentKitStore = new AgentKitStore(pool)

/** Identity is derived from the host, never tool input or imported configuration. */
export async function agentScope(ownerId: string, botId: string | null, appClient?: Pick<PoolClient, 'query'>, workspaceClient?: Pick<PoolClient, 'query'>): Promise<AgentScope> {
  if (!botId) return { ownerId,botId:null,workspaceId:null }
  const bot = appClient
    ? (await appClient.query<{ workspaceId: string }>('select "workspaceId" from bots where id=$1 and "ownerId"=$2 for share', [botId, ownerId])).rows[0]
    : (await db.select({ workspaceId:bots.workspaceId }).from(bots).where(and(eq(bots.id,botId),eq(bots.ownerId,ownerId))).limit(1))[0]
  if (!bot) throw new AgentKitError('agentScopeNotFound',404)
  const membership = workspaceClient
    ? (await workspaceClient.query('select status from mikka_workspace_members where "workspaceId"=$1 and "userId"=$2 and status=\'active\'', [bot.workspaceId, ownerId])).rows[0]
    : (await workspaceDb.select({ status:workspaceMembers.status }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId,bot.workspaceId),eq(workspaceMembers.userId,ownerId),eq(workspaceMembers.status,'active'))).limit(1))[0]
  if (!membership) throw new AgentKitError('agentScopeNotFound',404)
  return { ownerId,botId,workspaceId:bot.workspaceId }
}
