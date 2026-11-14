import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, useSyncExternalStore } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import type { subscriptionListSchema, parseSubscriptionStart } from '../../lib/subscription-ui'

type State = ReturnType<typeof subscriptionListSchema.parse>
type Attempt = ReturnType<typeof parseSubscriptionStart>
type Payload = { action: string; connectionId?: string; revision?: number; state?: string }
const workspaceId = randomUUID(), connectionId = randomUUID()
let data: State, server: State, attempt: Attempt
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const snapshot = () => data
const emptyUsage = () => undefined
const requests: Array<{ body: Payload; signal: AbortSignal | null | undefined }> = []
let respond: (body: Payload) => Promise<{ body: unknown; status?: number }>
let closedTabs = 0
let holdListSnapshot = false
const publish = () => { data = server; for (const listener of listeners) listener() }
const mutate = async (value?: (current: State) => State) => {
  if (value) data = value(data)
  else if (!holdListSnapshot) {
    server = { ...server, connections: server.connections.map(connection => connection.state === 'pending' && connection.activeAttempt && Date.parse(connection.activeAttempt.expiresAt) <= Date.now()
      ? { ...connection, revision: connection.revision + 1, state: 'reconnect_required', activeAttempt: null, lastErrorCode: 'acquire_expired' }
      : connection) }
    data = server
  }
  for (const listener of listeners) listener()
  return data
}
const translate = (key: string) => key
const mutateCached = async () => undefined
mock.module('next-intl', { namedExports: { useTranslations: () => translate, useFormatter: () => ({ dateTime: () => 'time' }) } })
mock.module('swr', { defaultExport: (key: readonly string[] | null) => ({ data: useSyncExternalStore(subscribe, key?.[0] === 'settings:subscriptions' ? snapshot : emptyUsage), mutate }), namedExports: {
  unstable_serialize: (key: unknown) => JSON.stringify(key), useSWRConfig: () => ({ mutate: mutateCached }),
} })
mock.module(new URL('../../hooks/use-live-key.tsx', import.meta.url).href, { namedExports: { useLiveKey: () => undefined } })
mock.module(new URL('../../app/actions/model-order.ts', import.meta.url).href, { namedExports: { refreshSubscriptionModels: async () => ({ models: 1, view: {} }) } })
mock.module(new URL('./model-order-settings.tsx', import.meta.url).href, { namedExports: { modelOrderKey: (workspace: string) => ['order', workspace] } })

const browser = new Window({ url: 'https://fixture.example/settings?section=models' })
let container: HTMLDivElement, root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let SubscriptionSettings: typeof import('./subscription-settings')['SubscriptionSettings']
before(async () => {
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  for (const key of ['HTMLElement', 'Element', 'Node', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver', 'ResizeObserver'] as const) {
    const value = (browser as unknown as Record<string, unknown>)[key]
    if (value !== undefined) Object.defineProperty(globalThis, key, { configurable: true, value: typeof value === 'function' && /^[a-z]/.test(key) ? (value as (...args: unknown[]) => unknown).bind(browser) : value })
  }
  ;({ createRoot } = await import('react-dom/client'))
  ;({ SubscriptionSettings } = await import('./subscription-settings'))
})
function seed(provider: 'codex' | 'claude', duration = 60_000) {
  const state = 'a'.repeat(43)
  attempt = { connectionId, state, revision: 3, expiresAt: new Date(Date.now() + duration).toISOString(), ...(provider === 'codex'
    ? { flow: 'device' as const, authorizationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGH', interval: 5 }
    : { flow: 'callback_handoff' as const, authorizationUrl: `https://claude.ai/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback&code_challenge_method=S256&state=${state}` }) }
  server = { enabled: true, providers: [{ provider: 'codex', available: true }, { provider: 'claude', available: true }], connections: [{ id: connectionId, provider, state: 'pending', revision: 3, activeAttempt: attempt, lastErrorCode: null }] }
  data = server
}
beforeEach(() => {
  requests.length = 0; closedTabs = 0; holdListSnapshot = false
  seed('codex')
  respond = async body => {
    if (body.action === 'disconnect') { server = { ...server, connections: [] }; return { body: { state: 'disconnected' } } }
    if (body.action === 'poll') return { body: { pending: true } }
    return { body: attempt }
  }
  mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Payload
    requests.push({ body, signal: init?.signal })
    const result = await respond(body)
    return Response.json(result.body, { status: result.status ?? 200 })
  })
  mock.method(browser, 'open', () => ({ opener: null, location: { href: '' }, close: () => { closedTabs++ } }) as unknown as ReturnType<typeof browser.open>)
  container = browser.document.createElement('div') as unknown as HTMLDivElement
  document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); mock.timers.reset(); mock.restoreAll() })
