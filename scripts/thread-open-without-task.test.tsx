import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'

// A thread that works on no task opens like any other, from its chat card and
// from the thread list (Bot 资料 › 线程): the whole card is one button.
const t = Object.assign((key: string) => key, { rich: (key: string) => key, has: () => true })
mock.module('next-intl', { namedExports: {
  useTranslations: () => t,
  useFormatter: () => ({ relativeTime: () => 'just now', dateTime: () => 'today' }),
  useNow: () => new Date('2026-11-01T12:00:00Z'),
} })

const browser = new Window({ url: 'https://mikka.example/en' })
let container: HTMLDivElement
let root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let ThreadCard: typeof import('../components/coordinator/thread-card')['ThreadCard']
let ThreadList: typeof import('../components/nav/thread-list')['ThreadList']
before(async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.document })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, ResizeObserver: class { observe() {} disconnect() {} }, getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0), cancelAnimationFrame: (id: number) => clearTimeout(id) })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ ThreadCard } = await import('../components/coordinator/thread-card'))
  ;({ ThreadList } = await import('../components/nav/thread-list'))
})
beforeEach(() => { container = document.createElement('div') as unknown as HTMLDivElement; document.body.append(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })
after(() => browser.close())

const runId = '7d3d2f62-1d7c-4f2c-9a7e-3b1f0c0a5e11'

test('a chat thread card with no task is a live button that opens the thread', () => {
  const opened: unknown[] = []
  const run = { kind: 'run', id: runId, name: 'Draft the release notes', status: 'succeeded', outcome: null, issue: null } as unknown as Parameters<typeof ThreadCard>[0]['run']
  act(() => root.render(<ThreadCard run={run} onOpen={thread => opened.push(thread)} />))
  const button = container.querySelector('[data-slot="thread-card"] button') as unknown as HTMLButtonElement
  assert.ok(button)
  assert.equal(button.disabled, false)
  act(() => button.click())
  assert.deepEqual(opened, [{ issueId: null, runId }])
})

test('the thread list shows each thread as a card, and one with no task opens like the rest', () => {
  const opened: unknown[] = []
  const thread = { id: runId, issueId: null, prompt: 'Draft the release notes\nfor 2.4', status: 'succeeded', outcome: 'resolved', createdAt: new Date('2026-11-01T11:00:00Z'), finishedAt: new Date('2026-11-01T11:30:00Z'), lastReply: 'Notes are in the doc.', harness: 'codex' } as unknown as Parameters<typeof ThreadList>[0]['threads'][number]
  act(() => root.render(<ThreadList threads={[thread]} issues={[]} all onOpenThread={value => opened.push(value)} />))
  const cards = container.querySelectorAll('li[data-slot="thread-card"]')
  assert.equal(cards.length, 1, 'one card per thread')
  // 已解决 starts collapsed; open it, then the card.
  const resolved = container.querySelector('[role="group"] button') as unknown as HTMLButtonElement | null
  const card = cards[0].querySelector('button') as unknown as HTMLButtonElement | null
  assert.ok(card ?? resolved)
  if (!card) act(() => resolved!.click())
  const button = container.querySelector('li[data-slot="thread-card"] button') as unknown as HTMLButtonElement
  assert.equal(button.getAttribute('aria-label'), 'Draft the release notes')
  act(() => button.click())
  assert.deepEqual(opened, [{ issueId: null, runId }])
})
