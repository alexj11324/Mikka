import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, createContext, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import { SWRConfig } from 'swr'
import { ViewStateProvider } from '@/lib/hooks/view-state'
import { Button } from '@/components/ui/button'
import type { BoardMenuItem, BoardScreenProps } from '@/components/slots/board-contract'
import type { listIssues } from '@/app/actions/issues'

type Issue = Awaited<ReturnType<typeof listIssues>>[number]
const browser = new Window({ url: 'https://fixture.example/' })
const translate = Object.assign((key: string) => key, { has: () => false })
const nothing = () => {}
const empty = () => null
const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>
mock.module('@/lib/intl/i18n-client', { namedExports: { useLocale: () => 'en', useTranslations: () => translate } })
const syncReads: (string | undefined)[] = []
let mappedWorkspace: string | undefined
/** The reader's own Agents and the Runs a live read names, so a task's Captain can be one of theirs. */
let myAgentList: { id: string }[] = []
let liveRuns: { issueId: string; bot: { id: string; name: string; color: string; shape: string } | null; harnesses: string[] }[] | undefined
mock.module('@/hooks/use-task-collection', { namedExports: { TaskPresentationsContext: createContext({}) } })
mock.module('@/hooks/use-live-lists', { namedExports: { useLiveTaskRunList: () => liveRuns ? { data: { items: liveRuns } } : { data: undefined } } })
mock.module('@/hooks/use-list-expiry', { namedExports: { useListExpiry: nothing } })
mock.module('@/app/actions/agents', { namedExports: { listAgents: async () => myAgentList } })
mock.module('@/app/actions/linear-sync', { namedExports: { getLinearBoardSync: async (workspace?: string) => {
  syncReads.push(workspace)
  return { synced: !!workspace && workspace === mappedWorkspace }
} } })
mock.module('@/components/nav/bot-avatar', { namedExports: { CoordinatorAvatar: empty } })
mock.module('@/components/nav/conversation-pill', { namedExports: { ConversationPill: empty } })
mock.module('@/components/coordinator/coordinator-chat', { namedExports: { CoordinatorChat: empty } })
mock.module('@/components/coordinator/new-task-dialog', { namedExports: { NewTaskDialog: empty } })
mock.module('@/components/ui/sheet', { namedExports: { Sheet: empty, SheetContent: Pass, SheetHeader: Pass, SheetTitle: Pass } })
// The test adapter exposes the public slot callbacks. The official renderer
// is exercised in the companion repository without copying its implementation.
mock.module('./board-screen', { namedExports: { BoardScreenView: ({ issues, view, onView, scopes, scope, onScope, filterItems, tools }: Pick<BoardScreenProps, 'view' | 'onView' | 'scopes' | 'scope' | 'onScope' | 'filterItems' | 'tools'> & { issues: Issue[] }) =>
  <div data-board-view={view}>{tools}
    <Button aria-label="viewList" aria-pressed={view === 'list'} onClick={() => onView('list')}>List</Button>
    <div role="tablist">{scopes.map(entry => <Button key={entry.id} role="tab" aria-selected={scope === entry.id} data-count={entry.count} onClick={() => onScope(entry.id)}>{entry.label}</Button>)}</div>
    {filterItems.map((group: BoardMenuItem) => <div key={group.label}>
      {group.submenu?.map(item => <Button key={item.label} role="menuitemcheckbox" aria-checked={item.checked} onClick={item.onSelect}>{item.label}</Button>)}
      {group.submenu?.some(item => item.checked) && <span role="group" aria-label={group.label}>{group.submenu.filter(item => item.checked).map(item => item.label).join(', ')}</span>}
    </div>)}
    {issues.map(issue => <p key={issue.id} data-shown-issue>{issue.title}</p>)}
  </div> } })

