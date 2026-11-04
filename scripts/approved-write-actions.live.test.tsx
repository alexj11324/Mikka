import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import type { ApprovedWriteItem } from '../lib/operations/write-client'
import { LIVE_KINDS } from '../lib/live/events'

const home = '10000000-0000-4000-8000-000000000001'
const proposalId = '20000000-0000-4000-8000-000000000001'
const translate = Object.assign((key: string) => key, { has: () => false })
let flag: boolean | undefined
const flagListeners = new Set<() => void>()
mock.module('posthog-js', { defaultExport: { getFeatureFlag: () => flag, onFeatureFlags: (notify: () => void) => { flagListeners.add(notify); return () => { flagListeners.delete(notify) } } } })
mock.module('next-intl', { namedExports: { useTranslations: () => translate } })
mock.module(new URL('../lib/auth-client.ts', import.meta.url).href, { namedExports: { authClient: { useSession: () => ({ data: { user: { id: 'owner' }, session: { id: 'owner-session' } }, isPending: false }) } } })
mock.module(new URL('../components/ui/button.tsx', import.meta.url).href, { namedExports: { Button: ({ children, disabled, onClick }: { children?: ReactNode; disabled?: boolean; onClick?: () => void }) => <button disabled={disabled} onClick={onClick}>{children}</button> } })
mock.module('sonner', { namedExports: { toast: { error() {}, success() {} } } })

const browser = new Window({ url: 'https://mikka.example/mikka/en' })
const originalFetch = globalThis.fetch, originalSocket = globalThis.WebSocket
let root: Root, container: HTMLDivElement
let createRoot: typeof import('react-dom/client')['createRoot']
let SWRConfig: typeof import('swr')['SWRConfig']
let ApprovedWriteActions: typeof import('../components/coordinator/approved-write-actions')['ApprovedWriteActions']
let LiveProvider: typeof import('../hooks/use-live-key')['LiveProvider']
let items: ApprovedWriteItem[], records: Map<string, ApprovedWriteItem>, calls: { op: string; cursor?: string; id?: string }[]
let ticketReads = 0
let availability: number, paginated: boolean, loseDecision: boolean, serverNow: string | null
const sockets: FakeSocket[] = []

class FakeSocket {
  readyState = 0
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  constructor() { sockets.push(this); queueMicrotask(() => { this.readyState = 1; this.onopen?.(); this.message({ type: 'live_ready', version: 1, kinds: LIVE_KINDS }) }) }
  send(data: string) { if (data === 'ping') this.onmessage?.({ data: 'pong' }) }
  close() { this.readyState = 3; this.onclose?.() }
  message(value: unknown) { if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(value) }) }
}

function proposal(id = proposalId): Exclude<ApprovedWriteItem, { status: 'attention' }> {
  return { id, action: 'send_slack_message', input: { channel: 'C12345678', text: 'Frozen message' }, approvalContext: { name: 'fixture-channel' }, account: { provider: 'fixture', accountId: 'fixture-account', version: 'fixed' }, createdAt: '2026-11-04T20:00:00Z', approvalExpiresAt: '2099-11-04T20:00:00Z', status: 'pending', error: null }
}

before(async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.document })
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, WebSocket: FakeSocket })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ SWRConfig } = await import('swr'))
  ;({ ApprovedWriteActions } = await import('../components/coordinator/approved-write-actions'))
  ;({ LiveProvider } = await import('../hooks/use-live-key'))
})
beforeEach(() => {
  items = []; records = new Map(); calls = []; availability = 0; paginated = false; loseDecision = false; serverNow = null; sockets.length = 0; flag = undefined; ticketReads = 0
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  globalThis.fetch = async (url, options) => {
    const path = String(url)
    if (path.endsWith('/api/workspace/switcher')) return Response.json({ accounts: [{ id: 'owner', choices: [{ id: home, kind: 'personal' }] }] })
    if (path.includes('/api/live/ticket?workspace=')) {
      ticketReads++
      assert.equal(new URL(path, 'https://mikka.example').searchParams.get('workspace'), home)
      return Response.json({ url: 'wss://fixture.invalid/socket', protocol: 'fixture', expiresAt: Date.now() + 600_000 })
    }
    assert.ok(path.endsWith('/api/approved-writes'))
    if (options?.method === 'GET') { availability++; return Response.json({ enabled: true }) }
    const body = JSON.parse(String(options?.body)); calls.push(body)
    const observedAt = serverNow ?? new Date().toISOString()
    if (body.op === 'list') return Response.json({ viewerId: 'owner', items: paginated && !body.cursor ? [] : items, nextCursor: paginated && !body.cursor ? 'older-page' : null, asOf: observedAt, observedAt })
    if (body.op === 'view') return Response.json({ ...(records.get(body.id) ?? items.find(item => item.id === body.id)), observedAt })
    assert.equal(body.op, 'decide')
    if (loseDecision) throw Error('isolated decision response lost')
    items = items.filter(item => item.id !== body.id)
    return Response.json({ status: body.approve ? 'done' : 'declined', error: null })
  }
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); globalThis.fetch = originalFetch })
after(() => { Object.assign(globalThis, { WebSocket: originalSocket }); browser.close() })
const wait = async (milliseconds = 160) => { await act(async () => { await new Promise(resolve => setTimeout(resolve, milliseconds)) }) }
async function render() {
  await act(async () => root.render(<SWRConfig value={{ provider: () => new Map(), revalidateOnFocus: false, dedupingInterval: 0 }}><LiveProvider ownerId="owner" workspaceId={home}><ul><ApprovedWriteActions /></ul></LiveProvider></SWRConfig>))
  await wait()
  assert.equal(sockets.filter(socket => socket.readyState === 1).length, 1)
}
const emit = (kind: string, id: string) => { for (const socket of sockets) socket.message({ kind, id }) }
async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find(node => node.textContent === label)
  assert.ok(button)
  await act(async () => button.click()); await wait()
}

