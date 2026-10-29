import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import type { ApprovedWriteItem } from '../lib/operations/write-client'
import type { PendingActionView } from '../lib/pending-action-view'

let viewerId = 'owner', responseViewer = 'owner', disabled = false, lostDecision = false, cursor = false
let viewStatus: 'pending' | 'running' = 'running'
let availabilityReads = 0, availabilityFailure = false
let items: ApprovedWriteItem[] = [], legacy: PendingActionView[] = []
const calls: Record<string, unknown>[] = [], oldDecisions: unknown[] = [], notices: string[] = []
const translate = Object.assign((key: string) => key, { has: () => false })
mock.module('next-intl', { namedExports: { useTranslations: () => translate } })
mock.module(new URL('../lib/auth-client.ts', import.meta.url).href, { namedExports: { authClient: { useSession: () => ({ data: { user: { id: viewerId }, session: { id: 'session-' + viewerId } }, isPending: false }) } } })
mock.module(new URL('../app/actions/pending-actions.ts', import.meta.url).href, { namedExports: { decidePendingAction: async (id: string, approve: boolean) => { oldDecisions.push({ id, approve }); legacy = legacy.filter(item => item.id !== id); return { status: 'done' } } } })
mock.module(new URL('../components/ui/button.tsx', import.meta.url).href, { namedExports: { Button: ({ children, disabled, onClick }: { children?: ReactNode; disabled?: boolean; onClick?: () => void }) => <button disabled={disabled} onClick={onClick}>{children}</button> } })
mock.module('sonner', { namedExports: { toast: { error: (text: string) => notices.push(text), success: (text: string) => notices.push(text) } } })

const browser = new Window({ url: 'https://mikka.example/mikka/en' })
const originalFetch = globalThis.fetch
let container: HTMLDivElement, root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let PendingActions: typeof import('../components/coordinator/pending-actions')['PendingActions']
let SWRConfig: typeof import('swr')['SWRConfig']
let useSWRConfig: typeof import('swr')['useSWRConfig']
let mutateCache: ReturnType<typeof import('swr')['useSWRConfig']>['mutate']
function CacheAccess() { mutateCache = useSWRConfig().mutate; return null }

function proposal(id: string, action: 'append_notion_paragraph' | 'send_slack_message' | 'cancel_calendar_event' = 'send_slack_message'): ApprovedWriteItem {
  return { id, action, input: action === 'append_notion_paragraph' ? { page_id: 'page-id', text: 'Frozen paragraph' } : action === 'send_slack_message' ? { channel: 'C12345678', text: 'Frozen message' } : { event_id: 'event-id', send_updates: 'externalOnly' }, approvalContext: action === 'cancel_calendar_event' ? { summary: 'Frozen event', start: { dateTime: '2027-01-01T10:00:00Z' }, end: { dateTime: '2027-01-01T11:00:00Z' } } : { name: 'frozen-channel' }, account: { provider: 'fixture', accountId: 'frozen-account', version: 'fixed' }, createdAt: '2026-10-29T10:00:00Z', approvalExpiresAt: '2099-10-29T10:00:00Z', status: 'pending', error: null }
}

