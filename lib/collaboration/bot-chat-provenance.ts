import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import type { db } from '@/lib/db'
import type { CoordinatorEventInput } from '@/lib/coordinator-events'
import type { ResourceReference } from '@/lib/resource-access/contract'

export type BotChatProofQuery = Pick<PoolClient, 'query'> | Pick<typeof db, 'execute'>
const dialect = new PgDialect()
async function rows(query: BotChatProofQuery, statement: SQL): Promise<Record<string, unknown>[]> {
  if ('execute' in query) return (await query.execute(statement)).rows
  const compiled = dialect.sqlToQuery(statement)
  return (await query.query(compiled.sql, compiled.params)).rows
}
export async function botChatIsOwnerExclusive(query: BotChatProofQuery, ownerId: string, botId: string) {
  return (await rows(query, sql`SELECT mikka_bot_chat_owner_exclusive(${ownerId},${botId}::uuid) AS allowed`))[0]?.allowed === true
}

/** A reader expansion can happen after a model call. Only a resource shared
 * through every ancestor is a safe input for an arbitrary future Chat reader. */
export async function sharedBotResourceVisible(query: BotChatProofQuery,
  input: { ownerId: string; botId: string; resource: ResourceReference }) {
  if (!['task', 'thread'].includes(input.resource.kind)) return false
  return (await rows(query, sql`SELECT EXISTS(SELECT 1 FROM bots b WHERE b.id=${input.botId}::uuid
    AND b."ownerId"=${input.ownerId} AND b."workspaceId"=${input.resource.workspaceId}::uuid
    AND mikka_shared_bot_resource_visible(${input.resource.kind},${input.resource.id}::uuid,${input.resource.workspaceId}::uuid)) AS allowed`))[0]?.allowed === true
}

/** Called by the existing event writer. A private source remains in its own
 * business record and event row; it never wakes or projects into a shared Chat. */
export async function botChatEventInputVisible(query: BotChatProofQuery, event: CoordinatorEventInput) {
  if (!event.botId) return true
  return (await rows(query, sql`SELECT mikka_bot_chat_event_source_visible(${event.userId},${event.botId}::uuid,
    ${event.kind},${event.issueId}::uuid,${event.runId}::uuid) AS allowed`))[0]?.allowed === true
}

export async function botChatEventVisible(query: BotChatProofQuery, input: { ownerId: string; botId: string; eventId: string }) {
  if (!z.uuid().safeParse(input.eventId).success) return false
  return (await rows(query, sql`SELECT mikka_bot_chat_event_visible(${input.ownerId},${input.botId}::uuid,${input.eventId}::uuid) AS allowed`))[0]?.allowed === true
}

function eventId(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null
  const value = message as Record<string, unknown>
  if (value.role !== 'user') return null
  const source = value.mikkaUserEvent as { id?: unknown } | undefined
  if (z.uuid().safeParse(source?.id).success) return source!.id as string
  const notification = value.mikkaEvent as { packet?: unknown } | undefined
  if (typeof notification?.packet !== 'string') return null
  try {
    const packet = JSON.parse(notification.packet)
    return z.uuid().safeParse(packet?.source?.messageId).success ? packet.source.messageId : null
  } catch { return null }
}

/** Human/event provenance comes from the stored event. Model prose requires
 * a relational receipt written by the host, never a self-reported JSON field. */
export async function botChatMessageVisible(query: BotChatProofQuery,
  input: { ownerId: string; botId: string; messageId?: string; message: unknown }) {
  if (await botChatIsOwnerExclusive(query, input.ownerId, input.botId)) return true
  const source = eventId(input.message)
  if (source && await botChatEventVisible(query, { ...input, eventId: source })) return true
  if (!input.messageId || !z.uuid().safeParse(input.messageId).success) return false
  return (await rows(query, sql`SELECT mikka_bot_chat_message_visible(${input.ownerId},${input.botId}::uuid,${input.messageId}::uuid) AS allowed`))[0]?.allowed === true
}

/** Stream readers use the immutable host execution, not metadata supplied by
 * a model chunk. Past replies retain their provenance after the turn expires. */
export async function botChatExecutionVisible(query: BotChatProofQuery,
  input: { ownerId: string; botId: string; executionKey: string }) {
  if (await botChatIsOwnerExclusive(query, input.ownerId, input.botId)) return true
  return (await rows(query, sql`SELECT mikka_bot_chat_execution_visible(${input.ownerId},${input.botId}::uuid,${input.executionKey}) AS allowed`))[0]?.allowed === true
}

/** A reply that quotes an earlier answer inherits every source dependency.
 * Otherwise changing a Task to Private would hide the original answer while
 * leaving its later summaries visible. Human text remains an explicit share. */