after(() => browser.close())
const render = async () => { await act(async () => root.render(<SubscriptionSettings workspaceId={workspaceId} />)) }
const button = (label: string) => [...container.querySelectorAll('button')].find(item => item.textContent?.trim() === label)
const click = async (label: string) => { const target = button(label); assert.ok(target, label); await act(async () => target.click()) }
const remount = async () => { await act(async () => root.unmount()); root = createRoot(container); data = server; await render() }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

for (const provider of ['codex', 'claude'] as const) test(`${provider}: leaving and returning continues the same server attempt`, async () => {
  seed(provider)
  await render()
  assert.ok(container.textContent?.includes('unfinished'))
  await click('resume')
  assert.deepEqual(requests.map(item => item.body), [{ action: 'resume', connectionId }])
  if (provider === 'codex') assert.ok(container.textContent?.includes('ABCD-EFGH'))
  else assert.deepEqual([...container.querySelectorAll('ol li')].map(item => item.textContent), ['callbackStepOpen', 'callbackStepCopy', 'callbackStepPaste'])
  await remount()
  assert.ok(button('resume'))
  await click('resume')
  assert.deepEqual(requests.map(item => item.body), [{ action: 'resume', connectionId }, { action: 'resume', connectionId }])
  assert.equal(server.connections.length, 1)
})

test('Cancel disconnects the current server revision and removes its resume entry', async () => {
  await render(); await click('resume'); await click('cancel')
  assert.deepEqual(requests.at(-1)?.body, { action: 'disconnect', connectionId, revision: 3 })
  assert.ok(container.textContent?.includes('cancelledNotice'))
  assert.ok(!container.textContent?.includes('ABCD-EFGH'))
  await remount()
  assert.equal(button('resume'), undefined)
  assert.equal(server.connections.length, 0)
})

test('an unconfirmed Cancel keeps recovery available without claiming cancellation', async () => {
  await render(); await click('resume')
  respond = async () => ({ body: { error: 'subscription_unavailable' }, status: 503 })
  await click('cancel')
  assert.equal(container.querySelector('[role="alert"]')?.textContent, 'cancelFailedretry')
  assert.ok(!container.textContent?.includes('cancelledNotice'))
  assert.ok(button('resume'))
})

test('a presentation still being published retries resume without creating a second connection', async () => {
  server = { ...server, connections: [{ ...server.connections[0], activeAttempt: null }] }; data = server
  respond = async () => ({ body: { error: 'credential_busy' }, status: 409 })
  await render(); await click('resume'); await click('retry')
  assert.deepEqual(requests.map(item => item.body), [{ action: 'resume', connectionId }, { action: 'resume', connectionId }])
  assert.ok(container.textContent?.includes('signInPreparing'))
  assert.ok(button('resume'))
})

test('a lost start response retries the pending connection discovered by the next list read', async () => {
  const started = server
  server = { ...server, connections: [] }; data = server
  respond = async body => {
    if (body.action === 'connect') { server = started; throw new Error('Response lost after start') }
    return { body: attempt }
  }
  await render(); await click('connect'); await click('retry')
  assert.deepEqual(requests.map(item => item.body), [{ action: 'connect', workspaceId, provider: 'codex' }, { action: 'resume', connectionId }])
  assert.ok(container.textContent?.includes('ABCD-EFGH'))
})

for (const provider of ['codex', 'claude'] as const) test(`${provider}: the deadline ends the ceremony and offers reconnect`, async () => {
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
  seed(provider, 10_000)
  await render(); await click('resume')
  await act(async () => { mock.timers.tick(10_000) })
  assert.ok(container.textContent?.includes('signInExpired'))
  assert.ok(button('reconnect'))
  assert.equal(container.querySelector('form'), null)
  assert.ok(!container.textContent?.includes('ABCD-EFGH'))
  assert.equal(server.connections[0].lastErrorCode, 'acquire_expired')
})

test('leaving during start aborts the client; its late server result is resumable on return', async () => {
  const pending = deferred<{ body: unknown }>()
  const started = server
  server = { ...server, connections: [] }; data = server
  respond = async body => body.action === 'connect' ? pending.promise : { body: attempt }
  await render(); await click('connect')
  assert.equal(requests.length, 1)
  await act(async () => root.unmount())
  assert.equal(requests[0].signal?.aborted, true)
  server = started
  await act(async () => pending.resolve({ body: attempt }))
  assert.equal(closedTabs, 1)
  root = createRoot(container); data = server; await render(); await click('resume')
  assert.deepEqual(requests.map(item => item.body.action), ['connect', 'resume'])
  assert.equal(server.connections.length, 1)
})

