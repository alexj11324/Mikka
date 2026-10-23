import assert from 'node:assert/strict'
import test from 'node:test'
import { PgDialect } from 'drizzle-orm/pg-core'
import { issues } from '@/lib/db/schema'
import { canEditIssueRelation } from '@/lib/issue-relations'
import { encodeCursor, escapeLike, existingRelation, idIn, parseSearchParams, parseSearchQuery, relationClosureQuery, RELATION_DEPTH_LIMIT, SearchInputError } from '@/lib/issue-search'

const A = '00000000-0000-4000-8000-00000000000a', B = '00000000-0000-4000-8000-00000000000b'
const rejects = (fn: () => unknown, code: string) => assert.throws(fn, (error: unknown) => error instanceof SearchInputError && error.code === code)

test('q: empty is recent, identifiers are exact numbers', () => {
  assert.deepEqual(parseSearchQuery(''), { kind: 'recent' })
  assert.deepEqual(parseSearchQuery('   '), { kind: 'recent' })
  assert.deepEqual(parseSearchQuery(null), { kind: 'recent' })
  assert.deepEqual(parseSearchQuery('ORV-123'), { kind: 'number', number: 123 })
  assert.deepEqual(parseSearchQuery('mik-7'), { kind: 'number', number: 7 })
  assert.deepEqual(parseSearchQuery('42'), { kind: 'number', number: 42 })
  assert.deepEqual(parseSearchQuery('5'), { kind: 'number', number: 5 })
  assert.deepEqual(parseSearchQuery('ORV-0'), { kind: 'title', text: 'ORV-0' })
  assert.deepEqual(parseSearchQuery('ABC-12'), { kind: 'title', text: 'ABC-12' })
})

test('q: one CJK character searches, one ASCII character is rejected', () => {
  assert.deepEqual(parseSearchQuery('修'), { kind: 'title', text: '修' })
  assert.deepEqual(parseSearchQuery(' 版 '), { kind: 'title', text: '版' })
  assert.deepEqual(parseSearchQuery('あ'), { kind: 'title', text: 'あ' })
  rejects(() => parseSearchQuery('a'), 'searchQueryTooShort')
  rejects(() => parseSearchQuery('-'), 'searchQueryTooShort')
  assert.deepEqual(parseSearchQuery('ab'), { kind: 'title', text: 'ab' })
  rejects(() => parseSearchQuery('x'.repeat(201)), 'searchQueryTooLong')
})

test('params: defaults, validation and cursor round trip', () => {
  const parsed = parseSearchParams(new URLSearchParams(''))
  assert.equal(parsed.limit, 20)
  assert.equal(parsed.workspaceId, null)
  rejects(() => parseSearchParams(new URLSearchParams('limit=51')), 'searchInvalidParam')
  rejects(() => parseSearchParams(new URLSearchParams('issueId=nope')), 'searchInvalidParam')
  rejects(() => parseSearchParams(new URLSearchParams('excludeDescendants=true')), 'searchInvalidParam')
  rejects(() => parseSearchParams(new URLSearchParams('relationKind=friend')), 'searchInvalidParam')
  rejects(() => parseSearchParams(new URLSearchParams('cursor=garbage')), 'searchInvalidParam')
  const cursor = encodeCursor({ cursorKey: '2026-10-23T00:00:00.123456Z', id: A })
  const withCursor = parseSearchParams(new URLSearchParams({ cursor, excludeId: A, excludeAncestors: '1', relationKind: 'blocks' }))
  assert.deepEqual(withCursor.cursor, { updatedAt: '2026-10-23T00:00:00.123456Z', id: A })
  // Millisecond cursors (the old Date-based format) are refused rather than silently skipping rows.
  const msCursor = Buffer.from(JSON.stringify({ u: '2026-10-23T00:00:00.123Z', i: A })).toString('base64url')
  rejects(() => parseSearchParams(new URLSearchParams({ cursor: msCursor })), 'searchInvalidParam')
  assert.equal(withCursor.excludeAncestors, true)
  assert.equal(withCursor.relationKind, 'blocks')
})

test('existingRelation reports every kind and prefers relationKind', () => {
  const current = { id: A, ownerId: 'u', metadata: { parentId: B, blockedByIds: [B], relatedIds: [], duplicateOfId: null } }
  assert.equal(existingRelation(current, { id: B, metadata: {} }), 'parent')
  assert.equal(existingRelation(current, { id: B, metadata: {} }, 'blockedBy'), 'blockedBy')
  assert.equal(existingRelation(current, { id: B, metadata: {} }, 'related'), 'parent')
  const plain = { id: A, ownerId: 'u', metadata: {} }
  assert.equal(existingRelation(plain, { id: B, metadata: { parentId: A } }), 'child')
  assert.equal(existingRelation(plain, { id: B, metadata: { blockedByIds: [A] } }), 'blocks')
  assert.equal(existingRelation(plain, { id: B, metadata: { relatedIds: [A] } }), 'related')
  assert.equal(existingRelation({ ...plain, metadata: { duplicateOfId: B } }, { id: B, metadata: {} }), 'duplicate')
  assert.equal(existingRelation(plain, { id: B, metadata: {} }), null)
})

test('canEditIssueRelation: owner always, others need both memberships', () => {
  assert.equal(canEditIssueRelation({ actorId: 'o', ownerId: 'o', currentId: A, targetId: B, memberIssueIds: [] }), true)
  assert.equal(canEditIssueRelation({ actorId: 'm', ownerId: 'o', currentId: A, targetId: B, memberIssueIds: [A, B] }), true)
  assert.equal(canEditIssueRelation({ actorId: 'm', ownerId: 'o', currentId: A, targetId: B, memberIssueIds: [A] }), false)
  assert.equal(canEditIssueRelation({ actorId: 'm', ownerId: 'o', currentId: A, targetId: null, memberIssueIds: [A] }), true)
})

test('id lists bind as one = ANY array parameter, whatever the size', () => {
  const dialect = new PgDialect()
  const ids = Array.from({ length: 2500 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`)
  const query = dialect.sqlToQuery(idIn(issues.id, ids))
  assert.match(query.sql, /= any\(\$1::uuid\[\]\)/)
  assert.equal(query.params.length, 1)
  assert.equal((query.params[0] as string).split(',').length, 2500)
})

test('relation closure CTE is recursive and capped', () => {
  const query = new PgDialect().sqlToQuery(relationClosureQuery(A, 'u', 'descendants'))
  assert.match(query.sql, /with recursive walk/)
  assert.ok(query.params.includes(RELATION_DEPTH_LIMIT))
})

test('escapeLike escapes LIKE wildcards', () => {
  assert.equal(escapeLike('50%_off\\'), '50\\%\\_off\\\\')
})
