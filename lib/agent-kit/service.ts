import 'server-only'
import { cloudComputerRunsEnabled } from '@/lib/cloud-computer-flag'
import { and, eq, sql } from 'drizzle-orm'
import { db, pool } from '@/lib/db'
import { bots } from '@/lib/db/schema'
import { workspaceDb } from '@/lib/workspace-db'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { builtinAgentDefinition } from './builtin'
import { AgentKitError, AgentKitStore, type AgentScope } from './store'
import type { PoolClient } from 'pg'

export { agentKitEnabled } from './config'
export function agentKitDefaults() {
  return builtinAgentDefinition({ computerEnabled: cloudComputerRunsEnabled() })
}
export const agentKitStore = new AgentKitStore(pool)

/** Identity is derived from the host, never tool input or imported configuration. No bot: the person's Coordinator, an ordinary bot row. */
export async function agentScope(ownerId: string, chatBot: string | null, appClient?: Pick<PoolClient, 'query'>, workspaceClient?: Pick<PoolClient, 'query'>): Promise<AgentScope> {
  // Work with no bot stored (an older bot-less run) names no workspace: the personal workspace's Coordinator.
  const botId = chatBot ?? await (await import('@/lib/coordinator/coordinator-bot')).chatBotId(ownerId, null, null, { backfill: false })
  const bot = appClient
    ? (await appClient.query<{ workspaceId: string }>('select "workspaceId" from bots where id=$1 and "ownerId"=$2 for share', [botId, ownerId])).rows[0]
    : (await db.select({ workspaceId:bots.workspaceId }).from(bots).where(and(eq(bots.id,botId),eq(bots.ownerId,ownerId))).limit(1))[0]
  if (!bot) throw new AgentKitError('agentScopeNotFound',404)
  return activeScope(ownerId, botId, bot.workspaceId, workspaceClient)
}

/** The same fresh owner-scoped read supplies hosted startup identity and display metadata. */
export async function agentScopeWithBotMetadata(ownerId: string, botId: string) {
  const [bot] = await db.select({ workspaceId: bots.workspaceId, name: bots.name,
    coordinator: sql<boolean>`exists (select 1 from coordinator_bots cb where cb."botId" = ${bots.id})` })
    .from(bots).where(and(eq(bots.id, botId), eq(bots.ownerId, ownerId))).limit(1)
  if (!bot) throw new AgentKitError('agentScopeNotFound',404)
  const scope = await activeScope(ownerId, botId, bot.workspaceId)
  return { scope, bot: { name: bot.name, coordinator: bot.coordinator } }
}

async function activeScope(ownerId: string, botId: string, workspaceId: string, workspaceClient?: Pick<PoolClient, 'query'>): Promise<AgentScope> {
  const membership = workspaceClient
    ? (await workspaceClient.query('select status from mikka_workspace_members where "workspaceId"=$1 and "userId"=$2 and status=\'active\'', [workspaceId, ownerId])).rows[0]
    : (await workspaceDb.select({ status:workspaceMembers.status }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId,workspaceId),eq(workspaceMembers.userId,ownerId),eq(workspaceMembers.status,'active'))).limit(1))[0]
  if (!membership) throw new AgentKitError('agentScopeNotFound',404)
  return { ownerId,botId,workspaceId }
}
