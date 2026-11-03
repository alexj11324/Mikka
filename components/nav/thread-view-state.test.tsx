import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, useState, type ReactNode } from 'react'
import { Window } from 'happy-dom'
import type { Root } from 'react-dom/client'
import type { Thread } from '@/app/actions/task-runs'
import { ViewStateProvider } from '@/lib/hooks/view-state'

const browser = new Window({ url: 'https://mikka.example/en' })
let root: Root
let container: HTMLDivElement
let createRoot: typeof import('react-dom/client')['createRoot']
let AllThreadsColumn: typeof import('./all-threads')['AllThreadsColumn']
let ThreadList: typeof import('./thread-list')['ThreadList']
const translate = (key: string) => key
mock.module('next-intl', { namedExports: { useTranslations: () => translate, useNow: () => new Date('2026-11-03'), useFormatter: () => ({ relativeTime: () => 'yesterday' }) } })
mock.module('../workspace/thread-column', { namedExports: { RightColumn: ({ children }: { children: ReactNode }) => <aside>{children}</aside> } })
mock.module('./context-panel', { namedExports: {
  matches: (query: string, ...texts: (string | null)[]) => texts.some(text => text?.includes(query)),
  ThreadResults: (props: Parameters<typeof ThreadList>[0] & { shown: Thread[] }) => <ThreadList {...props} threads={props.shown} />,
} })
mock.module('../workspace/workspace-navigation', { namedExports: { navigate: () => {}, openThread: () => hide(), toggleAllThreads: () => {} } })
let hide = () => {}
let show = () => {}
const threads = [{ id: 'resolved-1', issueId: null, botId: 'bot-1', agentName: 'Frontend', prompt: 'Replace moment', status: 'succeeded', outcome: 'done', createdAt: '2026-11-02', updatedAt: '2026-11-02' }] as unknown as Thread[]
function Screen() {
  const [open, setOpen] = useState(true)
  hide = () => setOpen(false)
  show = () => setOpen(true)
  return <ViewStateProvider scope="person:workspace">{open && <AllThreadsColumn view="all" threads={threads} issues={[]} />}</ViewStateProvider>
}
before(async () => {
  for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'ResizeObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'] as const) Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? browser : browser[key] })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ ThreadList } = await import('./thread-list'))
  ;({ AllThreadsColumn } = await import('./all-threads'))
})
beforeEach(() => { browser.sessionStorage.clear(); container = browser.document.createElement('div') as unknown as HTMLDivElement; document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
after(() => browser.close())

test('return from a resolved thread keeps search, expanded resolved group and list position', async () => {
  await act(async () => root.render(<Screen />))
  await act(async () => (container.querySelector('button[aria-label="search"]') as HTMLButtonElement).click())
  const input = container.querySelector('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')!.set!.call(input, 'Replace')
    input.dispatchEvent(new browser.Event('input', { bubbles: true }) as unknown as Event)
  })
  await act(async () => (container.querySelector('[data-slot="collapsible-trigger"]') as HTMLButtonElement).click())
  const scroll = container.querySelector('.overflow-y-auto') as HTMLElement
  scroll.scrollTop = 840
  await act(async () => scroll.dispatchEvent(new browser.Event('scroll') as unknown as Event))
  await act(async () => (container.querySelector('button[aria-label="Replace moment"]') as HTMLButtonElement).click())
  await act(async () => show())
  assert.equal(container.querySelector('input')?.value, 'Replace')
  assert.equal(container.querySelector('[data-slot="collapsible-trigger"]')?.getAttribute('aria-expanded'), 'true')
  assert.equal((container.querySelector('.overflow-y-auto') as HTMLElement).scrollTop, 840)
})
