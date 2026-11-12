import assert from 'node:assert/strict'
import { after, before, mock, test } from 'node:test'
import { act } from 'react'
import { Window } from 'happy-dom'
import type { Root } from 'react-dom/client'
import { NextIntlClientProvider } from 'next-intl'
import messages from '../messages/en.json'
import { taskPresentation } from '../lib/task-presentation'

const calls: string[][] = []
const selectedCalls: { workspaceId: string; issueIds: string[] }[] = []
const threadless = taskPresentation({ status: 'backlog', metadata: { pullRequests: [] } }, undefined, null, () => false)
const factory = taskPresentation({ status: 'doing', metadata: { pullRequests: [] } }, undefined,
  { stage: 'spec', needsYou: { kind: 'spec_review', since: '2026-11-01' } }, () => false)
const hidden = '00000000-0000-4000-8000-000000000099'
mock.module(new URL('../app/actions/task-domain.ts', import.meta.url).href, { namedExports: {
  getTaskPresentations: async ({ workspaceId, issueIds, includeReview, includeFactoryIdentity }: { workspaceId: string; issueIds: string[]; includeReview?: true; includeFactoryIdentity?: true }) => {
    if (includeFactoryIdentity) {
      selectedCalls.push({ workspaceId, issueIds })
      if (workspaceId === 'citation-workspace') return { version: 1, workspaceId, items: { [issueIds[0]!]: factory } }
      return { version: 1, workspaceId, items: workspaceId === 'revoked' ? {} : { [issueIds[0]!]: { state: 'blocked', reason: 'quota', factoryTaskId: 'selected-factory' } } }
    }
    assert.equal(includeReview, true)
    calls.push(issueIds)
    if (workspaceId === 'citation-workspace') return { version: 1, workspaceId, items: Object.fromEntries(issueIds.filter(id => id !== hidden).map(id => [id, factory])) }
    return { version: 1, workspaceId, items: Object.fromEntries(issueIds.map(id => [id, { state: 'waiting' }])) }
  },
} })
mock.module(new URL('./use-live-key.tsx', import.meta.url).href, { namedExports: { useLiveKeys() {}, useLiveScope: () => null } })
const browser = new Window()
let createRoot: typeof import('react-dom/client')['createRoot']
let TaskCardDataProvider: typeof import('./use-task-cards')['TaskCardDataProvider'], useTaskCards: typeof import('./use-task-cards')['useTaskCards']
before(async () => {
  for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, IS_REACT_ACT_ENVIRONMENT: true,
    Element: browser.Element, HTMLElement: browser.HTMLElement, Node: browser.Node, ShadowRoot: browser.ShadowRoot,
    getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser) })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  ;({ createRoot } = await import('react-dom/client'))
  ;({ TaskCardDataProvider, useTaskCards } = await import('./use-task-cards'))
})
after(() => browser.happyDOM.close())

function Row({ id }: { id: string }) {
  const cards = useTaskCards([id])
  return <span>{cards[id]?.state}</span>
}
test('mounted review/citation cards batch and deduplicate IDs including a task outside the first list page', async () => {
  for (const count of [1, 16, 201]) {
    const host = browser.document.createElement('div') as unknown as HTMLDivElement
    const root: Root = createRoot(host)
    calls.length = 0
    const ids = Array.from({ length: count }, (_, index) => `historical-${index}`)
    try {
      await act(async () => {
        root.render(<TaskCardDataProvider ownerId="viewer" workspaceId={`ws-${count}`}>
          {ids.map(id => <Row key={id} id={id} />)}<Row id={ids[0]} />
        </TaskCardDataProvider>)
      })
      assert.deepEqual(calls.map(batch => batch.length), count > 200 ? [200, 1] : [count])
      assert.deepEqual(new Set(calls.flat()), new Set(ids))
      assert.equal(host.textContent, 'waiting'.repeat(count + 1))
    } finally { await act(async () => root.unmount()) }
  }
})

