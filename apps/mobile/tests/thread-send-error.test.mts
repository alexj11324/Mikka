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

test('Group, Thread and Task composers give a new same-text draft its own pending operation', async t => {
  const { Window } = await import('happy-dom')
  const { createRequire } = await import('node:module')
  const { createHash, randomUUID } = await import('node:crypto')
  const browser = new Window({ url: 'https://fixture.example' })
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true })
  const React = await import('react')
  const { act, createElement } = React
  const require = createRequire(import.meta.url)
  const sharedReact = createRequire(new URL('../../../lib/hooks/chat-delivery-state.ts', import.meta.url)).resolve('react')
  if (sharedReact !== require.resolve('react')) {
    t.mock.module(sharedReact, { defaultExport: React.default, namedExports: { useEffect: React.useEffect } })
  }
  const { createRoot } = await import('react-dom/client')
  const values = new Map<string, string>()
  const journal = createConversationJournal({ getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) } })
  journal.bind('owner', 'session')
  t.mock.module('expo', { namedExports: { uuid: { v4: randomUUID } } })
  t.mock.module('expo-crypto', { namedExports: { CryptoDigestAlgorithm: { SHA256: 'sha256' },
    digest: (algorithm: string, data: Uint8Array) => Promise.resolve(createHash(algorithm).update(data).digest()) } })
  t.mock.module(new URL('../lib/config.ts', import.meta.url).href, { namedExports: { conversationJournal: journal } })
  t.mock.module(new URL('../lib/home.tsx', import.meta.url).href, { namedExports: {
    useHome: () => ({ data: { user: { id: 'owner' }, workspace: { id: 'workspace' } } }),
  } })
  t.mock.module(new URL('../components/chat.tsx', import.meta.url).href, { namedExports: { MyBubble: () => null, OutgoingBubble: () => null } })
  const requests: { id: string; accept(): Promise<void>; reject(): void }[] = []
  t.mock.module(new URL('../lib/api.ts', import.meta.url).href, { namedExports: { apiConnection: () => ({}), ApiError: Error,
    api: (path: string, { body }: { body: { requestId?: string; args?: { requestId: string }[] } }) => new Promise((resolve, reject) => {
      const id = body.requestId ?? body.args![0].requestId
      requests.push({ id, reject: () => reject(new Error('response lost')), accept: async () => resolve(
        path.startsWith('/api/conversations/') ? { id: await groupSubmissionMessageId('owner', 'group', id) } :
          { version: 1, ok: true, result: { sent: true, runId: 'run' } }) })
    }),
  } })
  const { useConversationDelivery } = await import('../features/chat/components/conversation-delivery.tsx')
  try {
    for (const target of [{ kind: 'group', id: 'group' }, { kind: 'thread', id: 'solo', issueId: null },
      { kind: 'thread', id: 'run', issueId: 'task' }] as const) {
      await t.test(target.id, async () => {
        requests.length = 0
        let held!: ReturnType<typeof useConversationDelivery>
        const confirmed: string[] = []
        function Probe({ revoked = false }: { revoked?: boolean }) {
          held = useConversationDelivery(revoked ? null : target, confirmed, async () => {}, revoked ? target.id : undefined)
          return null
        }
        const root = createRoot(document.body)
        try {
          await act(async () => { root.render(createElement(Probe)) })
          const send = () => act(async () => { assert.equal(held.send('same draft'), true) })
          await send()
          await send()
          assert.equal(requests.length, 2, 'the composer accepted a second draft while the first ACK was held')
          assert.notEqual(requests[0].id, requests[1].id)
          await act(async () => { await requests[1].accept(); requests[0].reject() })
          await act(async () => { held.bubbles[0].props.onRetry() })
          assert.equal(requests[2].id, requests[0].id, 'bubble retry keeps the failed operation')
          await act(async () => { requests[2].reject() })
          await send()
          assert.equal(requests[3].id, requests[0].id, 'same-text recovery still targets the failed operation')
          await act(async () => { await requests[3].accept() })
          if (target.kind === 'group') {
            const scope = JSON.stringify(['conversation-send', 'owner', 'workspace', 'group', target.id])
            await send()
            assert.equal(journal.read(scope).length, 1)
            await act(async () => root.render(createElement(Probe, { revoked: true })))
            assert.deepEqual(journal.read(scope), [], 'confirmed departure retires queued commands for this group')
            await act(async () => { requests[4].reject() })
            await act(async () => root.render(createElement(Probe)))
            assert.deepEqual(held.bubbles, [], 'a delayed failure must not restore an old send after rejoining')
          }
        } finally {
          await act(async () => { root.unmount() })
        }
      })
    }
  } finally {
    await browser.happyDOM.close()
  }
})
