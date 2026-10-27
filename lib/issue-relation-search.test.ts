import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSearchParams } from '@/lib/issue-search'
import type { SearchResultItem } from '@/lib/issue-search'
import { relationCandidates, relationSearchParams, relationSearchQuery } from '@/lib/issue-relation-search'

const A = '00000000-0000-4000-8000-00000000000a'
const item = (patch: Partial<SearchResultItem>): SearchResultItem => ({ id: A, identifier: 'MIK-1', title: 't', status: 'todo', priority: 'medium', ownerId: A, ownerName: null, parentId: null, revision: 1, updatedAt: '', existingRelation: null, canRelate: true, ...patch })

test('query: numbers and server prefixes pass through, other prefixes search the number', () => {
  assert.deepEqual(relationSearchQuery(''), { q: '', identifier: null })
  assert.deepEqual(relationSearchQuery('  42 '), { q: '42', identifier: null })
  assert.deepEqual(relationSearchQuery('5'), { q: '5', identifier: null })
  assert.deepEqual(relationSearchQuery('mik-7'), { q: 'mik-7', identifier: null })
  assert.deepEqual(relationSearchQuery('ORV-123'), { q: 'ORV-123', identifier: null })
  assert.deepEqual(relationSearchQuery('alex-12'), { q: '12', identifier: 'ALEX-12' })
  assert.deepEqual(relationSearchQuery('COLLAB-3'), { q: '3', identifier: 'COLLAB-3' })
  assert.deepEqual(relationSearchQuery('#12'), { q: '12', identifier: null })
})

test('query: one non-CJK character shows recent, one CJK character searches, titles are capped', () => {
  assert.deepEqual(relationSearchQuery('a'), { q: '', identifier: null })
  assert.deepEqual(relationSearchQuery(' - '), { q: '', identifier: null })
  assert.deepEqual(relationSearchQuery('修'), { q: '修', identifier: null })
  assert.deepEqual(relationSearchQuery('ab'), { q: 'ab', identifier: null })
  assert.equal(relationSearchQuery('x'.repeat(300)).q.length, 200)
})

test('every mapped query is accepted by the server parser', () => {
  for (const raw of ['', 'a', '5', 'MIK-9', 'alex-12', '#12', '修', 'ab', 'x'.repeat(300)]) {
    for (const kind of ['parent', 'child', 'related', 'blockedBy', 'blocks', 'duplicate'] as const) {
      assert.doesNotThrow(() => parseSearchParams(relationSearchParams({ issueId: A, kind, q: relationSearchQuery(raw).q })))
    }
  }
})

test('params: parent excludes descendants, child excludes ancestors, others only the issue itself', () => {
  const parent = parseSearchParams(relationSearchParams({ issueId: A, kind: 'parent', q: '' }))
  assert.equal(parent.issueId, A); assert.equal(parent.excludeId, A); assert.equal(parent.relationKind, 'parent')
  assert.equal(parent.excludeDescendants, true); assert.equal(parent.excludeAncestors, false)
  const child = parseSearchParams(relationSearchParams({ issueId: A, kind: 'child', q: '' }))
  assert.equal(child.excludeDescendants, false); assert.equal(child.excludeAncestors, true)
  const related = parseSearchParams(relationSearchParams({ issueId: A, kind: 'related', q: 'bug' }))
  assert.equal(related.excludeDescendants, false); assert.equal(related.excludeAncestors, false)
  assert.deepEqual(related.query, { kind: 'title', text: 'bug' })
  assert.equal(related.limit, 50)
})

test('candidates: drop rows the server says cannot relate, existing sub-issues, and other identifiers', () => {
  const rows = [item({ id: '1', canRelate: false }), item({ id: '2', existingRelation: 'child' }), item({ id: '3', identifier: 'ALEX-12' }), item({ id: '4', existingRelation: 'related' })]
  assert.deepEqual(relationCandidates(rows, { kind: 'child', identifier: null }).map(row => row.id), ['3', '4'])
  assert.deepEqual(relationCandidates(rows, { kind: 'related', identifier: null }).map(row => row.id), ['2', '3', '4'])
  assert.deepEqual(relationCandidates(rows, { kind: 'parent', identifier: 'ALEX-12' }).map(row => row.id), ['3'])
})
