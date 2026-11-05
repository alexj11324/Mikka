import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import type { PendingActionView } from '../lib/pending-action-view'
import { LIVE_KINDS } from '../lib/live/events'

const home = '10000000-0000-4000-8000-000000000001'
const proposalId = '20000000-0000-4000-8000-000000000001'
const translate = Object.assign((key: string) => key, { has: () => false })
let decisions = 0, ticketReads = 0
let pendingReply: (() => Promise<Response>) | undefined
mock.module('posthog-js', { defaultExport: { getFeatureFlag: () => undefined, onFeatureFlags: () => () => {} } })
mock.module('next-intl', { namedExports: { useTranslations: () => translate } })
mock.module(new URL('../lib/auth-client.ts', import.meta.url).href, { namedExports: { authClient: { useSession: () => ({ data: { user: { id: 'owner' }, session: { id: 'owner-session' } }, isPending: false }) } } })
mock.module(new URL('../app/actions/pending-actions.ts', import.meta.url).href, { namedExports: { decidePendingAction: async () => { decisions++; return { status: 'declined' } } } })
mock.module(new URL('../components/coordinator/approved-write-actions.tsx', import.meta.url).href, { namedExports: { ApprovedWriteActions: () => null } })
mock.module(new URL('../components/ui/button.tsx', import.meta.url).href, { namedExports: { Button: ({ children, disabled, onClick }: { children?: ReactNode; disabled?: boolean; onClick?: () => void }) => <button disabled={disabled} onClick={onClick}>{children}</button> } })
mock.module('sonner', { namedExports: { toast: { error() {}, success() {} } } })

const browser = new Window({ url: 'https://mikka.example/mikka/en' })
const originalFetch = globalThis.fetch, originalSocket = globalThis.WebSocket
let root: Root, container: HTMLDivElement
let createRoot: typeof import('react-dom/client')['createRoot']
let SWRConfig: typeof import('swr')['SWRConfig']
let PendingActions: typeof import('../components/coordinator/pending-actions')['PendingActions']
let LiveProvider: typeof import('../hooks/use-live-key')['LiveProvider']
let items: PendingActionView[], reads: number, serverNow: string | null, responseOwner: string
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
const proposal = (): PendingActionView => ({ id: proposalId, action: 'send_email', input: { subject: 'Frozen proposal', to: ['fixture@example.invalid'], body: 'Visible waiting message' }, context: null, status: 'pending', createdAt: new Date().toISOString() })
before(async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.document })
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, WebSocket: FakeSocket })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ SWRConfig } = await import('swr'))
  ;({ PendingActions } = await import('../components/coordinator/pending-actions'))
  ;({ LiveProvider } = await import('../hooks/use-live-key'))
})
beforeEach(() => {
  items = [proposal()]; reads = 0; decisions = 0; serverNow = null; responseOwner = 'owner'; sockets.length = 0; ticketReads = 0; pendingReply = undefined
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  globalThis.fetch = async url => {
    const path = String(url)
    if (path.endsWith('/api/workspace/switcher')) return Response.json({ accounts: [{ id: 'owner', choices: [{ id: home, kind: 'personal' }] }] })
    if (path.includes('/api/live/ticket?workspace=')) {
      ticketReads++
      assert.equal(new URL(path, 'https://mikka.example').searchParams.get('workspace'), home)
      return Response.json({ url: 'wss://fixture.invalid/socket', protocol: 'fixture', expiresAt: Date.now() + 600_000 })
    }
    assert.ok(path.endsWith('/api/pending-actions'))
    reads++
    if (pendingReply) return pendingReply()
    return Response.json(items, { headers: { 'x-mikka-viewer': responseOwner, 'x-mikka-observed-at': serverNow ?? new Date().toISOString() } })
  }
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); globalThis.fetch = originalFetch })
after(() => { Object.assign(globalThis, { WebSocket: originalSocket }); browser.close() })
const wait = async (milliseconds = 160) => { await act(async () => { await new Promise(resolve => setTimeout(resolve, milliseconds)) }) }
async function render() {
  await act(async () => root.render(<SWRConfig value={{ provider: () => new Map(), revalidateOnFocus: false, dedupingInterval: 0 }}><LiveProvider ownerId="owner" workspaceId={home}><PendingActions /></LiveProvider></SWRConfig>))
  await wait()
  assert.equal(sockets.filter(socket => socket.readyState === 1).length, 1)
}
const emit = (kind: string, id: string) => { for (const socket of sockets) socket.message({ kind, id }) }