test('leaving during an in-flight poll cannot display a stale error or cancel the server attempt', async () => {
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
  seed('codex')
  const pending = deferred<{ body: unknown }>()
  respond = async body => body.action === 'poll' ? pending.promise : { body: attempt }
  await render(); await click('resume')
  await act(async () => { mock.timers.tick(6_000) })
  const poll = requests.find(item => item.body.action === 'poll')
  assert.ok(poll)
  await act(async () => root.unmount())
  assert.equal(poll.signal?.aborted, true)
  await act(async () => pending.resolve({ body: { pending: true } }))
  root = createRoot(container); data = server; await render(); await click('resume')
  assert.equal(container.querySelector('[role="alert"]'), null)
  assert.deepEqual(requests.map(item => item.body.action), ['resume', 'poll', 'resume'])
  assert.equal(server.connections[0].activeAttempt?.state, attempt.state)
})

test('a live completion in another page closes the obsolete ceremony', async () => {
  seed('claude')
  await render(); await click('resume')
  server = { ...server, connections: [{ ...server.connections[0], state: 'connected', revision: 4, activeAttempt: null }] }
  await act(async () => publish())
  assert.equal(container.querySelector('form'), null)
  assert.equal(container.querySelector('[role="alert"]'), null)
})

test('a live cancellation in another page closes an observed Claude ceremony', async () => {
  seed('claude')
  await render(); await click('resume')
  assert.ok(container.querySelector('form'))
  server = { ...server, connections: [] }
  await act(async () => publish())
  assert.equal(container.querySelector('form'), null)
  assert.ok(!container.textContent?.includes('connecting'))
  assert.deepEqual(requests.map(item => item.body.action), ['resume'])
})

test('a fresh start survives the old empty list until its current revision has been observed', async () => {
  const started = server
  server = { ...server, connections: [] }; data = server
  holdListSnapshot = true
  respond = async () => { server = started; return { body: attempt } }
  await render(); await click('connect')
  assert.ok(container.textContent?.includes('ABCD-EFGH'), 'the old empty list cannot cancel the new attempt')
  await act(async () => publish())
  server = { ...server, connections: [] }
  await act(async () => publish())
  assert.ok(!container.textContent?.includes('ABCD-EFGH'), 'a later disappearance closes the observed attempt')
})

test('a stale poll followed by a connected list clears its obsolete error and retry', async () => {
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
  seed('codex')
  respond = async body => {
    if (body.action === 'poll') {
      server = { ...server, connections: [{ ...server.connections[0], state: 'connected', activeAttempt: null }] }
      return { body: { error: 'stale_operation' }, status: 409 }
    }
    return { body: attempt }
  }
  await render(); await click('resume')
  await act(async () => { mock.timers.tick(6_000) })
  assert.equal(container.querySelector('[role="alert"]'), null)
  assert.equal(button('retry'), undefined)
  assert.equal(button('reconnect'), undefined)
  assert.deepEqual(requests.map(item => item.body.action), ['resume', 'poll'])
})

test('a connected list clears the deadline error even after the local attempt has ended', async () => {
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
  seed('claude', 10_000)
  await render(); await click('resume')
  server = { ...server, connections: [{ ...server.connections[0], state: 'connected', activeAttempt: null }] }
  await act(async () => { mock.timers.tick(10_000) })
  assert.equal(container.querySelector('[role="alert"]'), null)
  assert.equal(button('retry'), undefined)
  assert.equal(button('reconnect'), undefined)
})

test('a late resume refusal cannot put retry back beside an already connected row', async () => {
  const pending = deferred<{ body: unknown; status: number }>()
  respond = async () => pending.promise
  await render(); await click('resume')
  server = { ...server, connections: [{ ...server.connections[0], state: 'connected', activeAttempt: null }] }
  await act(async () => publish())
  await act(async () => pending.resolve({ body: { error: 'stale_operation' }, status: 409 }))
  assert.equal(container.querySelector('[role="alert"]'), null)
  assert.equal(button('retry'), undefined)
  assert.equal(button('reconnect'), undefined)
})

test('copying a device sign-in code reports denial and allows a confirmed retry', async () => {
  await render()
  await click('resume')
  const copyButton = () => container.querySelector<HTMLButtonElement>('button[aria-label="copy"]')
  const original = Object.getOwnPropertyDescriptor(browser.navigator, 'clipboard')
  const written: string[] = []
  let denied = true
  Object.defineProperty(browser.navigator, 'clipboard', { configurable: true, value: {
    async writeText(value: string) {
      if (denied) throw new Error('Clipboard denied')
      written.push(value)
    },
  } })
  try {
    const trigger = copyButton()
    assert.ok(trigger)
    await act(async () => trigger.click())
    assert.equal(container.querySelector('[role="alert"]')?.textContent, 'copyFailed')
    assert.equal(container.querySelector('button[aria-label="copied"]'), null)
    denied = false
    await act(async () => trigger.click())
    assert.deepEqual(written, ['ABCD-EFGH'])
    assert.ok(container.querySelector('button[aria-label="copied"]'))
    assert.equal(container.querySelector('[role="alert"]'), null)
  } finally {
    if (original) Object.defineProperty(browser.navigator, 'clipboard', original)
    else Reflect.deleteProperty(browser.navigator, 'clipboard')
  }
})
