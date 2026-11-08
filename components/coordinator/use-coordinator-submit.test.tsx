import assert from 'node:assert/strict'
import { after, before, mock, test } from 'node:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import type { SubmitOutcome } from '../../lib/coordinator-client-submission'
import type { CoordinatorMessageContext } from './use-coordinator-submit'

// The composer transport against the backend's sendCoordinatorMessage shape
// (#1636): the captured workspace is its 10th argument, omitted when absent.
const calls: unknown[][] = []
let answers: Array<() => unknown> = []
mock.module(new URL('../../app/actions/coordinator.ts', import.meta.url).href, { namedExports: {
  sendCoordinatorMessage: async (...args: unknown[]) => { calls.push(structuredClone(args)); const answer = answers.shift(); return answer ? answer() : { queued: true } },
} })
mock.module(new URL('../../lib/auth-client.ts', import.meta.url).href, { namedExports: { authClient: { getSession: async () => ({ data: { user: { id: 'owner' } }, error: null }) } } })
mock.module('next-intl', { namedExports: { useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}` } })

const alpha = '16610000-0000-4000-8000-00000000000a', beta = '16610000-0000-4000-8000-00000000000b'
const browser = new Window({ url: 'https://fixture.example/mikka' })
let root: Root
let submit: (text: string, context?: CoordinatorMessageContext) => Promise<SubmitOutcome>
before(async () => {
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true })
  const { createRoot } = await import('react-dom/client')
  const { useCoordinatorSubmit } = await import('./use-coordinator-submit')
  function Probe() { submit = useCoordinatorSubmit().submit; return null }
  root = createRoot(browser.document.createElement('div') as unknown as HTMLDivElement)
  await act(async () => root.render(<Probe />))
})
after(async () => { await act(async () => root.unmount()); await browser.happyDOM.close() })

test('expectedWorkspaceId goes explicitly as the 10th argument; without it the call keeps 9 arguments', async () => {
  calls.length = 0
  assert.equal((await submit('legacy message', { botId: null })).kind, 'accepted')
  assert.equal(calls[0].length, 9)
  assert.equal((await submit('captured task', { botId: null, profileId: 'default', expectedWorkspaceId: alpha })).kind, 'accepted')
  assert.equal(calls[1].length, 10)
  assert.equal(calls[1][9], alpha)
  assert.equal(calls[1][8], 'default')
})

test('a retry after an uncertain send reuses the same submission id and captured id, even if the caller object changes', async () => {
  calls.length = 0
  answers = [() => { throw new Error('fixture lost response') }]
  const context: CoordinatorMessageContext = { botId: null, expectedWorkspaceId: alpha }
  assert.equal((await submit('retried task', context)).kind, 'uncertain')
  context.expectedWorkspaceId = beta
  assert.equal((await submit('retried task', { botId: null, expectedWorkspaceId: alpha })).kind, 'accepted')
  assert.equal(calls.length, 2)
  assert.equal(calls[1][3], calls[0][3], 'one submission id across the retry')
  assert.deepEqual(calls.map(args => args[9]), [alpha, alpha])
})

test('a refusal is surfaced, never retried without the expected id', async () => {
  calls.length = 0
  answers = [() => ({ error: 'workspaceAccessDenied' })]
  assert.deepEqual(await submit('refused task', { botId: null, expectedWorkspaceId: alpha }), { kind: 'rejected', error: 'workspaceAccessDenied' })
  answers = [() => ({ error: 'validationGeneric' })]
  assert.deepEqual(await submit('unsupported task', { botId: null, expectedWorkspaceId: beta }), { kind: 'rejected', error: 'validationGeneric' })
  assert.equal(calls.length, 2)
  assert.deepEqual(calls.map(args => [args.length, args[9]]), [[10, alpha], [10, beta]])
})