before(async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.document })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ SWRConfig, useSWRConfig } = await import('swr'))
  ;({ PendingActions } = await import('../components/coordinator/pending-actions'))
})
beforeEach(() => {
  viewerId = 'owner'; responseViewer = 'owner'; disabled = false; lostDecision = false; cursor = false; viewStatus = 'running'
  availabilityReads = 0; availabilityFailure = false
  items = []; legacy = []; calls.length = 0; oldDecisions.length = 0; notices.length = 0
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/api/pending-actions')) return Response.json(legacy)
    assert.ok(String(url).endsWith('/api/approved-writes'))
    if (options?.method === 'GET') { availabilityReads++; return Response.json({ enabled: !disabled }, { status: availabilityFailure ? 503 : 200 }) }
    const body = JSON.parse(String(options?.body)); calls.push(body)
    if (disabled) return Response.json({ error: 'approvedWritesDisabled' }, { status: 503 })
    if (body.op === 'list') return Response.json({ viewerId: responseViewer, items: cursor && !body.cursor ? [] : items, nextCursor: cursor && !body.cursor ? 'older-page' : null, asOf: '2026-10-29T12:00:00Z' })
    if (body.op === 'view') return Response.json({ ...items.find(item => item.id === body.id), status: viewStatus, error: viewStatus === 'running' ? 'operationUncertain' : null })
    assert.equal(body.op, 'decide')
    if (lostDecision) throw Error('synthetic lost response')
    items = items.filter(item => item.id !== body.id)
    return Response.json({ status: body.approve ? 'done' : 'declined', error: null })
  }
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); globalThis.fetch = originalFetch })
after(() => browser.close())
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)) }) }
const render = async () => { await act(async () => root.render(<SWRConfig value={{ provider: () => new Map(), revalidateOnFocus: false, dedupingInterval: 0 }}><CacheAccess /><PendingActions /></SWRConfig>)); await flush() }
const card = (title: string) => [...container.querySelectorAll('li')].find(node => node.textContent?.includes(title))!
const click = async (node: Element) => { await act(async () => { (node as HTMLButtonElement).click() }); await flush() }

test('all new ask proposals display their frozen content/account; new and legacy buttons retain separate deciders', async () => {
  items = [proposal('new-slack'), proposal('new-notion', 'append_notion_paragraph'), proposal('new-calendar', 'cancel_calendar_event')]
  legacy = [{ id: 'legacy-email', action: 'send_email', input: { to: ['fixture@example.invalid'], subject: 'Old route', body: 'Old body' }, context: null, status: 'pending', createdAt: '2026-10-29T10:00:00Z' }]
  await render()
  for (const value of ['Frozen paragraph', 'Frozen message', 'Frozen event', 'frozen-account', 'frozen-channel', 'notifyExternal', 'Old body']) assert.ok(container.textContent?.includes(value), value)
  assert.deepEqual(calls[0], { op: 'list', unresolvedOnly: true, limit: 50 })
  await click([...card('send_slack_message').querySelectorAll('button')].find(button => button.textContent === 'approveSend')!)
  assert.deepEqual(calls.filter(call => call.op === 'decide'), [{ op: 'decide', action: 'send_slack_message', id: 'new-slack', approve: true }])
  assert.equal(oldDecisions.length, 0)
  await click([...card('send_email').querySelectorAll('button')].find(button => button.textContent === 'approveSend')!)
  assert.deepEqual(oldDecisions, [{ id: 'legacy-email', approve: true }])
})

test('disabled new service preserves legacy approvals without an error or new action', async () => {
  disabled = true
  legacy = [{ id: 'old', action: 'send_email', input: { subject: 'Legacy approval' }, context: null, status: 'pending', createdAt: '2026-10-29T10:00:00Z' }]
  await render()
  assert.ok(container.textContent?.includes('Legacy approval'))
  assert.ok(!container.querySelector('[role="alert"]'))
  assert.ok(availabilityReads > 0)
  assert.equal(calls.length, 0, 'closed availability must not generate list, view or decision POSTs')
})

test('failed availability leaves legacy approvals usable and never starts new service POSTs', async () => {
  availabilityFailure = true
  legacy = [{ id: 'old', action: 'send_email', input: { subject: 'Legacy approval' }, context: null, status: 'pending', createdAt: '2026-10-29T10:00:00Z' }]
  await render()
  assert.ok(container.textContent?.includes('Legacy approval'))
  assert.ok(container.querySelector('[role="alert"]')?.textContent?.includes('approvalLoadFailed'))
  assert.equal(calls.length, 0)
})

