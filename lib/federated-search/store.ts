import 'server-only'
import { and, desc, eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { agentSessions, conversations, conversationMembers } from '@/lib/db/schema'
import { workspaceDb } from '@/lib/workspace-db'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { escapeLike, parseSearchParams, searchIssues } from '@/lib/issue-search'
import { nextCursor, type SearchInput } from './input'
import type { SearchItem, SearchPage } from './types'

export class SearchAccessError extends Error {}
/** No context loader: search must never create a workspace or update its name. */
async function requireMembership(userId: string, workspaceId: string) {
  const [row] = await workspaceDb.select({ id: workspaceMembers.userId }).from(workspaceMembers).where(and(
    eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId), eq(workspaceMembers.status, 'active'),
  )).limit(1)
  if (!row) throw new SearchAccessError()
}

export async function readSearchPage(userId: string, input: SearchInput): Promise<SearchPage> {
  if (input.workspaceId) await requireMembership(userId, input.workspaceId)
  if (input.source === 'tasks') {
    // Preserve the task owner's visibility and number/title semantics. No second task search.
    const params = parseSearchParams(new URLSearchParams({ q: input.q, limit: String(input.limit), workspaceId: input.workspaceId! }))
    params.cursor = input.cursor ? { updatedAt: input.cursor.time, id: input.cursor.id } : null
    const page = await searchIssues(db, { userId, params, workspaceId: input.workspaceId! })
    await requireMembership(userId, input.workspaceId!)
    // Existing task cursors contain the exact PG timestamp; wrap it with the source context.
    const key = page.nextCursor ? JSON.parse(Buffer.from(page.nextCursor, 'base64url').toString('utf8')) as { u: string; i: string } : null
    return { source: input.source, items: page.items.map(row => ({ type: 'task', id: row.id, title: row.title, timestamp: row.updatedAt, identifier: row.identifier, status: row.status, priority: row.priority })), nextCursor: key ? nextCursor(input, { time: key.u, id: key.i }) : null }
  }
  const history = input.source === 'history'
  const table = history ? agentSessions : conversations
  const date = history ? agentSessions.updatedAt : conversations.createdAt
  const key = sql<string>`to_char(${date} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
  // Both ownership and group membership are SQL predicates BEFORE LIMIT. No transcript joins.
  const rows = await db.select({ id: table.id, title: table.title, key }).from(table).where(and(
    history ? eq(agentSessions.userId, userId) : and(
      eq(conversations.kind, 'group'), eq(conversations.workspaceId, input.workspaceId!),
      sql`exists (select 1 from ${conversationMembers} where ${conversationMembers.conversationId} = ${conversations.id} and ${conversationMembers.memberType} = 'user' and ${conversationMembers.memberId} = ${userId} and ${conversationMembers.leftAt} is null)`,
    ),
    input.q ? sql`${table.title} ilike ${'%' + escapeLike(input.q) + '%'}` : undefined,
    input.cursor ? sql`(${date}, ${table.id}) < (${input.cursor.time}::timestamptz, ${input.cursor.id}::uuid)` : undefined,
  )).orderBy(desc(date), desc(table.id)).limit(input.limit + 1)
  if (input.workspaceId) await requireMembership(userId, input.workspaceId)
  const page = rows.slice(0, input.limit)
  const last = page.at(-1)
  return {
    source: input.source,
    items: page.map((row): SearchItem => history
      ? { type: 'history', id: row.id, title: row.title, timestamp: row.key, scope: 'owner' }
      : { type: 'group', id: row.id, title: row.title, timestamp: row.key, workspaceId: input.workspaceId! }),
    nextCursor: rows.length > input.limit && last ? nextCursor(input, { time: last.key, id: last.id }) : null,
  }
}