test('the healthy actual pending list remains idle beyond its previous ten-second poll', { timeout: 20_000 }, async () => {
  await render(); assert.ok(container.textContent?.includes('Frozen proposal'))
  const before = reads
  await wait(10_500)
  assert.equal(reads, before); assert.equal(decisions, 0)
})
test('a committed same-owner list event removes the card without resending a decision; another key does not read', async () => {
  await render(); const before = reads
  await act(async () => emit('pending_actions', '10000000-0000-4000-8000-000000000002')); await wait()
  assert.equal(reads, before)
  items = []
  await act(async () => emit('pending_actions', home)); await wait()
  assert.equal(reads, before + 1); assert.ok(!container.textContent?.includes('Frozen proposal')); assert.equal(decisions, 0)
})
test('a server five-minute deadline rechecks once despite a slow client clock, and does not extend approval', async () => {
  items = [{ ...proposal(), action: 'credential_operation', input: { summary: 'Credential approval', origin: 'https://example.invalid', operation: 'fill' }, createdAt: '2099-01-01T00:00:00.000Z' }]
  serverNow = '2099-01-01T00:04:59.000Z'
  await render(); assert.ok(container.textContent?.includes('Credential approval'))
  const before = reads, socketCount = sockets.length, tickets = ticketReads
  serverNow = '2099-01-01T00:05:00.001Z'; items = []
  await wait(1_150)
  assert.equal(reads, before + 1); assert.ok(!container.textContent?.includes('Credential approval')); assert.equal(decisions, 0)
  assert.equal(sockets.length, socketCount); assert.equal(ticketReads, tickets)
  const settled = reads; await wait(300); assert.equal(reads, settled)
})
test('a response belonging to another signed-in user is never rendered under the old key', async () => {
  responseOwner = 'peer'
  await render()
  assert.ok(container.textContent?.includes('approvalLoadFailed'))
  assert.ok(!container.textContent?.includes('Frozen proposal')); assert.equal(decisions, 0)
})


test('a slow initial pending read does not swallow the final same-expiry authoritative read', { timeout: 6_000 }, async () => {
  const started = performance.now(), epoch = Date.parse('2099-01-01T00:00:00.000Z'), expiresAfter = 2_000
  const expiring: PendingActionView = { ...proposal(), action: 'credential_operation', input: { summary: 'Slow credential approval', origin: 'https://example.invalid', operation: 'fill' }, createdAt: new Date(epoch + expiresAfter - 5 * 60_000).toISOString() }
  const observations: number[] = []
  pendingReply = async () => {
    if (performance.now() - started < 600) await new Promise(resolve => setTimeout(resolve, 450))
    const elapsed = performance.now() - started; observations.push(elapsed)
    return Response.json(elapsed < expiresAfter ? [expiring] : [], { headers: { 'x-mikka-viewer': 'owner', 'x-mikka-observed-at': new Date(epoch + elapsed).toISOString() } })
  }
  await render()
  while (performance.now() - started < 800) await wait(50)
  assert.ok(container.textContent?.includes('Slow credential approval'))
  const socketCount = sockets.length, tickets = ticketReads
  while (performance.now() - started < 2_450) await wait(50)
  assert.ok(observations.some(elapsed => elapsed > 1_000 && elapsed < expiresAfter), 'the conservative first deadline really read before server expiry')
  assert.equal(observations.filter(elapsed => elapsed >= expiresAfter).length, 1, 'a genuinely new same-at response must recheck at actual expiry')
  assert.ok(!container.textContent?.includes('Slow credential approval'))
  assert.equal(sockets.length, socketCount); assert.equal(ticketReads, tickets)
  const settled = reads; await wait(300); assert.equal(reads, settled); assert.equal(decisions, 0)
})