test('Task citations use the read-only viewer’s detail state and batch historical IDs once', async () => {
  const { IssueCitation } = await import('../components/workspace/agent-citations')
  const { TaskPresentationsContext } = await import('./use-task-collection')
  const { useSelectedTaskPresentation } = await import('./use-selected-task-presentation')
  const { useState } = await import('react')
  const ids = Array.from({ length: 16 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
  const opened: string[] = []
  const host = browser.document.createElement('div') as unknown as HTMLDivElement
  const root = createRoot(host)
  function ReadOnlyView() {
    const [selected, setSelected] = useState<string>()
    const detail = useSelectedTaskPresentation('viewer', 'citation-workspace', selected)
    return <><output>{detail.data?.state}</output>{[...ids, hidden, ids[1]].map((id, index) => <IssueCitation key={index}
      issue={{ kind: 'issue', id, number: null, identifier: null, title: id, priority: 'normal', status: 'done' }}
      onOpen={id => { opened.push(id); setSelected(id) }} />)}</>
  }
  calls.length = 0
  selectedCalls.length = 0
  try {
    await act(async () => { root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <TaskPresentationsContext value={{ [ids[0]]: threadless }}><TaskCardDataProvider ownerId="viewer" workspaceId="citation-workspace">
        <ReadOnlyView />
      </TaskCardDataProvider></TaskPresentationsContext>
    </NextIntlClientProvider>) })
    const chip = (id: string) => host.querySelector<HTMLElement>(`[data-focus-id="${id}"]`)!
    assert.deepEqual(calls, [[...ids.slice(1), hidden]])
    assert.equal(chip(hidden).dataset.taskChip, '', 'an omitted Task never inherits a state from the saved citation')
    for (const id of ids.slice(0, 2)) {
      await act(async () => chip(id).click())
      assert.equal(chip(id).dataset.taskChip, host.querySelector('output')?.textContent)
    }
    assert.deepEqual(opened, ids.slice(0, 2))
    assert.deepEqual(selectedCalls, [{ workspaceId: 'citation-workspace', issueIds: [ids[1]] }])
    assert.equal(calls.length, 1)
  } finally { await act(async () => root.unmount()); selectedCalls.length = 0 }
})


test('the open Task uses its list state or one scoped read for its state and authorized Factory', async () => {
  const { TaskPresentationsContext } = await import('./use-task-collection')
  const { useSelectedTaskPresentation } = await import('./use-selected-task-presentation')
  const { SWRConfig } = await import('swr')
  const known = { active: { state: 'waiting', reason: 'pr_review', factoryTaskId: 'visible-factory' } } as unknown as Record<string, import('../lib/task-presentation').TaskPresentation>
  const host = browser.document.createElement('div') as unknown as HTMLDivElement
  const root = createRoot(host)
  const cache = new Map()
  function View({ workspace, id }: { workspace: string; id?: string }) {
    const { data } = useSelectedTaskPresentation('viewer', workspace, id)
    return <span>{[data?.state, data?.reason, data?.factoryTaskId].join('/')}</span>
  }
  async function show(workspace: string, id?: string) {
    await act(async () => { root.render(<SWRConfig value={{ provider: () => cache }}>
      <TaskPresentationsContext value={workspace === 'visible' ? known : {}}><View workspace={workspace} id={id} /></TaskPresentationsContext>
    </SWRConfig>) })
  }
  try {
    await show('visible', 'active')
    assert.equal(host.textContent, 'waiting/pr_review/visible-factory')
    assert.equal(selectedCalls.length, 0)
    await show('visible', 'older')
    assert.equal(host.textContent, 'blocked/quota/selected-factory')
    await show('revoked', 'older')
    assert.equal(host.textContent, '//')
    await show('preview')
    assert.deepEqual(selectedCalls, [
      { workspaceId: 'visible', issueIds: ['older'] }, { workspaceId: 'revoked', issueIds: ['older'] },
    ])
  } finally { await act(async () => root.unmount()) }
})

test('continuations are user-driven, deduplicate overlaps and cannot restore another workspace page', async () => {
  const { useTaskContinuation } = await import('../lib/hooks/use-task-continuation')
  const host = browser.document.createElement('div') as unknown as HTMLDivElement, root = createRoot(host)
  const cursor = { id: 'legacy-anchor', updatedAt: '2026-11-11T00:00:00.000Z' }
  let release!: () => void, reads = 0, load!: () => Promise<void>
  const read = async () => {
    reads++
    await new Promise<void>(resolve => { release = resolve })
    return { items: [{ id: 'a-first' }, {id: 'a-second'}], next: null }
  }
  function Probe({ owner }: { owner: string }) {
    const paging = useTaskContinuation([{ id: owner+'-first' }], owner, cursor, read)
    load = paging.loadMore
    return <span>{paging.items.map(row => row.id).join(',')}</span>
  }
  try {
    await act(async () => { root.render(<Probe owner="a" />) })
    assert.equal(reads, 0)
    let first!: Promise<void>
    await act(async () => { first = load(); void load() })
    assert.equal(reads, 1)
    await act(async () => { release(); await first })
    assert.equal(host.textContent, 'a-first,a-second')
    await act(async () => { root.render(<Probe owner="b" />) })
    assert.equal(host.textContent, 'b-first')
    await act(async () => { first = load() })
    await act(async () => { root.render(<Probe owner="c" />) })
    await act(async () => { release(); await first })
    assert.equal(host.textContent, 'c-first')
  } finally { await act(async () => root.unmount()) }
})
