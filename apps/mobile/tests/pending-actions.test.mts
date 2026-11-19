import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, createElement, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'

// TSX components load Lucide's require export; keep native SVG outside this DOM behavior fixture.
const require = createRequire(import.meta.url)
import type { PendingAction } from '../lib/types.ts'
// The card's words come from the shared catalog (R-42), so the assertions read them back
// rather than writing the Chinese in twice — this suite runs under whatever the device locale is.
import { mobileMessages as messages } from '../lib/messages.ts'

const copy = messages.MobileCore
const actionCopy = messages.Coordinator.pendingActions

type Decision = { status: 'done' | 'failed' | 'declined'; reason: string | null }
const decisions: Array<{ path: string; approve: boolean }> = []
let decision: () => Promise<Decision>
let reload: () => Promise<void>
const presses = new Map<string, () => void>()

function label(node: ReactNode): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(label).join('')
  if (node && typeof node === 'object' && 'props' in node) return label((node.props as { children?: ReactNode }).children)
  return ''
}
const view = ({ children }: { children?: ReactNode }) => createElement('div', null, children)
const text = ({ children }: { children?: ReactNode }) => createElement('span', null, children)
mock.module('react-native', { namedExports: {
  Platform: { OS: 'web' },
  StyleSheet: { create: (styles: unknown) => styles }, View: view,
  Pressable: ({ children, onPress, disabled }: { children: ReactNode; onPress: () => void; disabled?: boolean }) => {
    presses.set(label(children), onPress)
    return createElement('button', { disabled, onClick: onPress }, children)
  },
} })
mock.module(require.resolve('lucide-react-native'), { namedExports: { CalendarClock: () => null, Mail: () => null } })
mock.module(new URL('../components/Symbol.tsx', import.meta.url).href, { namedExports: { Symbol: () => null } })
mock.module(new URL('../components/Text.tsx', import.meta.url).href, { namedExports: { Text: text } })
mock.module(new URL('../components/icons.tsx', import.meta.url).href, { namedExports: { Spinner: () => null } })
mock.module(new URL('../lib/theme.ts', import.meta.url).href, { namedExports: { colors: {}, lift: {} } })
mock.module(new URL('../lib/haptics.ts', import.meta.url).href, { namedExports: { tap: () => {} } })
class ApiError extends Error {
  constructor(public status: number) { super(`HTTP ${status}`) }
}
mock.module(new URL('../lib/api.ts', import.meta.url).href, { namedExports: {
  ApiError,
  api: async (path: string, options: { body: { approve: boolean } }) => {
    decisions.push({ path, approve: options.body.approve })
    return decision()
  },
} })

const browser = new Window({ url: 'https://fixture.invalid/' })
let root: Root, container: HTMLDivElement
let createRoot: typeof import('react-dom/client')['createRoot']
let PendingActions: typeof import('../components/PendingActions.tsx')['PendingActions']
const item: PendingAction = {
  id: 'fixture-pending-action', action: 'send_email', input: { to: ['fixture@example.invalid'], subject: 'Fixture request', body: 'Fixture body' },
  context: null, status: 'pending', createdAt: '2026-11-05T00:00:00Z',
}
before(async () => {
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ PendingActions } = await import('../components/PendingActions.tsx'))
})
beforeEach(() => {
  decisions.length = 0; presses.clear()
  decision = async () => ({ status: 'done', reason: null })
  // The parent retains its cached pending item when its refresh fails.
  reload = async () => { throw new Error('read offline') }
  container = browser.document.createElement('div') as unknown as HTMLDivElement
  document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
after(() => browser.happyDOM.close())
const render = async (items = [item]) => { await act(async () => root.render(createElement(PendingActions, { items, reload: () => reload() }))) }
const buttons = () => [...container.querySelectorAll('button')].map(button => button.textContent)

test('a confirmed approval replaces a stale cached card even when refreshing fails; retained callbacks cannot approve again', async () => {
  let finish!: (value: Decision) => void
  decision = () => new Promise(resolve => { finish = resolve })
  let rejectRefresh!: (reason: Error) => void
  reload = () => new Promise((_, reject) => { rejectRefresh = reject })
  await render()
  const approve = presses.get(actionCopy.approveSend)!
  await act(async () => { approve(); approve() })
  assert.equal(decisions.length, 1, 'repeated events share the pending decision')
  assert.ok([...container.querySelectorAll('button')].every(button => button.disabled))
  await act(async () => finish({ status: 'done', reason: null }))
  assert.ok(container.textContent?.includes(actionCopy.sent))
  assert.deepEqual(buttons(), [], 'the receipt is shown before the refresh completes')
  await act(async () => rejectRefresh(new Error('offline')))
  await render([item])
  assert.ok(container.textContent?.includes(actionCopy.sent))
  assert.ok(!container.textContent?.includes(copy.sendFailedRetry))
  assert.deepEqual(buttons(), [], 'a retained server snapshot cannot restore approval buttons')
  await act(async () => approve())
  assert.equal(decisions.length, 1)
})

for (const result of [
  { status: 'failed' as const, reason: 'Fixture refusal', line: actionCopy.failed.replace('{error}', 'Fixture refusal') },
  { status: 'declined' as const, reason: null, line: copy.rejected },
]) test(`a ${result.status} decision keeps its terminal receipt over the stale pending item`, async () => {
  decision = async () => result
  await render()
  await act(async () => presses.get(result.status === 'declined' ? actionCopy.decline : actionCopy.approveSend)!())
  await render([item])
  assert.ok(container.textContent?.includes(result.line))
  assert.deepEqual(buttons(), [])
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0].approve, result.status !== 'declined')
})

test('an already handled or expired action stays closed when its read cannot refresh', async () => {
  decision = async () => { throw new ApiError(409) }
  await render()
  await act(async () => presses.get(actionCopy.approveSend)!())
  await render([item])
  assert.ok(container.textContent?.includes(messages.Errors.pendingActionUnavailable))
  assert.deepEqual(buttons(), [])
})

test('an unconfirmed write failure keeps the proposal available for an explicit retry', async () => {
  decision = async () => { throw new Error('write offline') }
  await render()
  await act(async () => presses.get(actionCopy.approveSend)!())
  assert.ok(container.textContent?.includes(copy.sendFailedRetry))
  assert.deepEqual(buttons(), [actionCopy.decline, actionCopy.approveSend])
  assert.ok([...container.querySelectorAll('button')].every(button => !button.disabled))
  decision = async () => ({ status: 'done', reason: null })
  await act(async () => presses.get(actionCopy.approveSend)!())
  assert.equal(decisions.length, 2)
  assert.ok(container.textContent?.includes(actionCopy.sent))
  assert.deepEqual(buttons(), [])
})
