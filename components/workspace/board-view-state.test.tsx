import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, createContext, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'
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
mock.module('next-intl', { namedExports: { useTranslations: () => translate } })
mock.module('swr', { defaultExport: () => ({ data: undefined }) })
mock.module('@/hooks/use-task-collection', { namedExports: { TaskPresentationsContext: createContext({}) } })
mock.module('@/hooks/use-live-lists', { namedExports: { useLiveTaskRunList: () => ({ data: undefined }) } })
mock.module('@/hooks/use-list-expiry', { namedExports: { useListExpiry: nothing } })
mock.module('@/app/actions/agents', { namedExports: { listAgents: async () => [] } })
mock.module('@/app/actions/linear-sync', { namedExports: { getLinearBoardSync: async () => ({ synced: false }) } })
mock.module('@/components/nav/bot-avatar', { namedExports: { CoordinatorAvatar: empty } })
mock.module('@/components/nav/conversation-pill', { namedExports: { ConversationPill: empty } })
mock.module('@/components/coordinator/coordinator-chat', { namedExports: { CoordinatorChat: empty } })
mock.module('@/components/coordinator/new-task-dialog', { namedExports: { NewTaskDialog: empty } })
mock.module('@/components/ui/sheet', { namedExports: { Sheet: empty, SheetContent: Pass, SheetHeader: Pass, SheetTitle: Pass } })
// The test adapter exposes the public slot callbacks. The official renderer
// is exercised in the companion repository without copying its implementation.
mock.module('./board-screen', { namedExports: { BoardScreenView: ({ issues, view, onView, filterItems }: Pick<BoardScreenProps, 'view' | 'onView' | 'filterItems'> & { issues: Issue[] }) =>
  <div data-board-view={view}>
    <Button aria-label="viewList" aria-pressed={view === 'list'} onClick={() => onView('list')}>List</Button>
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
    {visible && <BoardPage key={remount ? `${owner}:${workspace}` : 'board'} issues={[issue(owner, workspace, 'one'), issue(owner, workspace, 'two')]} userId={owner} workspaceId={workspace} onOpen={nothing} onUpdated={async () => {}} onBusyChange={nothing} />}
  </ViewStateProvider>))
}
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
  assert.deepEqual({ scope: saved.scope, view: saved.view, display: saved.display }, { scope: 'workspace', view: 'list', display })
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
