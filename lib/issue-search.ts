import { and, desc, eq, isNotNull, or, sql, type SQL } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { issueMembers, issues, users } from '@/lib/db/schema'
import { canEditIssueRelation } from '@/lib/issue-relations'

/**
 * Relation picker search (MIK-16), shared by GET /api/issues/search and the DB tests.
 *
 * Semantics (agreed with Tech Lead):
 * - Visibility is exactly listIssues': owned, member of, or linked to a team the user can access
 *   in the current workspace. Unlinked personal issues show in every workspace, as in listIssues.
 *   Issues have no workspaceId column yet; that is a separate issue.
 * - Empty q: most recently updated visible issues in the current workspace (workspaceId param,
 *   or the current workspace when it is omitted).
 * - q of one CJK character searches normally; one non-CJK character is a 400.
 * - ORV-123, MIK-123 and bare 123 are exact issue-number lookups. A number that does not exist or
 *   is not visible returns an empty list; it never falls back to title matching. Numbers are per
 *   owner, so one number can match several issues; ownerName tells them apart.
 * - excludeDescendants / excludeAncestors walk parentId from excludeId with one recursive CTE,
 *   capped at RELATION_DEPTH_LIMIT levels. `truncated` is true when that walk hit the cap, so
 *   deeper issues may still appear in results. It is unrelated to paging: `nextCursor` is non-null
 *   when more matching rows exist after this page.
 */
export const RELATION_DEPTH_LIMIT = 20
export const SEARCH_LIMIT_DEFAULT = 20
export const SEARCH_LIMIT_MAX = 50
export const RELATION_KINDS = ['parent', 'child', 'related', 'blockedBy', 'blocks', 'duplicate'] as const
export type RelationKind = typeof RELATION_KINDS[number]

/** A drizzle database or transaction; the DB tests pass a transaction they roll back. */
type Db = Pick<NodePgDatabase<Record<string, unknown>>, 'select' | 'execute'>
const meta = sql`coalesce(${issues.content}->'attrs'->'mikka', ${issues.content}->'attrs'->'orvilo')`
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CJK = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u

export type SearchQuery =
  | { kind: 'recent' }
  | { kind: 'number'; number: number }
  | { kind: 'title'; text: string }

export class SearchInputError extends Error {
  constructor(public code: 'searchQueryTooShort' | 'searchQueryTooLong' | 'searchInvalidParam') { super(code) }
}

/** Classifies q. Throws SearchInputError for a single non-CJK character or an over-long query. */
export function parseSearchQuery(raw: string | null | undefined): SearchQuery {
  const text = (raw ?? '').trim()
  if (!text) return { kind: 'recent' }
  if (text.length > 200) throw new SearchInputError('searchQueryTooLong')
  const number = /^(?:(?:ORV|MIK)-)?([1-9]\d{0,8})$/i.exec(text)
  if (number) return { kind: 'number', number: Number(number[1]) }
  if ([...text].length === 1 && !CJK.test(text)) throw new SearchInputError('searchQueryTooShort')
  return { kind: 'title', text }
}

export type SearchParams = {
  query: SearchQuery
  issueId: string | null
  excludeId: string | null
  excludeDescendants: boolean
  excludeAncestors: boolean
  relationKind: RelationKind | null
  workspaceId: string | null
  limit: number
  cursor: { updatedAt: string; id: string } | null
}

export function encodeCursor(row: { updatedAt: Date; id: string }) {
  return Buffer.from(JSON.stringify({ u: row.updatedAt.toISOString(), i: row.id })).toString('base64url')
}

function decodeCursor(value: string) {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (typeof parsed?.u !== 'string' || Number.isNaN(Date.parse(parsed.u)) || typeof parsed?.i !== 'string' || !UUID.test(parsed.i)) return null
    return { updatedAt: parsed.u as string, id: parsed.i as string }
  } catch { return null }
}

/** Parses URLSearchParams into SearchParams, or throws SearchInputError. */
export function parseSearchParams(params: URLSearchParams): SearchParams {
  const uuid = (name: string) => {
    const value = params.get(name)
    if (!value) return null
    if (!UUID.test(value)) throw new SearchInputError('searchInvalidParam')
    return value
  }
  const flag = (name: string) => {
    const value = params.get(name)
    if (value === null || value === '' || value === 'false' || value === '0') return false
    if (value === 'true' || value === '1') return true
    throw new SearchInputError('searchInvalidParam')
  }
  const limitText = params.get('limit')
  const limit = limitText === null ? SEARCH_LIMIT_DEFAULT : Number(limitText)
  if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_LIMIT_MAX) throw new SearchInputError('searchInvalidParam')
  const relationKind = params.get('relationKind')
  if (relationKind && !RELATION_KINDS.includes(relationKind as RelationKind)) throw new SearchInputError('searchInvalidParam')
  const cursorText = params.get('cursor')
  const cursor = cursorText ? decodeCursor(cursorText) : null
  if (cursorText && !cursor) throw new SearchInputError('searchInvalidParam')
  const excludeId = uuid('excludeId')
  const excludeDescendants = flag('excludeDescendants'), excludeAncestors = flag('excludeAncestors')
  if ((excludeDescendants || excludeAncestors) && !excludeId) throw new SearchInputError('searchInvalidParam')
  return { query: parseSearchQuery(params.get('q')), issueId: uuid('issueId'), excludeId, excludeDescendants, excludeAncestors, relationKind: relationKind as RelationKind | null, workspaceId: uuid('workspaceId'), limit, cursor }
}

