// A refused message to a thread says why, as the web does (same-page flows A3).
import assert from 'node:assert/strict'
import test from 'node:test'
import { threadSendErrorLine } from '../lib/thread-send-error.ts'

test('a refusal the person can act on is named', () => {
  assert.equal(threadSendErrorLine('threadReplaced'), '这个任务已经换到新的线程，请在那里发送。')
  assert.equal(threadSendErrorLine('threadCannotContinue'), '这个线程没有关联任务，无法再次运行。')
})

test('no code, or one the app does not know, keeps the retry line', () => {
  assert.equal(threadSendErrorLine(null), '没发出去，再试一次。')
  assert.equal(threadSendErrorLine('somethingNew'), '没发出去，再试一次。')
})

import { createConversationJournal } from '../lib/conversation-journal'
import { sameConversationCommand, submitConversation, type ConversationCommand } from '../lib/conversation-submission'
import { groupSubmissionMessageId } from '../../../lib/group-submission'

const actor = { expectedOwnerId: 'reader', expectedWorkspaceId: 'workspace' }
for (const target of [{ kind: 'group', id: 'group' }, { kind: 'thread', id: 'solo', issueId: null },
  { kind: 'thread', id: 'original-run', issueId: 'task' }] as const) {
  test(`${target.id} retries the original anchored operation after a missing receipt`, async () => {
    const command: ConversationCommand = { id: 'submission', at: 1, text: 'quoted body', target, mentions: [], ...actor }
    const storedId = target.kind === 'group' ? await groupSubmissionMessageId(actor.expectedOwnerId, target.id, command.id) : command.id
    const attempts: unknown[] = []
    let received = false
    const post = async (path: string, init: { method: 'POST'; body: unknown }) => {
      attempts.push({ path, ...init })
      if (!received) { received = true; throw new Error('lost response') }
      return target.kind === 'group' ? { id: storedId } : { version: 1, ok: true, result: { sent: true, runId: target.id } }
    }
    await assert.rejects(submitConversation(command, post, storedId), /lost response/)
    await submitConversation(command, post, storedId)
    assert.deepEqual(attempts[0], attempts[1])
    const expected = target.kind === 'group' ? { path: '/api/conversations/group/messages', method: 'POST',
      body: { body: command.text, mentions: [], requestId: command.id, ...actor } } : { path: '/api/rpc', method: 'POST',
      body: { version: 1, action: 'agents.sendIssueThreadReply', args: [{ issueId: target.issueId, runId: target.id, text: command.text, requestId: command.id, ...actor }] } }
    assert.deepEqual(attempts[0], expected)
    await assert.rejects(submitConversation(command, async () => ({ id: 'different' }), storedId), /submissionUnconfirmed/)
  })
}

test('the pending original survives a fresh app instance only for its own session and scope', () => {
  const values = new Map<string, string>()
  const disk = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
  const command = { target: { kind: 'thread' as const, id: 'old', issueId: 'task' }, id: 'one', text: 'next', at: 1, mentions: [], ...actor, storedId: 'one' }
  const origin = createConversationJournal(disk)
  origin.bind('account', 'session')
  origin.remember('ws1/task', command)
  const reopened = createConversationJournal(disk)
  reopened.bind('account', 'session')
  assert.deepEqual(reopened.read('ws1/task'), [command])
  assert.deepEqual(reopened.read('ws2/task'), [])
  assert.equal(sameConversationCommand(command, { ...command.target, id: 'new' }, command.text, []), false)
  assert.equal(sameConversationCommand(command, command.target, command.text, []), true)
  reopened.bind('other', 'session')
  assert.deepEqual(reopened.read('ws1/task'), [])
  reopened.bind('account', 'different-session')
  assert.deepEqual(reopened.read('ws1/task'), [])
  reopened.remember('ws1/task', command)
  reopened.bind('account', null)
  assert.ok(![...values.values()].some(value => value.includes('"text":"next"')))
})

test('an unsaved command does not claim durable recovery', () => {
  const inaccessible = createConversationJournal({ getItem: () => null, setItem() {} })
  inaccessible.bind('account', 'session')
  assert.throws(() => inaccessible.remember('ws/task', { target: { kind: 'group', id: 'one' }, id: 'one',
    at: 1, text: 'keep', mentions: [], ...actor, storedId: 'row' }), /draftNotSaved/)
})