test('a healthy mounted approval UI makes no ten-second availability, list or result poll', { timeout: 20_000 }, async () => {
  const running = proposal(); running.status = 'running'
  items = [running]
  await render(); await wait()
  const before = { availability, requests: calls.length }
  await wait(10_500)
  assert.deepEqual({ availability, requests: calls.length }, before)
  assert.equal(calls.filter(call => call.op === 'decide').length, 0)
})

test('the real infinite cache invalidates all loaded pages, and proposal events refresh capability hints', async () => {
  items = [proposal()]; paginated = true
  await render(); await click('more')
  assert.ok(container.textContent?.includes('Frozen message'))
  const before = calls.length, beforeAvailability = availability
  const changed = proposal(); changed.input.text = 'Changed committed proposal'
  items = [changed]
  await act(async () => emit('approved_writes', home)); await wait()
  assert.ok(container.textContent?.includes('Changed committed proposal'))
  assert.ok(calls.slice(before).some(call => call.op === 'list' && !call.cursor))
  assert.ok(calls.slice(before).some(call => call.op === 'list' && call.cursor === 'older-page'))
  assert.equal(availability, beforeAvailability + 1)
  assert.equal(calls.filter(call => call.op === 'decide').length, 0)
})

test('only a changed PostHog hint invalidates server capability; repeated callbacks make no reads', async () => {
  await render()
  const before = availability
  await act(async () => { for (const notify of flagListeners) notify() }); await wait()
  assert.equal(availability, before)
  await act(async () => { flag = true; for (const notify of flagListeners) notify() }); await wait()
  assert.equal(availability, before + 1)
  await act(async () => { for (const notify of flagListeners) notify() }); await wait()
  assert.equal(availability, before + 1)
  assert.equal(calls.filter(call => call.op === 'decide').length, 0)
})

test('an exact result push reconciles an uncertain card without resending its decision', async () => {
  const original = proposal(); items = [original]; loseDecision = true
  const running = { ...original, status: 'running' as const, error: 'operationUncertain' as const }
  records.set(proposalId, running)
  await render(); await click('approveSend')
  assert.ok(container.textContent?.includes('resultUnconfirmed'))
  const before = calls.length
  records.set(proposalId, { ...running, status: 'done', error: null }); items = []
  await act(async () => emit('approved_write', proposalId)); await wait(); await wait()
  assert.ok(calls.slice(before).some(call => call.op === 'view' && call.id === proposalId))
  assert.ok(!container.textContent?.includes('Frozen message'))
  assert.equal(calls.filter(call => call.op === 'decide').length, 1)
})

test('a server-derived expiry performs one authoritative read and disables approval even when the client clock is behind', async () => {
  const expiring = proposal()
  expiring.approvalExpiresAt = '2099-01-01T00:00:01.000Z'
  serverNow = '2099-01-01T00:00:00.000Z'; items = [expiring]
  await render()
  const approve = () => [...container.querySelectorAll('button')].find(node => node.textContent === 'approveSend')
  assert.equal(approve()?.disabled, false)
  const before = calls.length, socketCount = sockets.length, tickets = ticketReads
  serverNow = '2099-01-01T00:00:01.001Z'
  await wait(1_150)
  assert.equal(approve()?.disabled, true)
  assert.equal(calls.slice(before).filter(call => call.op === 'list').length, 1)
  assert.equal(sockets.length, socketCount); assert.equal(ticketReads, tickets)
  const settled = calls.length; await wait(300)
  assert.equal(calls.length, settled, 'expiry does not become a recurring read')
  assert.equal(calls.filter(call => call.op === 'decide').length, 0)
})