/**
 * `id = any($1)` binds the whole list as one array parameter, so the statement stays the same
 * size however many ids there are. Past roughly 2000 ids, switch to a temp table or a
 * VALUES join so the planner sees row estimates instead of one big array.
 */
export function idIn(column: SQL | typeof issues.id, ids: string[]) {
  return sql`${column} = any(${`{${ids.join(',')}}`}::uuid[])`
}

/**
 * One recursive CTE for both directions. It walks one level past the cap so we know whether
 * the cap cut the walk short; rows at depth RELATION_DEPTH_LIMIT + 1 are reported via
 * `truncated` but not excluded.
 */
export function relationClosureQuery(id: string, ownerId: string, direction: 'descendants' | 'ancestors') {
  const step = direction === 'descendants'
    ? sql`join walk w on (coalesce(i.content->'attrs'->'mikka', i.content->'attrs'->'orvilo')->>'parentId') = w.id::text`
    : sql`join walk w on i.id::text = w.parent_id`
  return sql`with recursive walk(id, parent_id, depth) as (
      select i.id, coalesce(i.content->'attrs'->'mikka', i.content->'attrs'->'orvilo')->>'parentId', 0
      from issues i where i.id = ${id} and i."userId" = ${ownerId}
      union all
      select i.id, coalesce(i.content->'attrs'->'mikka', i.content->'attrs'->'orvilo')->>'parentId', w.depth + 1
      from issues i ${step}
      where i."userId" = ${ownerId} and w.depth <= ${RELATION_DEPTH_LIMIT}
    )
    select id, max(depth)::int as depth from walk where depth > 0 group by id`
}

export async function relationClosure(db: Db, id: string, ownerId: string, direction: 'descendants' | 'ancestors') {
  const result = await db.execute<{ id: string; depth: number }>(relationClosureQuery(id, ownerId, direction))
  const rows = result.rows
  return { ids: rows.filter(row => row.depth <= RELATION_DEPTH_LIMIT).map(row => row.id), truncated: rows.some(row => row.depth > RELATION_DEPTH_LIMIT) }
}

type Metadata = { number?: number; parentId?: string | null; blockedByIds?: string[]; relatedIds?: string[]; duplicateOfId?: string | null }
export type CurrentIssue = { id: string; ownerId: string; metadata: Metadata }

/** The relation `row` already has with `current`, preferring `preferred` when several hold. */
export function existingRelation(current: CurrentIssue, row: { id: string; metadata: Metadata }, preferred: RelationKind | null = null): RelationKind | null {
  const holds: Record<RelationKind, boolean> = {
    parent: current.metadata.parentId === row.id,
    child: row.metadata.parentId === current.id,
    blockedBy: (current.metadata.blockedByIds ?? []).includes(row.id),
    blocks: (row.metadata.blockedByIds ?? []).includes(current.id),
    related: (current.metadata.relatedIds ?? []).includes(row.id) || (row.metadata.relatedIds ?? []).includes(current.id),
    duplicate: current.metadata.duplicateOfId === row.id,
  }
  if (preferred && holds[preferred]) return preferred
  return RELATION_KINDS.find(kind => holds[kind]) ?? null
}

export function escapeLike(text: string) {
  return text.replace(/[\\%_]/g, match => '\\' + match)
}

export function searchCondition(query: SearchQuery): SQL | undefined {
  if (query.kind === 'number') return sql`(${meta}->>'number') = ${String(query.number)}`
  if (query.kind === 'title') return sql`${issues.title} ilike ${'%' + escapeLike(query.text) + '%'}`
  return undefined
}

export type SearchRow = { id: string; ownerId: string; ownerName: string | null; title: string; status: string; priority: string; revision: number; updatedAt: Date; metadata: Metadata }