export async function recordBotChatMessageInput(query: BotChatProofQuery,
  input: { ownerId: string; botId: string; messageId: string; message: unknown; destinationEventId: string }) {
  if (!await botChatMessageVisible(query, input)) return false
  const source = eventId(input.message)
  const dependencies = await rows(query, sql`SELECT DISTINCT d.kind,d.id,d."workspaceId" FROM (
    SELECT r."resourceKind" AS kind,r."resourceId" AS id,r."workspaceId" FROM bot_chat_message_authorities m
      JOIN bot_chat_resource_reads r ON r."eventId"=m."eventId" WHERE m."messageId"=${input.messageId}::uuid
    UNION ALL SELECT 'task',e."issueId",b."workspaceId" FROM coordinator_events e JOIN bots b ON b.id=e."botId"
      WHERE e.id=${source}::uuid AND e."userId"=${input.ownerId} AND e."botId"=${input.botId}::uuid
        AND e.kind<>'user_message' AND e."issueId" IS NOT NULL
    UNION ALL SELECT 'thread',e."runId",b."workspaceId" FROM coordinator_events e JOIN bots b ON b.id=e."botId"
      WHERE e.id=${source}::uuid AND e."userId"=${input.ownerId} AND e."botId"=${input.botId}::uuid
        AND e.kind<>'user_message' AND e."runId" IS NOT NULL
    ) d`)
  for (const dependency of dependencies) {
    if (!await sharedBotResourceVisible(query, { ownerId: input.ownerId, botId: input.botId,
      resource: { kind: dependency.kind as 'task' | 'thread', id: String(dependency.id), workspaceId: String(dependency.workspaceId) } })) return false
    await rows(query, sql`INSERT INTO bot_chat_resource_reads("eventId","resourceKind","resourceId","workspaceId")
      VALUES(${input.destinationEventId}::uuid,${String(dependency.kind)},${String(dependency.id)}::uuid,${String(dependency.workspaceId)}::uuid)
      ON CONFLICT DO NOTHING`)
  }
  return true
}

/** Existing append/failure paths supply their own immutable execution key.
 * This is also used for completed tool messages when Stop ends a turn. */
export async function bindBotChatMessages(query: BotChatProofQuery,
  input: { ownerId: string; botId: string; executionKey?: string; messageIds: string[] }) {
  if (!input.messageIds.length || await botChatIsOwnerExclusive(query, input.ownerId, input.botId)) return
  if (!input.executionKey) throw Error('shared_bot_message_authority_required')
  const [proof] = await rows(query, sql`SELECT x.id,a."eventId" FROM agent_kit_executions x
    JOIN bot_chat_submission_authorities a ON a."eventId"::text=x.snapshot#>>'{runtime,modelSelection,collaborationEventId}'
    WHERE x.owner_id=${input.ownerId} AND x.bot_key=${input.botId} AND x.execution_key=${input.executionKey}
      AND x.snapshot->>'contextIsolation'='shared_clean' AND a."ownerId"=${input.ownerId} AND a."botId"=${input.botId}::uuid
      AND a."contextIsolation"='shared_clean' AND a.mode='reply'`)
  if (!proof) throw Error('shared_bot_message_authority_required')
  for (const messageId of input.messageIds) await rows(query, sql`INSERT INTO bot_chat_message_authorities("messageId","eventId","executionId")
    VALUES(${messageId}::uuid,${String(proof.eventId)}::uuid,${String(proof.id)}::uuid) ON CONFLICT DO NOTHING`)
}

/** Queued legacy notifications are retained but cannot execute as the Owner
 * after sharing. One signed contribution is one turn: Actor/principal/budget
 * boundaries are never combined by the existing inbox batch optimization. */
export async function sharedBotInbox<T extends { id: string; kind: string }>(query: BotChatProofQuery,
  input: { ownerId: string; botId: string; candidates: readonly T[] }): Promise<T[] | null> {
  if (await botChatIsOwnerExclusive(query, input.ownerId, input.botId)) return null
  let selected: T | undefined
  for (const event of input.candidates) {
    const visible = await botChatEventVisible(query, { ...input, eventId: event.id })
    const [authority] = visible ? await rows(query, sql`SELECT mode,"expiresAt">clock_timestamp() AS active
      FROM bot_chat_submission_authorities WHERE "eventId"=${event.id}::uuid AND "contextIsolation"='shared_clean'`) : []
    if (authority?.mode === 'reply' && authority.active === true) { selected ??= event; continue }
    // Valid shared system events are readable notifications, not an implicit
    // organization spending authorization. A person's next reply can cite them.
    await rows(query, sql`UPDATE coordinator_events SET "deliveredAt"=clock_timestamp(),tier='background'
      WHERE id=${event.id}::uuid AND "userId"=${input.ownerId} AND "botId"=${input.botId}::uuid AND "deliveredAt" IS NULL`)
  }
  return selected ? [selected] : []
}
