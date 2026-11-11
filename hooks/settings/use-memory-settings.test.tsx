import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { SWRConfig, useSWRConfig } from 'swr'
import { Window } from 'happy-dom'
import type { MemoryData } from './use-memory-settings'

const factId = 'f12c497e-3511-40a9-a357-aa0e410794aa'
const original = {
  enabled: true,
  total: 1, pending: [], undoable: [], scopeOptions: { workspaces: [], projects: [] },
  facts: [{ id: factId, kind: 'preference', subject: 'Original memory', userEdited: false, repository: null,
    createdAt: '2026-11-11T00:00:00.000Z', firstSeenAt: '2026-11-11T00:00:00.000Z', reviewStatus: 'approved',
    source: null, usedCount: 0, recentUses: [], scope: { kind: 'global', ids: [] }, actions: ['correct', 'remove', 'setScope'], undoUntil: null }],
} satisfies MemoryData
let persisted: MemoryData
let allowed: boolean
let reads = 0
const writes: string[] = []

mock.module('@/app/actions/memory', { namedExports: {
  getMemory: async () => { reads++; return structuredClone(persisted) },
  setMemory: async (enabled: boolean) => { persisted.enabled = enabled },
  updateFact: async (id: string, subject: string) => {
    writes.push('correct')
    if (!allowed) return false
    persisted.facts = persisted.facts.map(fact => fact.id === id ? { ...fact, subject, userEdited: true } : fact)
    return true
  },
  removeFact: async (id: string) => {
    writes.push('remove')
    if (!allowed) return false
    persisted.facts = persisted.facts.filter(fact => fact.id !== id)
    return true
  },
} })

const browser = new Window({ url: 'https://fixture.example/' })
let container: HTMLDivElement, root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let useMemorySettings: typeof import('./use-memory-settings')['useMemorySettings']
let memory: ReturnType<typeof useMemorySettings>
let refresh: () => Promise<unknown>
before(async () => {
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true, HTMLElement: browser.HTMLElement, Element: browser.Element })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ useMemorySettings } = await import('./use-memory-settings'))
})
beforeEach(() => {
  persisted = structuredClone(original); allowed = false; reads = 0; writes.length = 0
  container = browser.document.createElement('div') as unknown as HTMLDivElement
  document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
after(() => browser.happyDOM.close())
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)) })

function Probe() {
  memory = useMemorySettings()
  const { mutate } = useSWRConfig()
  refresh = () => mutate('memory')
  return <div data-failed={memory.failed} data-enabled={memory.data?.enabled}>
    {memory.data?.facts.map(fact => <span key={fact.id}>{fact.subject}</span>)}
  </div>
}

async function render() {
  await act(async () => root.render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}><Probe /></SWRConfig>))
  await settle()
  assert.equal(container.textContent, 'Original memory')
}

for (const action of ['correct', 'remove'] as const) {
  test(`a refused memory ${action} rolls back, reports failure and survives a refresh`, async () => {
    await render()
    await act(async () => {
      if (action === 'correct') await memory.correct(factId, 'Refused correction')
      else await memory.remove(factId)
    })
    assert.deepEqual(writes, [action])
    assert.equal(container.textContent, 'Original memory')
    assert.equal(memory.failed, true)
    assert.deepEqual(persisted, original, 'a refused action never changed server state')
    await act(async () => { await refresh() })
    await settle()
    assert.equal(reads, 2)
    assert.equal(container.textContent, 'Original memory')
  })

  test(`an accepted memory ${action} remains saved after a refresh`, async () => {
    await render(); allowed = true
    await act(async () => {
      if (action === 'correct') await memory.correct(factId, 'Saved correction')
      else await memory.remove(factId)
    })
    assert.equal(memory.failed, false)
    const expected = action === 'correct' ? 'Saved correction' : ''
    assert.equal(container.textContent, expected)
    await act(async () => { await refresh() })
    await settle()
    assert.equal(container.textContent, expected)
  })
}

test('the memory switch still accepts its void action result', async () => {
  await render()
  await act(async () => { await memory.setEnabled(false) })
  assert.equal(memory.data?.enabled, false)
  assert.equal(memory.failed, false)
  await act(async () => { await refresh() })
  assert.equal(memory.data?.enabled, false)
})