let BoardPage: typeof import('./board-page')['BoardPage']
let createRoot: typeof import('react-dom/client')['createRoot']
let root: Root, container: HTMLDivElement
before(async () => {
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'ResizeObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'] as const) {
    const value = key === 'window' ? browser : (browser as unknown as Record<string, unknown>)[key]
    Object.defineProperty(globalThis, key, { configurable: true, value: typeof value === 'function' && !/^[A-Z]/.test(key) ? (value as (...args: unknown[]) => unknown).bind(browser) : value })
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ BoardPage } = await import('./board-page'))
})
beforeEach(() => {
  browser.localStorage.clear(); browser.sessionStorage.clear()
  myAgentList = []; liveRuns = undefined
  container = browser.document.createElement('div') as unknown as HTMLDivElement; document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
after(() => browser.happyDOM.close())
function issue(owner: string, workspace: string, suffix: string): Issue {
  const prefix = owner === 'owner-one' ? workspace : `${owner}:${workspace}`
  return { id: `${workspace}-${suffix}`, title: `${prefix} task ${suffix}`, ownerId: owner, scope: 'workspace', status: 'todo', priority: 'normal', projectId: `${workspace}-project-${suffix}`,
    createdAt: '2026-11-07T00:00:00Z', updatedAt: '2026-11-07T00:00:00Z', checklist: { total: 0, checked: 0 },
    metadata: { assignee: { id: owner, kind: 'member', name: owner, image: null } satisfies NonNullable<Issue['metadata']['assignee']>, project: `${prefix} private project ${suffix}`, labels: [{ name: `${prefix} private label ${suffix}`, color: null }], pullRequests: [] } } as unknown as Issue
}
async function render({ owner = 'owner-one', workspace = 'workspace-one', visible = true, remount = false } = {}) {
  await act(async () => root.render(<ViewStateProvider scope={`${owner}:${workspace}`}>
    {visible && <BoardPage presentationRead={{ isLoading: false, mutate: async () => undefined }} key={remount ? `${owner}:${workspace}` : 'board'} issues={[issue(owner, workspace, 'one'), issue(owner, workspace, 'two')]} userId={owner} workspaceId={workspace} onOpen={nothing} onUpdated={async () => {}} onBusyChange={nothing} />}
  </ViewStateProvider>))
}
test('the Board reads Linear for the displayed workspace and account, including on manual refresh', async () => {
  const cache = new Map()
  const show = async (userId: string, workspaceId?: string) => act(async () => root.render(
    <SWRConfig value={{ provider: () => cache }}>
      <BoardPage issues={[]} userId={userId} workspaceId={workspaceId} presentationRead={{ isLoading: false, mutate: async () => undefined }}
        onOpen={nothing} onUpdated={async () => {}} onBusyChange={nothing} />
    </SWRConfig>))
  const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  syncReads.length = 0
  mappedWorkspace = 'workspace-one'
  await show('owner-one')
  assert.deepEqual(syncReads, [])
  await show('owner-one', 'workspace-one')
  assert.ok(button('synced'))
  await show('owner-one', 'workspace-two')
  assert.ok(button('refresh'))
  mappedWorkspace = 'workspace-two'
  await show('owner-two', 'workspace-two')
  assert.ok(button('synced'))
  mappedWorkspace = undefined
  await act(async () => button('synced')!.click())
  assert.ok(button('refresh'))
  assert.deepEqual(syncReads, ['workspace-one', 'workspace-two', 'workspace-two', 'workspace-two'])
})

test('a Board with an unresolved or failed Task presentation waits for the authorized projection before rendering cards', async () => {
  const task = issue('owner-one', 'workspace-one', 'one')
  let reads = 0
  const mutate = async () => { reads++ }
  const show = async (isLoading: boolean, error?: Error) => {
    await act(async () => root.render(<BoardPage issues={[task]} userId="owner-one" workspaceId="workspace-one"
      presentationRead={{ isLoading, error, mutate }} onOpen={nothing} onUpdated={async () => {}} onBusyChange={nothing} />))
  }
  await show(true)
  assert.equal(container.querySelector('[role="status"]')?.textContent, 'loading')
  assert.deepEqual(shown(), [])
  await show(false, new Error('temporarily unavailable'))
  const alert = container.querySelector('[role="alert"]')
  assert.match(alert?.textContent ?? '', /taskStatesReadFailed/)
  assert.deepEqual(shown(), [])
  await act(async () => alert!.querySelector('button')!.click())
  assert.equal(reads, 1)
  await show(false)
  assert.deepEqual(shown(), ['workspace-one task one'])
})

async function pick(label: string) {
  const choice = [...container.querySelectorAll<HTMLButtonElement>('button[role="menuitemcheckbox"]')].find(button => button.textContent === label)
  assert.ok(choice, `filter option ${label} exists in this workspace`)
  await act(async () => choice.click())
}
const chip = (field: string) => container.querySelector(`[role="group"][aria-label="filterField.${field}"]`)
const shown = () => [...container.querySelectorAll('[data-shown-issue]')].map(node => node.textContent)

for (const change of [{ owner: 'owner-one', workspace: 'workspace-two' }, { owner: 'owner-two', workspace: 'workspace-one' }]) test(`board filters stay inside ${change.owner === 'owner-one' ? 'their workspace' : 'their account'} while the original view remains recoverable`, async () => {
  await render()
  await pick('workspace-one private project one'); await pick('workspace-one private label one')
  assert.deepEqual(shown(), ['workspace-one task one'])
  await render({ visible: false }); await render()
  assert.ok(chip('project')?.textContent?.includes('workspace-one private project one'))
  await render(change)
  assert.equal(!!chip('project'), false, 'the new authority must not display the previous filter name as a chip fallback')
  assert.equal(!!chip('labels'), false)
  const prefix = change.owner === 'owner-one' ? change.workspace : `${change.owner}:${change.workspace}`
  assert.deepEqual(shown(), [`${prefix} task one`, `${prefix} task two`])
  await render({ ...change, remount: true })
  assert.equal(!!chip('project'), false)
  assert.equal(!!chip('labels'), false)
  await render({ remount: true })
  assert.ok(chip('project')?.textContent?.includes('workspace-one private project one'))
  assert.ok(chip('labels')?.textContent?.includes('workspace-one private label one'))
  assert.deepEqual(shown(), ['workspace-one task one'])
})

test('the Board shows every task by default, and a stored copy of the retired 负责人：我 default no longer hides tasks a bot holds', async () => {
  const held = { ...issue('owner-one', 'workspace-one', 'held'), metadata: { ...issue('owner-one', 'workspace-one', 'held').metadata, assignee: null } } as Issue
  const show = async () => act(async () => root.render(<ViewStateProvider scope="owner-one:workspace-one">
    <BoardPage presentationRead={{ isLoading: false, mutate: async () => undefined }} issues={[held]} userId="owner-one" workspaceId="workspace-one" onOpen={nothing} onUpdated={async () => {}} onBusyChange={nothing} />
  </ViewStateProvider>))
  await show()
  assert.deepEqual(shown(), ['workspace-one task held'])
  assert.equal(!!chip('assignee'), false)
  await act(async () => root.unmount()); root = createRoot(container)
  browser.sessionStorage.setItem('mikka:view:v1:owner-one:workspace-one:board:filters', JSON.stringify({ assignee: ['me'] }))
  await show()
  assert.deepEqual(shown(), ['workspace-one task held'], 'the old default is not a saved choice')
  await act(async () => root.unmount()); root = createRoot(container)
  browser.sessionStorage.setItem('mikka:view:v1:owner-one:workspace-one:board:filters', JSON.stringify({ assignee: ['me'], priority: ['normal'] }))
  await show()
  assert.deepEqual(shown(), [], 'a selection the person changed is kept')
  assert.ok(chip('assignee'))
})

test('a personal task sits on the Board with the workspace\'s other tasks, whatever scope an old browser preference names', async () => {
  browser.localStorage.setItem('mikka:board-v2', JSON.stringify({ scope: 'workspace', view: 'board' }))
  const personal = { ...issue('owner-one', 'workspace-one', 'personal'), scope: 'personal' } as Issue
  await act(async () => root.render(<ViewStateProvider scope="owner-one:workspace-one">
    <BoardPage presentationRead={{ isLoading: false, mutate: async () => undefined }} issues={[issue('owner-one', 'workspace-one', 'one'), personal]} userId="owner-one" workspaceId="workspace-one" onOpen={nothing} onUpdated={async () => {}} onBusyChange={nothing} />
  </ViewStateProvider>))
  assert.deepEqual(shown(), ['workspace-one task one', 'workspace-one task personal'])
})

test('legacy unscoped filter names are discarded while durable view and display preferences remain', async () => {
  const display = { sort: 'created', completed: 'all', showEmpty: false, properties: ['labels'], hidden: ['canceled'] }
  browser.localStorage.setItem('mikka:board-v2', JSON.stringify({ scope: 'workspace', view: 'list', filters: { project: ['Legacy private project'], labels: ['Legacy private label'] }, display }))
  await render()
  assert.equal(container.textContent?.includes('Legacy private'), false)
  assert.equal(container.querySelector('[data-board-view]')?.getAttribute('data-board-view'), 'list')
  assert.equal(container.querySelector('button[aria-label="viewList"]')?.getAttribute('aria-pressed'), 'true')
  assert.deepEqual(shown(), ['workspace-one task one', 'workspace-one task two'])
  const saved = JSON.parse(browser.localStorage.getItem('mikka:board-v2')!)
  assert.equal(saved.filters, undefined)
  assert.equal(saved.scope, undefined, 'the retired 全部 / 工作区 / 个人 segment is not kept')
  assert.deepEqual({ view: saved.view, display: saved.display }, { view: 'list', display })
})

test('changing browser display preferences never writes scoped filter names back into the shared preference key', async () => {
  await render()
  await pick('workspace-one private project one')
  await act(async () => (container.querySelector('button[aria-label="viewList"]') as HTMLButtonElement).click())
  assert.equal(container.querySelector('[data-board-view]')?.getAttribute('data-board-view'), 'list')
  const saved = JSON.parse(browser.localStorage.getItem('mikka:board-v2')!)
  assert.equal(saved.view, 'list')
  assert.equal(saved.filters, undefined, 'local browser preferences must not acquire workspace names again')
  await render({ owner: 'owner-two', workspace: 'workspace-two', remount: true })
  assert.equal(container.querySelector('[data-board-view]')?.getAttribute('data-board-view'), 'list')
  assert.equal(!!chip('project'), false)
})

test("the chips above the board are Capy's presets, and 为你 opens selected as it does there", async () => {
  const mine = issue('owner-one', 'workspace-one', 'mine')
  const theirs = issue('owner-two', 'workspace-one', 'theirs')
  const own = issue('owner-one', 'workspace-one', 'handed')
  const handed = { ...own, metadata: { ...own.metadata, assignee: { id: 'owner-two', kind: 'member', name: 'owner-two', image: null } } } as Issue
  const handedOver = issue('owner-two', 'workspace-one', 'delegated')
  const delegated = { ...handedOver, metadata: { ...handedOver.metadata, assignee: null, delegate: { id: 'agent-one', kind: 'agent', name: 'Agent', image: null } } } as Issue
  myAgentList = [{ id: 'agent-one' }]
  liveRuns = [{ issueId: 'workspace-one-held', bot: { id: 'bot-one', name: 'Coordinator', color: 'blue', shape: 'round' }, harnesses: [] }]
  const unassigned = issue('owner-two', 'workspace-one', 'held')
  const held = { ...unassigned, metadata: { ...unassigned.metadata, assignee: null } } as Issue
  // A cache of its own: the Agents read is what names my Captains, and an earlier test's empty list must not stand in
  // for it.
  await act(async () => root.render(<SWRConfig value={{ provider: () => new Map() }}>
    <ViewStateProvider scope="owner-one:workspace-one">
      <BoardPage presentationRead={{ isLoading: false, mutate: async () => undefined }} issues={[mine, theirs, handed, delegated, held]} userId="owner-one" workspaceId="workspace-one" onOpen={nothing} onUpdated={async () => {}} onBusyChange={nothing} />
    </ViewStateProvider>
  </SWRConfig>))
  const tabs = () => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
  const counts = () => Object.fromEntries(tabs().map(tab => [tab.textContent, Number(tab.dataset.count)]))
  const chosen = () => tabs().find(tab => tab.getAttribute('aria-selected') === 'true')?.textContent
  assert.deepEqual(tabs().map(tab => tab.textContent), ['scope.forYou', 'scope.assigned', 'scope.created', 'scope.all'],
    'Capy names five presets; Mikka records no mentions, so that one is not drawn')
  // Each count is what choosing the preset shows, under the filters that are on.
  assert.deepEqual(counts(), { 'scope.forYou': 4, 'scope.assigned': 1, 'scope.created': 2, 'scope.all': 5 })
  // Capy opens on For you, not on everything (Alex, 2026-11-19: 「这个东西肯定要按照 capy 对齐」).
  // For you is the union: assigned to me, created by me, delegated to an Agent I configured,
  // or my own Bot working on it — so `theirs`, which is none of those, is the one left out.
  assert.equal(chosen(), 'scope.forYou', 'the board opens on what concerns the reader, as Capy does')
  assert.deepEqual(shown(), ['workspace-one task mine', 'workspace-one task handed', 'owner-two:workspace-one task delegated', 'owner-two:workspace-one task held'])
  const choose = async (label: string) => {
    const tab = tabs().find(node => node.textContent === label)
    assert.ok(tab, `preset ${label} is drawn`)
    await act(async () => tab.click())
    assert.equal(chosen(), label)
  }
  // 分配给我 is the human assignee alone: a delegated task is not mine to answer for (#1687).
  await choose('scope.assigned')
  assert.deepEqual(shown(), ['workspace-one task mine'])
  // 我创建的 keeps a task assigned to someone else.
  await choose('scope.created')
  assert.deepEqual(shown(), ['workspace-one task mine', 'workspace-one task handed'])
  // 为你 is Capy's match=any union: mine, what I created, and what my Captains hold — an Agent I configured or a Bot
  // of mine running on it.
  await choose('scope.forYou')
  assert.deepEqual(shown(), ['workspace-one task mine', 'workspace-one task handed', 'owner-two:workspace-one task delegated', 'owner-two:workspace-one task held'])
  await choose('scope.all')
  assert.equal(shown().length, 5)
  assert.deepEqual(counts(), { 'scope.forYou': 4, 'scope.assigned': 1, 'scope.created': 2, 'scope.all': 5 }, 'a preset never changes what the others hold')
})
