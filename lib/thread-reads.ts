import 'server-only'
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { agentRuns, conversationReads, issues } from '@/lib/db/schema'
import { ActionFailureError } from '@/lib/action-error'
import type { IssueReader } from '@/lib/issue-visibility'

// Match the transcript's precision. A reply and the end of a run are things
// a reader can see. Lease renewals, title changes and the owner's sends are not.
const threadReadActivity = sql<Date | null>`date_trunc('milliseconds', greatest(${agentRuns.lastReplyAt}, ${agentRuns.finishedAt}))`
const threadReadKey = sql<string>`'run:' || ${agentRuns.id}::text`
export const joinThreadRead = (userId: string) => and(eq(conversationReads.userId, userId), eq(conversationReads.conversationId, threadReadKey))
export const threadUnread = sql<boolean>`coalesce(${conversationReads.manuallyUnread}, false)
  or coalesce(${threadReadActivity} > coalesce(${conversationReads.runReadAt}, '-infinity'::timestamptz), false)`
const threadReadRevision = sql<number>`coalesce(${conversationReads.unreadRevision}, 0)`

export type ThreadReadChange =
  | { action: 'unread'; runId: string }
  | { action: 'unread'; chatId: string }
  | { action: 'read'; runId: string; through: string | null; revision: number }
  | { action: 'readAll' }

/** The activity and revision a client may acknowledge. Only a selected,
 * authorized run supplies a watermark; the client cannot create a future one. */
export async function threadReadReceipts(userId: string, runIds: string[]) {
  if (!runIds.length) return []
  const { db } = await import('@/lib/db')
  const result = await db.select({ id: agentRuns.id, activity: threadReadActivity.mapWith(agentRuns.finishedAt), revision: threadReadRevision, unread: threadUnread })
    .from(agentRuns).leftJoin(conversationReads, joinThreadRead(userId)).where(and(eq(agentRuns.userId, userId), inArray(agentRuns.id, runIds)))
  return result.map(({ id, activity, revision, unread }) => ({ id, through: activity?.toISOString() ?? null, revision, unread }))
}

export async function changeThreadRead(reader: IssueReader, workspaceId: string, change: ThreadReadChange) {
  const { withTaskWorkspace } = await import('@/lib/task-workspace')
  try {
    return await withTaskWorkspace(reader, workspaceId, () => writeThreadRead(reader, workspaceId, change))
  } catch (error) {
    if (error instanceof ActionFailureError && error.code === 'workspaceAccessDenied') return false
    throw error
  }
}

async function writeThreadRead(reader: IssueReader, workspaceId: string, change: ThreadReadChange) {
  if (change.action !== 'readAll' && !('chatId' in change)) return writeRunRead(reader, workspaceId, change)
  const { pool, withDatabaseClient } = await import('@/lib/db')
  const userId = typeof reader === 'string' ? reader : reader.id
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const applied = await withDatabaseClient(client, async () => {
      // Match the group writer's lock before observing any message or changing
      // a mark. Stable order serializes overlapping bulk operations.
      const { rows } = await client.query<{ id: string }>(`SELECT c.id FROM conversations c
        JOIN conversation_members m ON m."conversationId"=c.id AND m."memberType"='user'
          AND m."memberId"=$1 AND m."leftAt" IS NULL
        WHERE c."workspaceId"=$2 AND c."createdBy"=$1 AND c.kind='group' AND c."creationPurpose"='conversation'
          AND ($3::uuid IS NULL OR c.id=$3) ORDER BY c.id FOR UPDATE OF c FOR SHARE OF m`,
      [userId, workspaceId, 'chatId' in change ? change.chatId : null])
      if ('chatId' in change) {
        if (!rows.length) return false
        const { setGroupPreference } = await import('@/lib/chat-preferences')
        return await setGroupPreference(userId, change.chatId, { markedUnread: true }) === 'ok'
      }
      if (!await writeRunRead(reader, workspaceId, change)) return false
      const { acknowledgeGroupReads } = await import('./group-read-receipts')
      if (await acknowledgeGroupReads(client, userId, rows.map(row => row.id))) {
        await (await import('./live/lists')).threadReadChanged(client, userId, workspaceId, 'group_list')
      }
      return true
    })
    await client.query(applied ? 'COMMIT' : 'ROLLBACK')
    return applied
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}

async function writeRunRead(reader: IssueReader, workspaceId: string, change: Exclude<ThreadReadChange, { chatId: string }>) {
  const { db, pool } = await import('@/lib/db')
  const userId = typeof reader === 'string' ? reader : reader.id
  const { issueVisibility } = await import('@/lib/issue-visibility')
  const visibility = await issueVisibility(reader, false, workspaceId, db, { withTeamLinks: false })
  if (!visibility.workspaceIds.includes(workspaceId)) return false
  const visible = db.select({ key: threadReadKey.as('key'), activity: threadReadActivity.as('activity') })
    .from(agentRuns).leftJoin(issues, eq(issues.id, agentRuns.issueId))
    .where(and(eq(agentRuns.userId, userId), eq(agentRuns.workspaceId, workspaceId),
      or(isNull(agentRuns.issueId), and(eq(issues.workspaceId, workspaceId), visibility.predicate)),
      change.action === 'readAll' ? undefined : eq(agentRuns.id, change.runId)))
  // Updating both the watermark and the manual flag under one row lock prevents
  // old clients and overlapping reads from reversing later work. Setting a manual
  // flag increments its revision even if it is set twice.
  const unread = change.action === 'unread'
  const observed = change.action === 'read' ? sql`${change.through}::timestamptz` : sql`v.activity`
  const revision = change.action === 'read' ? sql`r."unreadRevision" = ${change.revision}` : sql`true`
  const result = await db.execute(sql`with visible as (${visible}), applied as (
    insert into conversation_reads as r ("userId", "conversationId", "runReadAt", "manuallyUnread", "unreadRevision")
    select ${userId}, v.key, ${unread ? sql`null` : observed}, ${unread}, ${unread ? 1 : 0} from visible v
    where (${observed} is null or ${observed} <= v.activity)
      and (${change.action !== 'readAll'} or v.activity is not null or exists (select 1 from conversation_reads saved
        where saved."userId"=${userId} and saved."conversationId"=v.key and saved."manuallyUnread"))
    on conflict ("userId","conversationId") do update set
      "runReadAt"=greatest(r."runReadAt", excluded."runReadAt"),
      "manuallyUnread"=case when ${revision} then excluded."manuallyUnread" else r."manuallyUnread" end,
      "unreadRevision"=r."unreadRevision"+excluded."unreadRevision",
      "updatedAt"=now()
    where excluded."manuallyUnread" or excluded."runReadAt" > coalesce(r."runReadAt", '-infinity'::timestamptz)
       or (r."manuallyUnread" and ${revision})
    returning 1
  ) select exists(select 1 from visible) as found, exists(select 1 from applied) as changed`)
  if (result.rows[0]?.changed) await (await import('@/lib/live/lists')).threadReadChanged(pool, userId, workspaceId)
  return change.action === 'readAll' || Boolean(result.rows[0]?.found)
}
