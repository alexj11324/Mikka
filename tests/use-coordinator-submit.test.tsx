import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import { act } from 'react'
import { Window } from 'happy-dom'
import { ClientError } from 'eve/client'
import type { UseEveAgentReturn } from 'eve/react'

let owner = 'owner-a'
let sessionReads = 0
mock.module('next-intl', { namedExports: { useTranslations: () => (key: string) => key } })
mock.module(new URL('../lib/auth-client.ts', import.meta.url).href, { namedExports: { authClient: {
  getSession: async () => { sessionReads++; return { data: { user: { id: owner } }, error: null } },
} } })
const receiptKeys: string[] = []
let returnReceipt = true
mock.module(new URL('../app/actions/issues.ts', import.meta.url).href, { namedExports: { getDispatchedTaskReceipt: async ({ requestId }: { requestId: string }) => {
  receiptKeys.push(requestId)
  if (!returnReceipt) throw Error('receipt response lost')
  return { version: 1, taskId: 'task', identifier: 'MIK-5', dispatch: { sourceEventId: 'event', botId: 'bot' } }
} } })
const browser = new Window()
let createRoot: typeof import('react-dom/client')['createRoot']
let useCoordinatorSubmit: typeof import('../components/coordinator/use-coordinator-submit')['useCoordinatorSubmit']
before(async () => {
  for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ useCoordinatorSubmit } = await import('../components/coordinator/use-coordinator-submit'))
})

test('uncertain native sends retain their logical identity across other sends and account changes', async () => {
  const sent: { text: string; id: string }[] = []
  let fail = false, conflict = false
  const agent = { send: async (text: string, options: { headers: Record<string, string> }) => {
    sent.push({ text, id: options.headers['x-mikka-submission-id'] })
    if (conflict) throw new ClientError(409, '{"code":"submissionConflict"}')
    if (fail) throw new TypeError('network unavailable')
  } } as unknown as Pick<UseEveAgentReturn, 'send'>
  const container = browser.document.createElement('div') as unknown as HTMLDivElement, root = createRoot(container)
  let composer!: ReturnType<typeof useCoordinatorSubmit>
  function Probe() { composer = useCoordinatorSubmit(agent); return null }
  try {
    await act(async () => { root.render(<Probe />) })
    fail = true
    assert.equal((await composer.submit('Original')).kind, 'uncertain')
    const original = sent.at(-1)!.id
    fail = false
    assert.equal((await composer.submit('Another')).kind, 'accepted')
    assert.equal((await composer.submit('Original')).kind, 'accepted')
    assert.equal(sent.at(-1)!.id, original, 'a later message cannot replace an unresolved delivery identity')
    assert.equal((await composer.submit('Original')).kind, 'accepted')
    assert.notEqual(sent.at(-1)!.id, original, 'the same text after acceptance is a new operation')
    fail = true
    await composer.submit('Account retry')
    const firstAccount = sent.at(-1)!.id
    owner = 'owner-b'; fail = false
    await composer.submit('Account retry')
    assert.notEqual(sent.at(-1)!.id, firstAccount)
    owner = 'owner-a'
    await composer.submit('Account retry')
    assert.equal(sent.at(-1)!.id, firstAccount)
    conflict = true
    assert.equal((await composer.submit('Conflicting')).kind, 'conflict')
    const requests = sent.length
    assert.equal((await composer.submit('Conflicting')).kind, 'conflict')
    assert.equal(sent.length, requests, 'a terminal conflict cannot mint another key and send again')
  } finally { await act(async () => { root.unmount() }) }
})

test('a lost Task receipt retries only the authorized read of the accepted delivery', async () => {
  let sends = 0
  const agent = { send: async () => { sends++ } } as unknown as Pick<UseEveAgentReturn, 'send'>
  const root = createRoot(browser.document.createElement('div') as unknown as HTMLDivElement)
  let hook!: ReturnType<typeof useCoordinatorSubmit>
  function Probe() { hook = useCoordinatorSubmit(agent); return null }
  const context = { expectedWorkspaceId: 'workspace', taskCommand: { version: 1, intent: 'create_and_dispatch', description: 'Do work' } } as const
  try {
    await act(async () => { root.render(<Probe />) })
    returnReceipt = false
    assert.equal((await hook.submit('Do work', context)).kind, 'uncertain')
    returnReceipt = true
    const outcome = await hook.submit('Do work', context)
    assert.equal(sends, 1)
    assert.equal(receiptKeys.length, 2)
    assert.equal(receiptKeys[0], receiptKeys[1])
    assert.ok(outcome.kind === 'accepted')
    assert.equal(outcome.task?.taskId, 'task')
    assert.equal(outcome.task?.identifier, 'MIK-5')
    assert.equal(outcome.sourceEventId, 'event')
  } finally { returnReceipt = true; await act(async () => { root.unmount() }) }
})


test('confirming a hosted Project scope retries the same submission ID', async () => {
  const sent: { id: string; approved: boolean }[] = []
  const agent = { send: async (_text: string, options: { headers: Record<string, string>; clientContext: { confirmTaskAccess?: boolean } }) => {
    const approved = options.clientContext.confirmTaskAccess === true
    sent.push({ id: options.headers['x-mikka-submission-id'], approved })
    if (!approved) throw new ClientError(409, '{"code":"accessChangeConfirmationRequired"}')
  } } as unknown as Pick<UseEveAgentReturn, 'send'>
  const container = browser.document.createElement('div') as unknown as HTMLDivElement, root = createRoot(container)
  let hook!: ReturnType<typeof useCoordinatorSubmit>
  function Probe() { hook = useCoordinatorSubmit(agent); return null }
  const context = { expectedWorkspaceId: 'workspace', taskCommand: { version: 1, intent: 'create_and_dispatch', description: 'Do work', projectId: 'project' } } as const
  try {
    await act(async () => { root.render(<Probe />) })
    assert.deepEqual(await hook.submit('Do work', context), { kind: 'rejected', error: 'accessChangeConfirmationRequired' })
    assert.equal((await hook.submit('Do work', { ...context, confirmTaskAccess: true })).kind, 'accepted')
    assert.deepEqual(sent, [{ id: sent[0].id, approved: false }, { id: sent[0].id, approved: true }])
  } finally { await act(async () => root.unmount()) }
})

test('an ordinary chat sends its captured owner to Eve without fetching a second account snapshot', async () => {
  const scopes: string[] = []
  const agent = { send: async (_text: string, options: { clientContext: { expectedOwnerId: string } }) => {
    scopes.push(options.clientContext.expectedOwnerId)
    if (options.clientContext.expectedOwnerId && options.clientContext.expectedOwnerId !== owner) {
      throw new ClientError(500, 'onMessage handler failed')
    }
  } } as unknown as Pick<UseEveAgentReturn, 'send'>
  const root = createRoot(browser.document.createElement('div') as unknown as HTMLDivElement)
  let hook!: ReturnType<typeof useCoordinatorSubmit>
  function Probe() { hook = useCoordinatorSubmit(agent); return null }
  try {
    await act(async () => root.render(<Probe />))
    const before = sessionReads
    assert.equal((await hook.submit('Message', { expectedOwnerId: owner })).kind, 'accepted')
    assert.deepEqual(scopes, [owner])
    assert.equal(sessionReads, before)
    assert.equal((await hook.submit('Another message')).kind, 'accepted')
    assert.equal(sessionReads, before + 1)
    assert.deepEqual(await hook.submit('Changed account', { expectedOwnerId: 'signed-out-owner' }), { kind: 'authRequired' })
    assert.equal(sessionReads, before + 2)
  } finally { await act(async () => root.unmount()) }
})
