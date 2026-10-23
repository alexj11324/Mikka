import { and, desc, eq, sql, type SQL } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { issueMembers, issues, users } from '@/lib/db/schema'
import { ActionFailureError } from '@/lib/action-error'
import { readIssueMetadata } from '@/lib/issue-metadata'

/** Backend relation-picker search. Authorization is applied before the SQL limit,
 * with owner-only personal tasks, active workspace membership and no 100-row cap.
 * Pagination retains PostgreSQL microseconds; no hidden result scan window. */
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

/**
 * The cursor carries updatedAt at Postgres' full microsecond precision (cursorKey, rendered by
 * the database as UTC text). A JS Date only keeps milliseconds, so a cursor built from one would
 * skip rows whose updatedAt differs from the last row only below the millisecond.
 */
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/
const cursorKey = sql<string>`to_char(${issues.updatedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`

export function encodeCursor(row: { cursorKey: string; id: string }) {
  return Buffer.from(JSON.stringify({ u: row.cursorKey, i: row.id })).toString('base64url')
}

function decodeCursor(value: string) {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (typeof parsed?.u !== 'string' || !CURSOR_TIME.test(parsed.u) || typeof parsed?.i !== 'string' || !UUID.test(parsed.i)) return null
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
export function relationClosureQuery(id: string, ownerId: string, direction: 'descendants' | 'ancestors', visibility: SQL = sql`false`) {
  const step = direction === 'descendants'
    ? sql`join walk w on (coalesce(issues.content->'attrs'->'mikka', issues.content->'attrs'->'orvilo')->>'parentId') = w.id::text`
    : sql`join walk w on issues.id::text = w.parent_id`
  return sql`with recursive walk(id, parent_id, depth) as (
      select issues.id, coalesce(issues.content->'attrs'->'mikka', issues.content->'attrs'->'orvilo')->>'parentId', 0
      from issues where issues.id = ${id} and issues."userId" = ${ownerId} and ${visibility}
      union all
      select issues.id, coalesce(issues.content->'attrs'->'mikka', issues.content->'attrs'->'orvilo')->>'parentId', w.depth + 1
      from issues ${step}
      where issues."userId" = ${ownerId} and ${visibility} and w.depth <= ${RELATION_DEPTH_LIMIT}
    )
    select id, max(depth)::int as depth from walk where depth > 0 group by id`
}

export async function relationClosure(db: Db, id: string, ownerId: string, direction: 'descendants' | 'ancestors', visibility: SQL = sql`false`) {
  const result = await db.execute<{ id: string; depth: number }>(relationClosureQuery(id, ownerId, direction, visibility))
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
  // Number and substring lookups have dedicated expression / pg_trgm indexes.
  if (query.kind === 'number') return sql`(${meta}->>'number') = ${String(query.number)}`
  if (query.kind === 'title') return sql`${issues.title} ilike ${'%' + escapeLike(query.text) + '%'}`
  return undefined
}

export type SearchRow = { id: string; ownerId: string; ownerName: string | null; scope: 'personal' | 'workspace'; title: string; status: string; priority: string; revision: number; updatedAt: Date; cursorKey: string; metadata: Metadata }

/** One page of already-authorized rows; visibility is part of SQL before LIMIT. */
export async function fetchCandidates(db: Db, input: { userId: string; visibility: SQL; excludedIds: string[]; query: SearchQuery; cursor: { updatedAt: string; id: string } | null; limit: number }) {
  const rows = await db.select({ id: issues.id, ownerId: issues.userId, ownerName: users.name, scope: issues.scope, title: issues.title, status: issues.status, priority: issues.priority, revision: issues.revision, updatedAt: issues.updatedAt, cursorKey, metadata: sql<Metadata | null>`${meta}` })
    .from(issues).leftJoin(users, eq(users.id, issues.userId))
    .where(and(
      input.visibility,
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

/** Search only authorized rows. No total-count side channel or post-limit filtering. */
export async function searchIssues(db: Db, input: { userId: string; params: SearchParams; workspaceId: string }) {
  const { issueVisibility } = await import('@/lib/issue-visibility')
  const { taskIdentifiers } = await import('@/lib/task-identifier-server')
  const { params, userId } = input
  const { predicate } = await issueVisibility(userId, false, input.workspaceId)
  const anchors = [...new Set([params.issueId, params.excludeId].filter((id): id is string => !!id))]
  const anchorRows = anchors.length ? await db.select().from(issues).where(and(idIn(issues.id, anchors), predicate)) : []
  if (anchorRows.length !== anchors.length) throw new ActionFailureError('issueNotFound')
  const currentRow = anchorRows.find(row => row.id === params.issueId)
  const current = currentRow ? { id: currentRow.id, ownerId: currentRow.userId, metadata: readIssueMetadata(currentRow.content) } : null
  const excluded = new Set<string>()
  let truncated = false
  if (params.excludeId) {
    excluded.add(params.excludeId)
    const anchor = anchorRows.find(row => row.id === params.excludeId)!
    for (const direction of ['descendants', 'ancestors'] as const) {
      if (!(direction === 'descendants' ? params.excludeDescendants : params.excludeAncestors)) continue
      const closure = await relationClosure(db, anchor.id, anchor.userId, direction, predicate)
      closure.ids.forEach(id => excluded.add(id))
      truncated ||= closure.truncated
    }
  }
  const members = current && current.ownerId !== userId ? await memberIssueIds(db, current.ownerId, userId) : []
  const rows = await fetchCandidates(db, { userId, visibility: predicate, excludedIds: [...excluded], query: params.query, cursor: params.cursor, limit: params.limit + 1 })
  const page = rows.slice(0, params.limit)
  const identifiers = await taskIdentifiers(page.map(row => ({ id: row.id, ownerId: row.ownerId, scope: row.scope, number: row.metadata.number })))
  return {
    items: page.map((row): SearchResultItem => ({
      id: row.id, identifier: identifiers.get(row.id) ?? null,
      title: row.title, status: row.status, priority: row.priority,
      ownerId: row.ownerId, ownerName: row.ownerName,
      parentId: row.metadata.parentId ?? null, revision: row.revision, updatedAt: row.updatedAt.toISOString(),
      existingRelation: current ? existingRelation(current, row, params.relationKind) : null,
      canRelate: !!current && row.id !== current.id && row.ownerId === current.ownerId
        && canEditIssueRelation({ actorId: userId, ownerId: current.ownerId, currentId: current.id, targetId: row.id, memberIssueIds: members }),
    })),
    nextCursor: rows.length > params.limit ? encodeCursor(page[page.length - 1]) : null,
    truncated,
  }
}

/** Mirrors the existing writer's ownership/membership precondition, without widening writes. */
export function canEditIssueRelation(input: { actorId: string; ownerId: string; currentId: string; targetId: string | null; memberIssueIds: string[] }) {
  return input.actorId === input.ownerId || [input.currentId, ...(input.targetId ? [input.targetId] : [])].every(id => input.memberIssueIds.includes(id))
}
