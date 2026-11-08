import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import * as swr from 'swr'
import { Window } from 'happy-dom'

// #1662: the plan / seat / role summary refreshes on the existing member and
// settings live invalidation and after member actions, with no polling of its own.
const workspaceId = '16620000-0000-4000-8000-000000000001'
const ownerId = 'owner-1662'
let liveKeys: string[] = []
const membersRead = { currentUserId: ownerId, workspace: { id: workspaceId, name: 'Fixture' }, live: { ownerId, homeWorkspaceId: null } }

mock.module('next/navigation', { namedExports: { useSearchParams: () => new URLSearchParams('') } })
mock.module('next-intl', { namedExports: { useTranslations: () => Object.assign((key: string) => key, { has: () => false }) } })
mock.module('@/hooks/use-live-key', { namedExports: { useLiveKeys: (_entities: unknown, keys: string[]) => { liveKeys = keys } } })
mock.module('@/lib/settings-prefetch', { namedExports: { prefetchConnectedApps: () => () => {} } })

const browser = new Window({ url: 'https://fixture.example/' })
let container: HTMLDivElement, root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let governance: typeof import('./use-workspace-governance')
let SettingsDataPreloader: typeof import('@/components/settings/settings-data-preloader')['SettingsDataPreloader']
let summaryReads = 0
before(async () => {
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true, HTMLElement: browser.HTMLElement, Element: browser.Element })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/governance')) { summaryReads++; return Response.json({ activeHumans: summaryReads }) }
    return Response.json(membersRead)
  }) as typeof fetch
  ;({ createRoot } = await import('react-dom/client'))
  governance = await import('./use-workspace-governance')
  ;({ SettingsDataPreloader } = await import('@/components/settings/settings-data-preloader'))
})
beforeEach(() => {
  summaryReads = 0; liveKeys = []
  container = browser.document.createElement('div') as unknown as HTMLDivElement
  document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
after(() => browser.happyDOM.close())
const fresh = (node: ReactNode) => <swr.SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{node}</swr.SWRConfig>
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)) })

test('the settings live invalidation names the governance summary of the resolved workspace', async () => {
  await act(async () => root.render(fresh(<SettingsDataPreloader ownerId={ownerId} userKey="fixture@example.com" onWorkspaceResolved={() => {}} />)))
  await settle()
  assert.ok(liveKeys.includes(governance.governanceLiveKey(workspaceId)), liveKeys.join(', '))
  assert.equal(governance.governanceLiveKey(workspaceId), swr.unstable_serialize(governance.governanceKey(workspaceId)))
})

test('a member action re-reads a mounted summary once; nothing reads it on its own', async () => {
  let revalidate: ReturnType<typeof governance.useRevalidateGovernance> | undefined
  function SummaryProbe() {
    const summary = governance.useGovernanceSummary(workspaceId)
    revalidate = governance.useRevalidateGovernance()
    return <span data-active={(summary.data as { activeHumans?: number } | undefined)?.activeHumans ?? ''} />
  }
  await act(async () => root.render(fresh(<SummaryProbe />)))
  await settle()
  assert.equal(summaryReads, 1)
  await settle()
  assert.equal(summaryReads, 1, 'no idle polling')
  await act(async () => { await revalidate!(workspaceId) })
  await settle()
  assert.equal(summaryReads, 2)
  assert.equal(container.querySelector('[data-active]')?.getAttribute('data-active'), '2', 'the mounted card shows the new count')
})
