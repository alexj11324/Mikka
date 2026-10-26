import 'server-only'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
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

type SearchRead = { revalidate: () => Promise<SearchPage> }

function groupVisibility(userId: string, workspaceId: string) {
  return and(
    eq(conversations.kind, 'group'), eq(conversations.workspaceId, workspaceId),
    sql`exists (select 1 from ${conversationMembers} where ${conversationMembers.conversationId} = ${conversations.id} and ${conversationMembers.memberType} = 'user' and ${conversationMembers.memberId} = ${userId} and ${conversationMembers.leftAt} is null)`,
  )
}

async function taskPage(userId: string, input: SearchInput): Promise<SearchPage> {
  // Reuse Auth's full query on both reads, including its owner-visible policy.
  const params = parseSearchParams(new URLSearchParams({ q: input.q, limit: String(input.limit), workspaceId: input.workspaceId! }))
  params.cursor = input.cursor ? { updatedAt: input.cursor.time, id: input.cursor.id } : null
  const page = await searchIssues(db, { userId, params, workspaceId: input.workspaceId! })
  await requireMembership(userId, input.workspaceId!)
  const key = page.nextCursor ? JSON.parse(Buffer.from(page.nextCursor, 'base64url').toString('utf8')) as { u: string; i: string } : null
  return { source: input.source, items: page.items.map(row => ({ type: 'task', id: row.id, title: row.title, timestamp: row.updatedAt, identifier: row.identifier, status: row.status, priority: row.priority })), nextCursor: key ? nextCursor(input, { time: key.u, id: key.i }) : null }
}

export async function readSearchPage(userId: string, input: SearchInput): Promise<SearchRead> {
  if (input.workspaceId) await requireMembership(userId, input.workspaceId)
  if (input.source === 'tasks') {
    await taskPage(userId, input)
    return { async revalidate() {
      await requireMembership(userId, input.workspaceId!)
      // Return a fresh authorized page, not a post-limit filtered old page.
      return taskPage(userId, input)
    } }
  }
  const history = input.source === 'history'
  const table = history ? agentSessions : conversations
  const date = history ? agentSessions.updatedAt : conversations.createdAt
  const key = sql<string>`to_char(${date} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
  // Both ownership and group membership are SQL predicates BEFORE LIMIT. No transcript joins.
  const rows = await db.select({ id: table.id, title: table.title, key }).from(table).where(and(
    history ? eq(agentSessions.userId, userId) : groupVisibility(userId, input.workspaceId!),
    input.q ? sql`${table.title} ilike ${'%' + escapeLike(input.q) + '%'}` : undefined,
    input.cursor ? sql`(${date}, ${table.id}) < (${input.cursor.time}::timestamptz, ${input.cursor.id}::uuid)` : undefined,
  )).orderBy(desc(date), desc(table.id)).limit(input.limit + 1)
  if (input.workspaceId) await requireMembership(userId, input.workspaceId)
  const page = rows.slice(0, input.limit)
  const last = page.at(-1)
  const result: SearchPage = {
    source: input.source,
    items: page.map((row): SearchItem => history
      ? { type: 'history', id: row.id, title: row.title, timestamp: row.key, scope: 'owner' }
      : { type: 'group', id: row.id, title: row.title, timestamp: row.key, workspaceId: input.workspaceId! }),
    nextCursor: rows.length > input.limit && last ? nextCursor(input, { time: last.key, id: last.id }) : null,
  }
  return { async revalidate() {
    if (input.workspaceId) await requireMembership(userId, input.workspaceId)
    // Include the lookahead row: even has-more metadata must not survive revocation.
    // On any loss, reject the whole page. Never post-filter a limited result.
    if (rows.length) {
      const visible = await db.select({ id: table.id }).from(table).where(and(
        inArray(table.id, rows.map(row => row.id)),
        history ? eq(agentSessions.userId, userId) : groupVisibility(userId, input.workspaceId!),
      ))
      if (visible.length !== rows.length) throw new SearchAccessError()
    }
    if (input.workspaceId) await requireMembership(userId, input.workspaceId)
    return result
  } }
}
