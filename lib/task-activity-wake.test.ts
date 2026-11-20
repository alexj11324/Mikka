import { test } from 'node:test'
import assert from 'node:assert/strict'
import { issueActivityEvent } from './coordinator-events'
import { mentionedBotIds, newComments, taskActivityWakes, textMentions } from './task-activity-wake'
import type { ThreadRecord } from './task-discussion'

const thread = (id: string, ...bodies: [string, string][]): ThreadRecord => ({ id, author: 'A', createdAt: '2026-11-20T00:00:00Z', resolved: false,
  messages: bodies.map(([authorUserId, body], index) => ({ id: `${id}-${index}`, author: authorUserId, authorUserId, body, at: '2026-11-20T00:00:00Z' })) })
const doc = (...ids: string[]) => ({ type: 'doc', content: [{ type: 'paragraph', content: ids.map(id => ({ type: 'mention', attrs: { id, label: id } })) }] })
const captain = { id: 'bot-1', name: 'Captain', ownerId: 'owner' }
const helper = { id: 'bot-2', name: 'Helper', ownerId: 'writer' }

test('only appended messages with text are new comments, keyed by thread and position', () => {
  const before = [thread('t1', ['writer', 'first'])]
  const after = [thread('t1', ['writer', 'first'], ['writer', 'reply'], ['writer', '  ']), thread('t2', ['other', 'new thread'])]
  assert.deepEqual(newComments(before, after), [
    { key: 'comment:t1:1', body: 'reply', authorUserId: 'writer' },
    { key: 'comment:t2:0', body: 'new thread', authorUserId: 'other' },
  ])
})

test('an @name mention needs the whole name; Bot chips are read from the description', () => {
  assert.equal(textMentions('Can @captain look?', 'Captain'), true)
  assert.equal(textMentions('@Captain', 'Captain'), true)
  assert.equal(textMentions('@Captains are here', 'Captain'), false)
  assert.equal(textMentions('captain without at', 'Captain'), false)
  assert.equal(textMentions('请 @小助手，看一下', '小助手'), true)
  assert.deepEqual([...mentionedBotIds(doc('bot:b1', 'user-1', 'bot:b2'))], ['b1', 'b2'])
})

test('a comment wakes the assigned Bot, and an @-mentioned own Bot as a mention; another writer only wakes the assigned Bot', () => {
  const base = { writerId: 'writer', version: 'v2', assigned: captain, own: [helper] }
  const content = { before: { threads: [], content: null }, after: { threads: [thread('t1', ['writer', 'Please check @Helper'])], content: null } }
  assert.deepEqual(taskActivityWakes({ ...base, ...content }), [
    { bot: captain, kind: 'comment', key: 'comment:t1:0', text: 'Please check @Helper' },
    { bot: helper, kind: 'mention', key: 'comment:t1:0', text: 'Please check @Helper' },
  ])
  // A message written by someone else (a synced Linear comment, another person's edit) wakes nothing in this save.
  assert.deepEqual(taskActivityWakes({ ...base, writerId: 'someone', own: [], ...content }), [])
  // Mentioning the assigned Bot is one mention, not a comment and a mention.
  assert.deepEqual(taskActivityWakes({ ...base, own: [], before: { threads: [], content: null }, after: { threads: [thread('t1', ['writer', '@Captain go'])], content: null }, assigned: captain })
    .map(wake => [wake.bot.id, wake.kind]), [['bot-1', 'comment']])
  assert.deepEqual(taskActivityWakes({ ...base, own: [captain], assigned: null, before: { threads: [], content: null }, after: { threads: [thread('t1', ['writer', '@Captain go'])], content: null } })
    .map(wake => [wake.bot.id, wake.kind]), [['bot-1', 'mention']])
})

test('a Bot chip wakes only when added, only for a known Bot, once per description version', () => {
  const base = { writerId: 'writer', version: 'v3', assigned: null, own: [helper] }
  assert.deepEqual(taskActivityWakes({ ...base, before: { threads: [], content: doc() }, after: { threads: [], content: doc('bot:bot-2', 'bot:stranger') } }),
    [{ bot: helper, kind: 'mention', key: 'description:v3', text: null }])
  assert.deepEqual(taskActivityWakes({ ...base, before: { threads: [], content: doc('bot:bot-2') }, after: { threads: [], content: doc('bot:bot-2') } }), [])
})

test('the wake goes to the Bot owner, keyed by the activity, with the comment text bounded', () => {
  const event = issueActivityEvent({ id: 'issue-1', identifier: 'MIKKA-3', title: 'Fix login' }, captain, { kind: 'comment', key: 'comment:t1:0', actorId: 'writer', actorName: 'Alex', text: 'x'.repeat(3000) })
  assert.equal(event.payload.actorId, 'writer')
  assert.equal(event.payload.byOwner, false, 'a writer who does not own the Bot is marked as such')
  assert.equal(issueActivityEvent({ id: 'i', identifier: null, title: 't' }, captain, { kind: 'comment', key: 'k', actorId: 'owner', actorName: 'O', text: 'hi' }).payload.byOwner, true)
  assert.equal(event.userId, 'owner')
  assert.equal(event.botId, 'bot-1')
  assert.equal(event.kind, 'issue_activity')
  assert.equal(event.dedupeKey, 'issue_activity:issue-1:bot-1:comment:t1:0')
  assert.equal((event.payload.text as string).length, 2000)
  assert.equal('text' in issueActivityEvent({ id: 'i', identifier: null, title: 't' }, captain, { kind: 'mention', key: 'k', actorId: 'writer', actorName: 'A', text: null }).payload, false)
})
