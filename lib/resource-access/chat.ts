import 'server-only'
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import { db } from '@/lib/db'
import { bots } from '@/lib/db/schema'
import type { IssueReader } from '@/lib/issue-visibility'
import { taskReaderScope } from '@/lib/task-workspace'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { enterprisePrincipal } from '@/lib/enterprise/principal'
import type { ResourceAction } from './contract'
import { botChatResourceId, requireResourceAccess, readResourceCapabilities } from './store'

/** The Bot owns its structural transcript; the requester independently needs
 * fresh tenant/session authority and this exact Chat's content permission. */
export async function authorizedBotChat(reader: IssueReader, botId: string, action: ResourceAction = 'canReadContent', expectedWorkspaceId?: string) {
  if (!z.uuid().safeParse(botId).success) throw new ActionFailureError('botNotFound')
  const [identity] = await db.select({ id: bots.id, ownerId: bots.ownerId, workspaceId: bots.workspaceId }).from(bots)
    .where(and(eq(bots.id, botId), expectedWorkspaceId ? eq(bots.workspaceId, expectedWorkspaceId) : undefined)).limit(1)
  if (!identity?.ownerId) throw new ActionFailureError('botNotFound')
  const ownerId = identity.ownerId
  const reference = { kind: 'chat' as const, id: botChatResourceId(ownerId, identity.id), workspaceId: identity.workspaceId }
  await requireResourceAccess(reader, reference, action)
  const [bot] = await db.select({ name: bots.name, coordinator: sql<boolean>`exists(select 1 from coordinator_bots cb where cb."botId"=${bots.id})` })
    .from(bots).where(and(eq(bots.id, identity.id), eq(bots.ownerId, ownerId), eq(bots.workspaceId, identity.workspaceId))).limit(1)
  if (!bot) throw new ActionFailureError('botNotFound')
  const scopedReader: IssueReader = { id: taskReaderScope(reader).userId, [tokenWorkspace]: identity.workspaceId,
    ...(typeof reader !== 'string' && reader[enterprisePrincipal] ? { [enterprisePrincipal]: reader[enterprisePrincipal] } : {}) }
  return { ...identity, ownerId, ...bot, reference, viewerId: taskReaderScope(reader).userId, reader: scopedReader }
}

export async function botChatReadAccess(reader: IssueReader, ownerId: string, botId: string) {
  const workspaceId = taskReaderScope(reader).workspaceId
  if (!workspaceId) throw new ActionFailureError('botNotFound')
  const reference = { kind: 'chat' as const, id: botChatResourceId(ownerId, botId), workspaceId }
  const capabilities = await readResourceCapabilities(reader, reference)
  if (!capabilities.canReadContent) throw new ActionFailureError('botNotFound')
  return { reference, ownerId, viewerId: taskReaderScope(reader).userId, capabilities }
}
