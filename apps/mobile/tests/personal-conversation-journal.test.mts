import assert from 'node:assert/strict'
import test from 'node:test'
import { createConversationJournal } from '../lib/conversation-journal.ts'

function storage() {
  const entries = new Map<string, string>()
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value) },
  }
}

const owner = 'person'
const workspace = 'personal:workspace-a:coordinator'
const other = 'personal:workspace-b:coordinator'
const indexKey = 'mikka_conversation_index_person'
const valueKey = (id: string) => 'mikka_conversation_send_person_' + id
function outgoing(submissionId: string) {
  return {
    key: 'local-' + submissionId, id: submissionId, submissionId, at: 56,
    botId: null, chatKey: 'coordinator', context: 4, text: '同一个问题',
    images: [{ uri: 'file:///draft.jpg', dataUrl: 'data:image/jpeg;base64,QUJD' }],
    phase: 'failed' as const, error: 'submissionUnconfirmed',
  }
}

test('released Group and Thread records remain readable alongside personal sends', () => {
  const store = storage()
  const target = { id: 'group-1', kind: 'group' as const }
  const group = { id: 'g-op', at: 34, text: 'hi', target, expectedOwnerId: owner,
    expectedWorkspaceId: 'workspace-a', mentions: [], storedId: 'g-message' }
  const thread = { ...group, id: 't-op', storedId: 't-message', target: { kind: 'thread' as const, id: 'run', issueId: 'task' } }
  store.setItem(indexKey, JSON.stringify({ session: 'one', scopes: { 'g-op': workspace, 't-op': workspace } }))
  store.setItem(valueKey(group.id), JSON.stringify(group))
  store.setItem(valueKey(thread.id), JSON.stringify(thread))
  const journal = createConversationJournal(store)
  journal.bind(owner, 'one')
  journal.rememberPersonal(workspace, outgoing('p-op'))
  assert.deepEqual(journal.read(workspace), [group, thread])
  assert.deepEqual(journal.readPersonal(workspace), [outgoing('p-op')])
  journal.forget(workspace, ['p-op'])
  assert.deepEqual(journal.readPersonal(workspace), [])
  assert.deepEqual(journal.read(workspace), [group, thread])
})

test('identical personal texts retain separate submission identities across restarts and workspaces', () => {
  const store = storage()
  const journal = createConversationJournal(store)
  journal.bind(owner, 'one')
  journal.rememberPersonal(workspace, outgoing('first'))
  journal.rememberPersonal(workspace, outgoing('second'))
  journal.rememberPersonal(other, outgoing('third'))
  const resumed = createConversationJournal(store)
  resumed.bind(owner, 'one')
  assert.deepEqual(resumed.readPersonal(workspace), [outgoing('first'), outgoing('second')])
  assert.deepEqual(resumed.readPersonal(other), [outgoing('third')])
  assert.throws(() => resumed.rememberPersonal(other, outgoing('first')), /draftNotSaved/)
  assert.deepEqual(resumed.readPersonal(other), [outgoing('third')])
  resumed.forget(workspace, ['first'])
  assert.deepEqual(resumed.readPersonal(workspace), [outgoing('second')])
  resumed.forget(workspace)
  assert.deepEqual(resumed.readPersonal(other), [outgoing('third')])
})

test('a different account, rotated session and logout cannot recover another binding’s sends', () => {
  const store = storage()
  const old = createConversationJournal(store)
  old.bind(owner, 'one')
  old.rememberPersonal(workspace, outgoing('before'))
  const current = createConversationJournal(store)
  current.bind('different', 'two')
  assert.deepEqual(current.readPersonal(workspace), [])
  current.bind(owner, 'rotated')
  assert.deepEqual(current.readPersonal(workspace), [])
  assert.equal(store.getItem(valueKey('before')), '')
  current.rememberPersonal(workspace, outgoing('after'))
  assert.deepEqual(old.readPersonal(workspace), [])
  assert.throws(() => old.rememberPersonal(workspace, outgoing('late')), /draftNotSaved/)
  assert.deepEqual(current.readPersonal(workspace), [outgoing('after')])
  current.bind(owner, null)
  assert.deepEqual(current.readPersonal(workspace), [])
  assert.equal(store.getItem(valueKey('after')), '')
})

test('a discarded payload or index write never reports a durable personal send', () => {
  for (const blocked of [valueKey('first'), indexKey]) {
    const base = storage()
    const journal = createConversationJournal({
      getItem: base.getItem,
      setItem(key, value) { if (key !== blocked) base.setItem(key, value) },
    })
    journal.bind(owner, 'one')
    assert.throws(() => journal.rememberPersonal(workspace, outgoing('first')), /draftNotSaved/)
    const reloaded = createConversationJournal(base)
    reloaded.bind(owner, 'one')
    assert.deepEqual(reloaded.readPersonal(workspace), [])
    if (blocked === indexKey) assert.equal(base.getItem(valueKey('first')), null)
    reloaded.rememberPersonal(workspace, outgoing('first'))
    assert.deepEqual(reloaded.readPersonal(workspace), [outgoing('first')])
  }
})
