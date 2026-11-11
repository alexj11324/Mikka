import assert from 'node:assert/strict'
import test from 'node:test'
import { foldComments, normalizeLinkTarget, type CommentRow } from './issue-comment-tree'

const at = (minute: number) => new Date(Date.UTC(2026, 10, 11, 12, minute)).toISOString()
const row = (id: string, parentId: string | null, minute: number): CommentRow => ({ id, parentId, createdAt: at(minute) })

test('a top-level comment keeps its replies, oldest first', () => {
  const folded = foldComments([row('a', null, 0), row('b', 'a', 2), row('c', 'a', 1)])
  assert.equal(folded.length, 1)
  assert.equal(folded[0].id, 'a')
  assert.deepEqual(folded[0].replies.map(reply => reply.id), ['c', 'b'], 'replies read oldest first')
})

test('a reply to a reply joins the same top-level thread instead of indenting again', () => {
  const folded = foldComments([row('a', null, 0), row('b', 'a', 1), row('c', 'b', 2)])
  assert.equal(folded.length, 1, 'one thread, not a third level')
  assert.equal(folded[0].id, 'a')
  assert.deepEqual(folded[0].replies.map(reply => reply.id), ['b', 'c'])
  assert.deepEqual(folded[0].replies[0].replies, [], 'the nested reply is drawn flat')
})

test('a reply whose parent is not in the list is drawn at the top rather than dropped', () => {
  const folded = foldComments([row('orphan', 'missing', 1)])
  assert.equal(folded.length, 1)
  assert.equal(folded[0].id, 'orphan')
  assert.deepEqual(folded[0].replies, [])
})

test('a parent cycle terminates and still shows every comment exactly once', () => {
  // Two rows that name each other; neither is reachable from a top-level row.
  const folded = foldComments([row('a', 'b', 0), row('b', 'a', 1)])
  const seen: string[] = []
  const walk = (nodes: typeof folded) => { for (const node of nodes) { seen.push(node.id); walk(node.replies) } }
  walk(folded)
  assert.deepEqual(seen.sort(), ['a', 'b'], 'both comments survive a cycle')
})

test('top-level comments keep their order and several threads stay separate', () => {
  const folded = foldComments([row('a', null, 0), row('b', null, 1), row('a1', 'a', 2), row('b1', 'b', 3)])
  assert.deepEqual(folded.map(thread => thread.id), ['a', 'b'])
  assert.deepEqual(folded.map(thread => thread.replies.map(reply => reply.id)), [['a1'], ['b1']])
})

test('an empty task has no threads', () => {
  assert.deepEqual(foldComments([]), [])
})

test('a pull URL and its bare form are the same link, and case never splits one', () => {
  const canonical = normalizeLinkTarget('https://github.com/Owner/Repo/pull/12')
  assert.equal(normalizeLinkTarget('https://GitHub.com/owner/repo/pull/12/'), canonical)
  assert.equal(normalizeLinkTarget('  https://github.com/owner/repo/pull/12  '), canonical, 'surrounding space is trimmed')
})

test('a non-URL reference keeps its identity, lowercased', () => {
  assert.equal(normalizeLinkTarget('ALE-12'), 'ale-12')
  assert.equal(normalizeLinkTarget(' linear:ABC-9 '), 'linear:abc-9')
})

test('an empty reference and a non-http scheme have no normal form', () => {
  assert.equal(normalizeLinkTarget('   '), null)
  assert.equal(normalizeLinkTarget('javascript:alert(1)'), null)
  assert.equal(normalizeLinkTarget('file:///etc/passwd'), null)
})

test('a query and a fragment are part of a link a person pasted', () => {
  assert.notEqual(normalizeLinkTarget('https://example.com/a?tab=1'), normalizeLinkTarget('https://example.com/a?tab=2'))
  assert.notEqual(normalizeLinkTarget('https://example.com/a#one'), normalizeLinkTarget('https://example.com/a#two'))
})