test('closing availability removes retained uncertain cards and stops their list/view POSTs', async () => {
  items = [proposal('same-action')]; lostDecision = true
  await render()
  await click([...card('send_slack_message').querySelectorAll('button')].find(button => button.textContent === 'approveSend')!)
  assert.ok(card('send_slack_message').textContent?.includes('resultUnconfirmed'))
  await flush()
  const beforeClose = calls.length
  disabled = true
  await act(async () => { await mutateCache('approved-write-availability') }); await flush()
  assert.ok(!container.textContent?.includes('Frozen message'))
  await act(async () => { await mutateCache(key => Array.isArray(key) && ['approved-writes', 'approved-write-result'].includes(String(key[0]))) }); await flush()
  assert.equal(calls.length, beforeClose, 'unmounted view and disabled list must not continue posting')
})

test('a lost decision response keeps the same card unconfirmed and polls only view instead of resending', async () => {
  items = [proposal('same-action')]; lostDecision = true
  await render()
  await click([...card('send_slack_message').querySelectorAll('button')].find(button => button.textContent === 'approveSend')!)
  await flush()
  assert.ok(card('send_slack_message').textContent?.includes('resultUnconfirmed'))
  assert.equal(card('send_slack_message').querySelectorAll('button').length, 0)
  assert.equal(calls.filter(call => call.op === 'decide').length, 1)
  assert.ok(calls.some(call => call.op === 'view' && call.id === 'same-action'))
  await flush()
  assert.equal(calls.filter(call => call.op === 'decide').length, 1)
})

test('an authenticated pending view permits explicit recovery without sending a decision, then requires a separate approval click', async () => {
  items = [proposal('same-action')]; lostDecision = true; viewStatus = 'pending'
  await render()
  await click([...card('send_slack_message').querySelectorAll('button')].find(button => button.textContent === 'approveSend')!)
  const recovery = [...card('send_slack_message').querySelectorAll('button')]
  assert.deepEqual(recovery.map(button => button.textContent), ['resumeApproval'])
  assert.equal(calls.filter(call => call.op === 'decide').length, 1)
  await click(recovery[0])
  const buttons = [...card('send_slack_message').querySelectorAll('button')]
  assert.deepEqual(buttons.map(button => button.textContent), ['decline', 'approveSend'])
  assert.equal(calls.filter(call => call.op === 'decide').length, 1, 'recovery can refresh reads but cannot execute')
  lostDecision = false
  await click(buttons.find(button => button.textContent === 'approveSend')!)
  assert.deepEqual(calls.filter(call => call.op === 'decide'), Array.from({ length: 2 }, () => ({ op: 'decide', action: 'send_slack_message', id: 'same-action', approve: true })))
})

test('an expired pending view cannot restore approval controls after a lost response', async () => {
  const expired = proposal('expired-action'); items = [expired]; lostDecision = true; viewStatus = 'pending'
  await render()
  if (expired.status !== 'attention') expired.approvalExpiresAt = '2020-01-01T00:00:00Z'
  await click([...card('send_slack_message').querySelectorAll('button')].find(button => button.textContent === 'approveSend')!)
  assert.equal(card('send_slack_message').querySelectorAll('button').length, 0)
  assert.ok(card('send_slack_message').textContent?.includes('resultUnconfirmed'))
  assert.equal(calls.filter(call => call.op === 'decide').length, 1)
})

test('a stale recovery control cannot restore or mutate another account proposal', async () => {
  items = [proposal('old-owner-action')]; lostDecision = true; viewStatus = 'pending'
  await render()
  await click([...card('send_slack_message').querySelectorAll('button')].find(button => button.textContent === 'approveSend')!)
  const recovery = [...card('send_slack_message').querySelectorAll('button')].find(button => button.textContent === 'resumeApproval')!
  viewerId = 'other'; responseViewer = 'other'; items = [proposal('other-owner-action')]
  await render()
  await click(recovery)
  const buttons = [...card('send_slack_message').querySelectorAll('button')]
  assert.deepEqual(buttons.map(button => button.textContent), ['decline', 'approveSend'])
  assert.equal(calls.filter(call => call.op === 'decide').length, 1)
  lostDecision = false
  await click(buttons.find(button => button.textContent === 'decline')!)
  assert.deepEqual(calls.filter(call => call.op === 'decide').at(-1), { op: 'decide', action: 'send_slack_message', id: 'other-owner-action', approve: false })
})

