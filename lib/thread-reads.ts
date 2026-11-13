import 'server-only'
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { db, pool } from '@/lib/db'
import { agentRuns, conversationReads, issues } from '@/lib/db/schema'
import { withTaskWorkspace } from '@/lib/task-workspace'
import { ActionFailureError } from '@/lib/action-error'
import { issueVisibility, type IssueReader } from '@/lib/issue-visibility'
import { ownerListChanged } from '@/lib/live/lists'

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
  | { action: 'read'; runId: string; through: string | null; revision: number }
  | { action: 'readAll' }

/** The activity and revision a client may acknowledge. Only a selected,
 * authorized run supplies a watermark; the client cannot create a future one. */
export async function threadReadReceipts(userId: string, runIds: string[]) {
  if (!runIds.length) return []
  const result = await db.select({ id: agentRuns.id, activity: threadReadActivity.mapWith(agentRuns.finishedAt), revision: threadReadRevision, unread: threadUnread })
    .from(agentRuns).leftJoin(conversationReads, joinThreadRead(userId)).where(and(eq(agentRuns.userId, userId), inArray(agentRuns.id, runIds)))
  return result.map(({ id, activity, revision, unread }) => ({ id, through: activity?.toISOString() ?? null, revision, unread }))
}

export async function changeThreadRead(reader: IssueReader, workspaceId: string, change: ThreadReadChange) {
  try {
    return await withTaskWorkspace(reader, workspaceId, () => writeThreadRead(reader, workspaceId, change))
  } catch (error) {
    if (error instanceof ActionFailureError && error.code === 'workspaceAccessDenied') return false
    throw error
  }
}

async function writeThreadRead(reader: IssueReader, workspaceId: string, change: ThreadReadChange) {
  const userId = typeof reader === 'string' ? reader : reader.id
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
  if (result.rows[0]?.changed) await ownerListChanged(pool, userId, ['thread_list'])
  return change.action === 'readAll' || Boolean(result.rows[0]?.found)
}