/** One page of candidate rows under listIssues' row-level visibility (team filtering is the caller's). */
export async function fetchCandidates(db: Db, input: { userId: string; publicIds: string[]; excludedIds: string[]; query: SearchQuery; cursor: { updatedAt: string; id: string } | null; limit: number }) {
  const rows = await db.select({ id: issues.id, ownerId: issues.userId, ownerName: users.name, title: issues.title, status: issues.status, priority: issues.priority, revision: issues.revision, updatedAt: issues.updatedAt, metadata: sql<Metadata | null>`${meta}` })
    .from(issues).leftJoin(users, eq(users.id, issues.userId))
    .leftJoin(issueMembers, and(eq(issueMembers.issueId, issues.id), eq(issueMembers.memberId, input.userId)))
    .where(and(
      or(eq(issues.userId, input.userId), isNotNull(issueMembers.memberId), input.publicIds.length ? idIn(issues.id, input.publicIds) : undefined),
      sql`(${meta}->>'deletedAt') is null`,
      searchCondition(input.query),
      input.excludedIds.length ? sql`not (${idIn(issues.id, input.excludedIds)})` : undefined,
      input.cursor ? sql`(${issues.updatedAt}, ${issues.id}) < (${input.cursor.updatedAt}::timestamptz, ${input.cursor.id}::uuid)` : undefined,
    ))
    .orderBy(desc(issues.updatedAt), desc(issues.id)).limit(input.limit)
  return rows.map(row => ({ ...row, metadata: row.metadata ?? {} })) as SearchRow[]
}

export async function memberIssueIds(db: Db, ownerId: string, userId: string) {
  const rows = await db.select({ id: issueMembers.issueId }).from(issueMembers).where(and(eq(issueMembers.userId, ownerId), eq(issueMembers.memberId, userId)))
  return rows.map(row => row.id)
}

export type SearchResultItem = {
  id: string; identifier: string | null; title: string; status: string; priority: string
  ownerId: string; ownerName: string | null; parentId: string | null; revision: number; updatedAt: string
  existingRelation: RelationKind | null; canRelate: boolean
}

/**
 * Runs the search. `isVisible` applies listIssues' team filter (issues linked to a team must belong
 * to a team the user can access in this workspace); it lives outside because team links are in
 * the workspace database.
 */
export async function searchIssues(db: Db, input: {
  userId: string; params: SearchParams; publicIds: string[]; current: CurrentIssue | null
  isVisible: (ids: string[]) => Promise<Set<string>>
}) {
  const { params, userId, current } = input
  const excluded = new Set<string>()
  let truncated = false
  if (params.excludeId) {
    excluded.add(params.excludeId)
    const owner = current?.id === params.excludeId ? current.ownerId : null
    for (const direction of ['descendants', 'ancestors'] as const) {
      if (!(direction === 'descendants' ? params.excludeDescendants : params.excludeAncestors)) continue
      const closure = owner ? await relationClosure(db, params.excludeId, owner, direction) : await (async () => {
        const [row] = await db.select({ ownerId: issues.userId }).from(issues).where(eq(issues.id, params.excludeId!)).limit(1)
        return row ? relationClosure(db, params.excludeId!, row.ownerId, direction) : { ids: [], truncated: false }
      })()
      closure.ids.forEach(id => excluded.add(id))
      truncated ||= closure.truncated
    }
  }
  const members = current && current.ownerId !== userId ? await memberIssueIds(db, current.ownerId, userId) : []
  const items: SearchRow[] = []
  let cursor = params.cursor
  let more = false
  // Team filtering can drop rows after the SQL limit; keep reading pages until this one is full.
  for (let round = 0; round < 5 && items.length <= params.limit; round++) {
    const batch = await fetchCandidates(db, { userId, publicIds: input.publicIds, excludedIds: [...excluded], query: params.query, cursor, limit: params.limit + 1 })
    const visible = await input.isVisible(batch.map(row => row.id))
    items.push(...batch.filter(row => visible.has(row.id)))
    if (batch.length <= params.limit) { more = false; break }
    more = true
    const last = batch[batch.length - 1]
    cursor = { updatedAt: last.updatedAt.toISOString(), id: last.id }
  }
  const page = items.slice(0, params.limit)
  const hasNext = items.length > params.limit || more
  return {
    items: page.map((row): SearchResultItem => ({
      id: row.id,
      identifier: row.metadata.number ? `ORV-${row.metadata.number}` : null,
      title: row.title, status: row.status, priority: row.priority,
      ownerId: row.ownerId, ownerName: row.ownerName,
      parentId: row.metadata.parentId ?? null, revision: row.revision, updatedAt: row.updatedAt.toISOString(),
      existingRelation: current ? existingRelation(current, row, params.relationKind) : null,
      canRelate: !!current && row.id !== current.id && row.ownerId === current.ownerId
        && canEditIssueRelation({ actorId: userId, ownerId: current.ownerId, currentId: current.id, targetId: row.id, memberIssueIds: members }),
    })),
    // When every scanned row was hidden by the team filter, resume after the last scanned row.
    nextCursor: !hasNext ? null : page.length ? encodeCursor(page[page.length - 1]) : cursor ? encodeCursor({ updatedAt: new Date(cursor.updatedAt), id: cursor.id }) : null,
    truncated,
  }
}