test('a response from a switched cookie cannot expose another owner under the old session key', async () => {
  responseViewer = 'other'; items = [proposal('private-other')]
  await render()
  assert.ok(!container.textContent?.includes('Frozen message'))
  assert.ok(!container.textContent?.includes('frozen-account'))
  assert.ok(container.querySelector('[role="alert"]')?.textContent?.includes('approvalLoadFailed'))
})

test('older unresolved pages are reachable and expired approvals can only be declined', async () => {
  const expired = proposal('old-pending'); if (expired.status !== 'attention') expired.approvalExpiresAt = '2020-01-01T00:00:00Z'
  items = [expired]; cursor = true
  await render()
  await click([...container.querySelectorAll('button')].find(button => button.textContent === 'more')!)
  const buttons = [...card('send_slack_message').querySelectorAll('button')]
  assert.ok(buttons.find(button => button.textContent === 'approveSend')?.disabled)
  assert.ok(!buttons.find(button => button.textContent === 'decline')?.disabled)
  await click(buttons.find(button => button.textContent === 'decline')!)
  assert.deepEqual(calls.find(call => call.op === 'decide'), { op: 'decide', action: 'send_slack_message', id: 'old-pending', approve: false })
  assert.ok(calls.some(call => call.op === 'list' && call.cursor === 'older-page'))
})

test('redacted attention proposals expose decline without an approval control or invented target', async () => {
  items = [{ id: 'invalid-binding', action: 'send_slack_message', createdAt: '2026-10-29T10:00:00Z', status: 'attention', error: 'operationBindingConflict' }]
  await render()
  const node = card('send_slack_message')
  assert.ok(node.textContent?.includes('needsReview'))
  assert.equal(node.querySelectorAll('button').length, 1)
  assert.equal(node.querySelector('button')?.textContent, 'decline')
  await click(node.querySelector('button')!)
  assert.deepEqual(calls.find(call => call.op === 'decide'), { op: 'decide', action: 'send_slack_message', id: 'invalid-binding', approve: false })
})

test('an in-flight decision from an old session cannot disable or settle the next account cards', async () => {
  items = [proposal('old-owner-action')]
  const transport = globalThis.fetch
  let finish!: (response: Response) => void
  globalThis.fetch = async (url, options) => {
    const body = options?.body ? JSON.parse(String(options.body)) : null
    if (body?.op === 'decide' && body.id === 'old-owner-action') { calls.push(body); return new Promise<Response>(resolve => { finish = resolve }) }
    return transport(url, options)
  }
  await render()
  await click([...card('send_slack_message').querySelectorAll('button')].find(button => button.textContent === 'approveSend')!)
  viewerId = 'other'; responseViewer = 'other'; items = [proposal('other-owner-action')]
  await render()
  assert.ok(![...card('send_slack_message').querySelectorAll('button')].find(button => button.textContent === 'approveSend')?.disabled)
  await act(async () => { finish(Response.json({ status: 'declined', error: null })) }); await flush()
  assert.ok(card('send_slack_message').textContent?.includes('Frozen message'))
  await click([...card('send_slack_message').querySelectorAll('button')].find(button => button.textContent === 'decline')!)
  assert.deepEqual(calls.filter(call => call.op === 'decide'), [{ op: 'decide', action: 'send_slack_message', id: 'old-owner-action', approve: true }, { op: 'decide', action: 'send_slack_message', id: 'other-owner-action', approve: false }])
})
