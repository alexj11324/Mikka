import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import { ReadResponseError } from '@/lib/swr/retry'
import { CacheReadError } from '@/lib/cache-read-error'
import { ListReadScopeError } from '@/lib/live/list-read'
import type { ArtifactListItem } from '@/lib/artifacts/types'

const at = (path: string) => new URL(path, import.meta.url).href
const browser = new Window({ url: 'https://fixture.example/' })
const notices = new Map<string, { action?: { onClick: (event: Event) => void } }>()
const translate = (namespace: string) => (key: string) => `${namespace}.${key}`
mock.module('next-intl', { namedExports: { useTranslations: translate, useFormatter: () => ({ relativeTime: () => 'now' }), useNow: () => new Date('2026-11-07T00:00:00Z') } })
mock.module('sonner', { namedExports: { toast: {
  error: (_message: string, options: { id: string; action?: { onClick: (event: Event) => void } }) => { notices.set(options.id, options) },
  dismiss: (id: string) => { notices.delete(id) },
} } })
const item = { id: 'fixture-artifact', title: 'Retained artifact', kind: 'markdown', updatedAt: '2026-11-07T00:00:00Z', authorName: 'Fixture', issueKey: null } as ArtifactListItem
let failure: Error | null = null
let reads = 0
let readWait: Promise<void> | null = null
let cache = new Map()
mock.module(at('../../app/actions/artifacts.ts'), { namedExports: { listArtifacts: async () => { reads++; if (readWait) await readWait; if (failure) throw failure; return [item] } } })
mock.module(at('./artifact-card.tsx'), { namedExports: { ArtifactKindIcon: () => null } })

let ArtifactLibrary: typeof import('./artifact-library')['ArtifactLibrary']
let SWRConfig: typeof import('swr')['SWRConfig']
let useSWRConfig: typeof import('swr')['useSWRConfig']
let createRoot: typeof import('react-dom/client')['createRoot']
let refresh: () => Promise<unknown>
let root: Root, container: HTMLDivElement
function ReadControl() {
  const { mutate } = useSWRConfig()
  refresh = () => mutate('artifacts')
  return null
}
before(async () => {
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Element', 'getComputedStyle', 'MutationObserver', 'ResizeObserver', 'matchMedia', 'requestAnimationFrame', 'cancelAnimationFrame'] as const) {
    const value = key === 'window' ? browser : (browser as unknown as Record<string, unknown>)[key]
    if (value !== undefined) Object.defineProperty(globalThis, key, { configurable: true, value: typeof value === 'function' && !/^[A-Z]/.test(key) ? (value as (...args: unknown[]) => unknown).bind(browser) : value })
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ SWRConfig, useSWRConfig } = await import('swr'))
  ;({ ArtifactLibrary } = await import('./artifact-library'))
})
beforeEach(() => {
  notices.clear(); reads = 0; failure = null; readWait = null; cache = new Map()
  container = browser.document.createElement('div') as unknown as HTMLDivElement; document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
after(() => browser.happyDOM.close())
async function renderLibrary(visible = true) {
  await act(async () => root.render(<SWRConfig value={{ provider: () => cache, shouldRetryOnError: false, revalidateOnFocus: false, revalidateOnReconnect: false }}><ReadControl />{visible && <ArtifactLibrary />}</SWRConfig>))
}
async function mount() {
  await renderLibrary()
  for (let attempt = 0; attempt < 50 && !container.textContent?.includes(item.title); attempt++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  assert.ok(container.textContent?.includes(item.title))
}
const row = () => [...container.querySelectorAll('button')].find(button => button.textContent?.includes(item.title))
async function revalidate() { await act(async () => { await refresh().catch(() => {}) }) }

test('a background artifact read failure retains the same row, category and scroll container through retry', async () => {
  await mount()
  const category = [...container.querySelectorAll('button')].find(button => button.textContent === 'ArtifactsPage.category.documents')!
  await act(async () => category.click())
  const original = { row: row(), section: container.querySelector('section')! }
  original.section.scrollTop = 240
  failure = new TypeError('fixture offline')
  await revalidate()
  assert.ok(row() === original.row, 'existing artifacts must stay mounted during a background failure')
  assert.ok(container.querySelector('section') === original.section)
  assert.equal(category.getAttribute('aria-current'), 'page')
  assert.equal(original.section.scrollTop, 240)
  const notice = notices.get('artifact-library-read')
  assert.ok(notice?.action)
  failure = null
  const before = reads
  await act(async () => notice.action!.onClick(new Event('click', { cancelable: true })))
  for (let attempt = 0; attempt < 50 && notices.size; attempt++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  assert.ok(reads > before)
  assert.equal(notices.size, 0)
  assert.ok(row() === original.row)
  assert.equal(original.section.scrollTop, 240)
})

for (const refusal of [new ReadResponseError(401), new ReadResponseError(403), new ReadResponseError(404), new CacheReadError('authRequired'), new ListReadScopeError('owner'), new ListReadScopeError('workspace')]) test(`artifact access refusal ${refusal.name}:${'status' in refusal ? refusal.status : refusal.message} stays hidden through a later network failure`, async () => {
  await mount()
  failure = refusal
  await revalidate()
  assert.equal(row(), undefined)
  assert.ok(container.querySelector('[role="alert"]'))
  assert.equal(notices.size, 0)
  failure = new TypeError('fixture offline after refusal')
  await revalidate()
  assert.ok(row() === undefined, 'a failed retry cannot make revoked artifacts visible again')
  failure = null
  await revalidate()
  assert.ok(row(), 'a new successful authorized response can show the artifacts')
})

test('a refused library retry completing across a quick remount unlocks the current view', async () => {
  await mount()
  failure = new ReadResponseError(404)
  await revalidate()
  assert.equal(row(), undefined)
  failure = null
  let release!: () => void
  readWait = new Promise<void>(resolve => { release = resolve })
  let pending!: Promise<unknown>
  const before = reads
  await act(async () => { pending = refresh() })
  assert.equal(reads, before + 1)
  await renderLibrary(false)
  await renderLibrary()
  assert.equal(reads, before + 1, 'the reopen deduplicates the pending successful read')
  await act(async () => { release(); await pending })
  for (let attempt = 0; attempt < 30 && !row(); attempt++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  assert.ok(row(), 'the successful read unlocks the current mounted library, not only the old onSuccess owner')
})
