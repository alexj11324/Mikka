import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Y from 'yjs'
import { bindCommentAuthorship, persistedCommentAuthorMatches, snapshotCommentAuthorship } from './comment-authorship'
import { issueStatusForLinearType } from './mapping'
import { issueContentToMarkdown, linearMarkdownToIssueContent } from './markdown'
import { shouldApplyLinearSnapshot } from './sync-guards'

test('maps Linear review and duplicate states into Orvilo statuses', () => {
  assert.equal(issueStatusForLinearType('started', 'todo', 'In Review'), 'review')
  assert.equal(issueStatusForLinearType('started', 'review', 'In Progress'), 'doing')
  assert.equal(issueStatusForLinearType('canceled', 'todo', 'Duplicate'), 'duplicate')
  assert.equal(issueStatusForLinearType('canceled', 'duplicate', 'Canceled'), 'canceled')
  assert.equal(issueStatusForLinearType('unknown', 'review'), 'review')
})

test('round trips Markdown task lists without turning them into plain bullets', () => {
  const markdown = '## Checklist\n\n- [x] Done\n- [ ] Next'
  const content = linearMarkdownToIssueContent(markdown)
  assert.equal(content.content?.[1]?.type, 'taskList')
  assert.equal(content.content?.[1]?.content?.[0]?.type, 'taskItem')
  assert.equal(content.content?.[1]?.content?.[0]?.attrs?.checked, true)
  assert.equal(issueContentToMarkdown(content), markdown)
})

test('binds new comment authors to the authenticated writer and preserves old authors', () => {
  const doc = new Y.Doc()
  const thread = new Y.Map<unknown>()
  const messages = new Y.Array<{ id: string; author: string; authorUserId?: string; body: string }>()
  messages.push([{ id: 'reply-1', author: 'Owner', authorUserId: 'owner', body: 'first' }])
  thread.set('id', 'discussion-1')
  thread.set('author', 'Owner')
  thread.set('authorUserId', 'owner')
  thread.set('messages', messages)
  doc.getMap<Y.Map<unknown>>('threads').set('discussion-1', thread)

  const before = snapshotCommentAuthorship(doc)
  doc.transact(() => {
    thread.set('author', 'Victim')
    thread.set('authorUserId', 'victim')
    messages.delete(0, 1)
    messages.insert(0, [{ id: 'reply-1', author: 'Victim', authorUserId: 'victim', body: 'first' }])
    messages.push([{ id: 'reply-2', author: 'Victim', authorUserId: 'victim', body: 'second' }])
  })

  bindCommentAuthorship(doc, before, { id: 'member', name: 'Member' })
  const saved = messages.toArray()
  assert.deepEqual(saved.map(message => [message.author, message.authorUserId]), [['Owner', 'owner'], ['Member', 'member']])
  assert.equal(thread.get('author'), 'Owner')
  assert.equal(thread.get('authorUserId'), 'owner')
  doc.destroy()
})

test('rejects edits to another writer\'s comment body', () => {
  const doc = new Y.Doc()
  const thread = new Y.Map<unknown>()
  const messages = new Y.Array<{ id: string; author: string; authorUserId: string; body: string }>()
  messages.push([{ id: 'reply-1', author: 'Owner', authorUserId: 'owner', body: 'first' }])
  thread.set('id', 'discussion-1')
  thread.set('messages', messages)
  doc.getMap<Y.Map<unknown>>('threads').set('discussion-1', thread)
  const before = snapshotCommentAuthorship(doc)
  messages.delete(0, 1)
  messages.insert(0, [{ id: 'reply-1', author: 'Member', authorUserId: 'member', body: 'changed' }])
  assert.throws(() => bindCommentAuthorship(doc, before, { id: 'member', name: 'Member' }), /cannot edit another user/)
  doc.destroy()
})

test('rejects deleting another writer\'s comment and thread aliases', () => {
  const doc = new Y.Doc()
  const thread = new Y.Map<unknown>()
  const messages = new Y.Array<{ id: string; author: string; authorUserId: string; body: string }>()
  messages.push([{ id: 'reply-1', author: 'Owner', authorUserId: 'owner', body: 'first' }])
  thread.set('id', 'discussion-1')
  thread.set('messages', messages)
  doc.getMap<Y.Map<unknown>>('threads').set('discussion-1', thread)
  const before = snapshotCommentAuthorship(doc)
  doc.getMap<Y.Map<unknown>>('threads').delete('discussion-1')
  assert.throws(() => bindCommentAuthorship(doc, before, { id: 'member', name: 'Member' }), /cannot remove another user/)

  const alias = new Y.Doc()
  const aliasedThread = new Y.Map<unknown>()
  aliasedThread.set('id', 'discussion-1')
  aliasedThread.set('messages', new Y.Array())
  alias.getMap<Y.Map<unknown>>('threads').set('another-key', aliasedThread)
  assert.throws(() => snapshotCommentAuthorship(alias), /thread identity/)
  doc.destroy()
  alias.destroy()
})

test('keeps an existing Linear comment bound to its original app writer', () => {
  assert.equal(persistedCommentAuthorMatches('owner', 'owner'), true)
  assert.equal(persistedCommentAuthorMatches('owner', 'attacker'), false)
  assert.equal(persistedCommentAuthorMatches(null, undefined), true)
  assert.equal(persistedCommentAuthorMatches(null, 'attacker'), false)

  const doc = new Y.Doc()
  const thread = new Y.Map<unknown>()
  const messages = new Y.Array<{ id: string; author: string; authorUserId: string; body: string }>()
  messages.push([{ id: 'reply-1', author: 'Owner', authorUserId: 'owner', body: 'first' }])
  thread.set('id', 'discussion-1')
  thread.set('author', 'Owner')
  thread.set('authorUserId', 'owner')
  thread.set('messages', messages)
  doc.getMap<Y.Map<unknown>>('threads').set('discussion-1', thread)
  const beforeRemove = snapshotCommentAuthorship(doc)
  messages.delete(0, 1)
  bindCommentAuthorship(doc, beforeRemove, { id: 'owner', name: 'Owner' })
  const afterRemove = snapshotCommentAuthorship(doc)
  messages.push([{ id: 'reply-1', author: 'Attacker', authorUserId: 'attacker', body: 'forged' }])
  bindCommentAuthorship(doc, afterRemove, { id: 'attacker', name: 'Attacker' })
  assert.equal(persistedCommentAuthorMatches('owner', messages.toArray()[0]!.authorUserId), false)
  doc.destroy()
})

test('rechecks Linear snapshots against the locked local and remote versions', () => {
  const date = (value: number) => new Date(value * 1000)
  assert.equal(shouldApplyLinearSnapshot({ remoteUpdatedAt: date(10), localUpdatedAt: date(8), appSyncedAt: date(8), linearUpdatedAt: date(11), force: false }), false)
  assert.equal(shouldApplyLinearSnapshot({ remoteUpdatedAt: date(11), localUpdatedAt: date(12), appSyncedAt: date(8), linearUpdatedAt: date(10), force: true }), false)
  assert.equal(shouldApplyLinearSnapshot({ remoteUpdatedAt: date(11), localUpdatedAt: date(8), appSyncedAt: date(8), linearUpdatedAt: date(10), force: true }), true)
})
