import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'

// A thread card shows the PRs its thread produced as one badge: the summary
// state's git mark and the count. Tapping (or hovering) lists each PR, and a
// click on the badge never opens the thread behind it.
const t = Object.assign((key: string, values?: Record<string, unknown>) => values && 'count' in values ? `${key}:${values.count}` : key, { rich: (key: string) => key, has: () => true })
mock.module('next-intl', { namedExports: {
  useTranslations: () => t,
  useFormatter: () => ({ relativeTime: () => 'just now', dateTime: () => 'today' }),
  useNow: () => new Date('2026-11-01T12:00:00Z'),
} })

const browser = new Window({ url: 'https://mikka.example/en' })
let container: HTMLDivElement
let root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let badge: typeof import('../components/workspace/pull-requests-badge')
let ThreadCard: typeof import('../components/coordinator/thread-card')['ThreadCard']
before(async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.document })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, ShadowRoot: browser.ShadowRoot, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} }, getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0), cancelAnimationFrame: (id: number) => clearTimeout(id) })
  ;({ createRoot } = await import('react-dom/client'))
  badge = await import('../components/workspace/pull-requests-badge')
  ;({ ThreadCard } = await import('../components/coordinator/thread-card'))
})
beforeEach(() => { container = document.createElement('div') as unknown as HTMLDivElement; document.body.append(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })
after(() => browser.close())

const pr = (number: number, state: 'open' | 'draft' | 'merged' | 'closed', extra: { title?: string; additions?: number; deletions?: number } = {}) =>
  ({ url: `https://github.com/acme/ledger/pull/${number}`, state, ...extra })

test('the badge takes one state for its PRs: open, else draft, else merged, else closed', () => {
  const { pullRequestsState } = badge
  assert.equal(pullRequestsState([pr(1, 'merged'), pr(2, 'open'), pr(3, 'closed')]), 'open')
  assert.equal(pullRequestsState([pr(1, 'merged'), pr(2, 'draft')]), 'draft')
  assert.equal(pullRequestsState([pr(1, 'merged'), pr(2, 'merged')]), 'merged')
  assert.equal(pullRequestsState([pr(1, 'merged'), pr(2, 'closed')]), 'merged')
  assert.equal(pullRequestsState([pr(1, 'closed'), pr(2, 'closed')]), 'closed')
  assert.deepEqual(badge.pullRequestRef('https://github.com/acme/ledger/pull/92/'), { repo: 'ledger', number: '92' })
})

test('no PRs, no badge', () => {
  act(() => root.render(<badge.PullRequestsBadge pullRequests={[]} />))
  assert.equal(container.querySelector('[data-slot="pull-requests-badge"]'), null)
})

test('the badge shows the state colour and count; tapping lists each PR with its title, state, repository and number', async () => {
  const list = [pr(92, 'merged', { title: 'Fix the Safari login page', additions: 18, deletions: 4 }), pr(93, 'open')]
  act(() => root.render(<badge.PullRequestsBadge pullRequests={list} />))
  const trigger = container.querySelector('[data-slot="pull-requests-badge"]') as HTMLButtonElement
  assert.equal(trigger.getAttribute('data-state-summary'), 'open')
  assert.equal(trigger.getAttribute('aria-label'), 'label:2')
  assert.equal(trigger.textContent, '2')
  assert.match(trigger.className, /text-github-pr-open/)
  await act(async () => { trigger.click(); await new Promise(resolve => setTimeout(resolve, 20)) })
  const rows = [...document.querySelectorAll('[data-slot="pull-requests-list"] [data-slot="pull-request-row"]')] as HTMLAnchorElement[]
  assert.equal(rows.length, 2)
  assert.equal(rows[0].getAttribute('href'), list[0].url)
  assert.equal(rows[0].getAttribute('target'), '_blank')
  assert.match(rows[0].textContent ?? '', /^Fix the Safari login pagemergedledger #92\+18−4$/)
  // No title: the repository and number stand in; no line counts unless a reader supplied them.
  assert.equal(rows[1].textContent, 'ledger #93openledger #93')
  assert.doesNotMatch(rows[1].textContent ?? '', /[+−]\d/)
})

test('on a thread card the badge opens its list, not the thread', async () => {
  const opened: unknown[] = []
  const run = { kind: 'run', id: '7d3d2f62-1d7c-4f2c-9a7e-3b1f0c0a5e11', name: 'Fix the Safari login page', status: 'succeeded', outcome: 'done', issue: { id: 'task-1' }, pullRequests: [pr(92, 'merged')] } as unknown as Parameters<typeof ThreadCard>[0]['run']
  act(() => root.render(<ThreadCard run={run} onOpen={thread => opened.push(thread)} />))
  const trigger = container.querySelector('[data-slot="thread-card"] [data-slot="pull-requests-badge"]') as HTMLButtonElement
  assert.equal(trigger.getAttribute('data-state-summary'), 'merged')
  assert.match(trigger.className, /pointer-events-auto/)
  await act(async () => { trigger.click(); await new Promise(resolve => setTimeout(resolve, 20)) })
  assert.deepEqual(opened, [])
  assert.equal(document.querySelectorAll('[data-slot="pull-requests-list"] [data-slot="pull-request-row"]').length, 1)
  // The card itself still opens the thread.
  act(() => (container.querySelector('[data-slot="thread-card"] > button') as HTMLButtonElement).click())
  assert.deepEqual(opened, [{ issueId: 'task-1', runId: '7d3d2f62-1d7c-4f2c-9a7e-3b1f0c0a5e11' }])
})
