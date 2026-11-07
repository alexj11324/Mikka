import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import React, { act, useEffect, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import * as swr from 'swr'
import { Window } from 'happy-dom'
import dynamic from '../../apps/desktop/src/renderer/dynamic'
import { useViewState } from '@/lib/hooks/view-state'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

const nothing = () => {}
const empty = () => null
const plain = ({ children }: { children?: ReactNode }) => <>{children}</>
const refreshed = async () => {}
const browser = new Window({ url: 'https://fixture.example/?workspace=workspace-one' })
let user = { id: 'owner-one', name: 'Fixture', email: 'fixture@example.com' }
let workspaceId = 'workspace-one'
const workspace = () => ({ currentUserId: user.id, workspace: { id: workspaceId, name: 'Fixture', kind: 'team' }, members: [], role: 'admin' })
const emptyList = { data: { items: [] }, mutate: refreshed }
const botList = { data: { items: [] } }
const router = { push: (href: string) => browser.history.pushState({}, '', href), replace: (href: string) => browser.history.replaceState({}, '', href), refresh: nothing }

mock.module('next-intl', { namedExports: { useTranslations: (namespace?: string) => Object.assign((key: string) => namespace ? `${namespace}.${key}` : key, { has: () => false }) } })
mock.module('next/navigation', { namedExports: { useSearchParams: () => new URLSearchParams(browser.location.search) } })
mock.module('@/i18n/navigation', { namedExports: { usePathname: () => browser.location.pathname, useRouter: () => router } })
mock.module('sonner', { namedExports: { toast: { error: nothing, dismiss: nothing } } })
mock.module('swr', { defaultExport: (key: unknown) => ({ data: key === '/api/workspace/switcher' ? { ...workspace(), live: { ownerId: user.id } } : [], mutate: refreshed }), namedExports: { SWRConfig: swr.SWRConfig, unstable_serialize: swr.unstable_serialize, useSWRConfig: swr.useSWRConfig } })
mock.module('@/lib/app-build', { namedExports: { APP_BUILD: '' } })
mock.module('@/lib/auth-client', { namedExports: { endSession: async () => ({}) } })
mock.module('@/lib/settings-data', { namedExports: { fetchSettingsData: refreshed } })
mock.module('@/lib/use-presence', { namedExports: { usePresence: (open: boolean) => ({ value: open, open, onOpenChangeComplete: nothing }) } })
mock.module('@/hooks/use-workspace', { namedExports: { useWorkspace: () => ({ data: workspace() }) } })
mock.module('@/hooks/use-agent-history', { namedExports: { useAgentHistory: () => ({ data: { sessions: [] } }) } })
mock.module('@/hooks/use-focus-return', { namedExports: { focusChatComposer: nothing } })
mock.module('@/hooks/use-live-key', { namedExports: { LiveProvider: plain, useLiveKey: nothing } })
mock.module('@/hooks/use-live-lists', { namedExports: {
  useLiveIssueList: () => emptyList, useLiveThreadList: () => emptyList,
  useLiveBotRoster: () => botList, useLiveBotChatList: () => ({ data: { items: {} } }), useLiveGroupList: () => ({ data: [] }),
} })
for (const [file, names] of [
  ['../../app/actions/projects.ts', ['listProjects']], ['../../app/actions/teams.ts', ['listTeams']],
  ['../../app/actions/team-relations.ts', ['listProjectTeams']], ['../../app/actions/workspace-secrets.ts', ['saveE2BKey']],
  ['../../app/actions/bots.ts', ['listBots']], ['../../app/actions/agents.ts', ['getThreadName']],
] as const) mock.module(new URL(file, import.meta.url).href, { namedExports: Object.fromEntries(names.map(name => [name, async () => []])) })

// Exercise the production lazy/Suspense boundary, with its chunk deliberately
// unresolved while checking the frame. Page/data leaves are unrelated here.
let chunkReady: Promise<void>
let releaseChunk: () => void
const delayedDynamic: typeof dynamic = (loader, options) => dynamic(async () => { await chunkReady; return loader() }, options)
mock.module('next/dynamic', { defaultExport: delayedDynamic })
for (const [file, names] of [
  ['../nav/bot-list.tsx', ['BotList']], ['../nav/new-bot-dialog.tsx', ['NewBotDialog']],
  ['../onboarding/onboarding.tsx', ['Onboarding']], ['../teams/team-home.tsx', ['TeamHome']],
  ['./issue-list.tsx', ['IssueList']], ['./board-page.tsx', ['BoardPage']],
  ['../nav/context-panel.tsx', ['ContextPanel']],
  ['../nav/group-panel.tsx', ['GroupPanel']], ['../nav/conversation-pill.tsx', ['ConversationPillButton']],
  ['../nav/group-avatar.tsx', ['GroupPillAvatar']], ['../browser/browser-pane.tsx', ['BrowserPane']],
  ['./thread-column.tsx', ['ThreadColumn']], ['./group-chat-view.tsx', ['GroupChatView']],
  ['../plugins/plugins-view.tsx', ['PluginsPage']], ['../suggestions/suggestion-feed.tsx', ['SuggestionFeed']],
  ['../artifacts/artifact-library.tsx', ['ArtifactLibrary']], ['./legacy-chat-archive.tsx', ['LegacyChatArchive']],
  ['./create-issue-dialog.tsx', ['CreateIssueDialog']],
] as const) mock.module(new URL(file, import.meta.url).href, { namedExports: Object.fromEntries(names.map(name => [name, empty])) })
mock.module('@/components/nav/thread-list', { namedExports: { threadName: () => '' } })
mock.module('@/components/nav/bot-avatar', { namedExports: { BotAvatar: empty, COORDINATOR_AVATAR: {} } })
mock.module('@/components/nav/all-threads', { namedExports: { AllThreadsColumn: empty, AllThreadsToggle: empty, waitingCount: () => 0 } })
mock.module('@/components/browser/browser-toggle', { namedExports: { useBrowserFits: () => true, BrowserToggle: ({ onToggle }: { onToggle: () => void }) => <Button onClick={onToggle}>browser</Button> } })
mock.module('@/components/ui/sheet', { namedExports: { Sheet: empty, SheetContent: plain, SheetHeader: plain, SheetTitle: plain, SheetDescription: plain } })
mock.module('@/components/nav/global-search', { namedExports: { GlobalSearch: ({ open }: { open: boolean }) => open ? <div data-search-open="" /> : null, SearchPill: ({ onSearch }: { onSearch: () => void }) => <Button onClick={onSearch}>search</Button> } })
mock.module('@/components/coordinator/new-task-dialog', { namedExports: { NewTaskDialog: ({ open }: { open: boolean }) => open ? <div data-new-task-open="" /> : null } })
let railMounts = 0
mock.module('@/components/nav/icon-rail', { namedExports: { IconRail: ({ onSettings, onNavigate }: { onSettings: () => void; onNavigate: (destination: 'chats') => void }) => {
  useEffect(() => { railMounts++ }, [])
  return <div role="navigation" aria-label="Main navigation"><Button onClick={() => onSettings()}>settings</Button><Button onClick={() => onNavigate('chats')}>chats</Button></div>
} } })

let useBrowserNotes: typeof import('../browser/browser-notes')['useBrowserNotes']
let useBrowserNotesComposer: typeof import('../browser/browser-notes')['useBrowserNotesComposer']
let notes: ReturnType<typeof useBrowserNotes>
let editDraft: (value: string) => void
let composerMounts = 0, composerUnmounts = 0
function Conversation() {
  notes = useBrowserNotesComposer(true)
  const [draft, setDraft] = useViewState('settings-fixture:draft', '')
  editDraft = setDraft
  useEffect(() => { composerMounts++; return () => { composerUnmounts++ } }, [])
  return <Textarea aria-label="composer" value={draft} onChange={event => setDraft(event.target.value)} />
}
mock.module('./workspace-overview', { namedExports: { WorkspaceOverview: Conversation } })
mock.module('@/components/settings/settings-view', { namedExports: { SettingsView: ({ activeSection, initialSection, selectedTeamId, children, onRail }: { activeSection?: string; initialSection?: string; selectedTeamId?: string; children?: ReactNode; onRail: (destination: 'chats') => void }) => {
  notes = useBrowserNotes()
  return <main data-settings-section={activeSection ?? initialSection} data-team={selectedTeamId}><Button onClick={() => onRail('chats')}>leave settings</Button>{children}</main>
} } })
mock.module('@/components/teams/team-directory', { namedExports: { TeamDirectory: ({ workspaceId: id }: { workspaceId: string }) => <div data-team-workspace={id} /> } })
mock.module('@/components/workspace/members-settings', { namedExports: { MembersSettings: ({ workspaceId: id, inviteInitially }: { workspaceId: string; inviteInitially: boolean }) => <div data-members-workspace={id} data-invite={inviteInitially} /> } })

let container: HTMLDivElement, root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let IssueWorkspace: typeof import('./issue-workspace')['IssueWorkspace']
let SettingsShell: typeof import('../settings/settings-shell')['SettingsShell']
before(async () => {
  for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'ResizeObserver', 'navigator'] as const) Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? browser : browser[key] })
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: browser.getComputedStyle.bind(browser) })
  // The desktop tsconfig leaves JSX to its bundler; tsx uses classic JSX for
  // that one imported adapter while the root components use the JSX runtime.
  Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ useBrowserNotes, useBrowserNotesComposer } = await import('../browser/browser-notes'))
  ;({ IssueWorkspace } = await import('./issue-workspace'))
  ;({ SettingsShell } = await import('../settings/settings-shell'))
})
beforeEach(() => {
  user = { id: 'owner-one', name: 'Fixture', email: 'fixture@example.com' }
  workspaceId = 'workspace-one'
  browser.history.replaceState({}, '', '/?workspace=workspace-one')
  browser.localStorage.clear(); browser.sessionStorage.clear()
  notes = null; railMounts = 0; composerMounts = 0; composerUnmounts = 0
  chunkReady = new Promise(resolve => { releaseChunk = resolve })
  container = browser.document.createElement('div') as unknown as HTMLDivElement
  document.body.append(container); root = createRoot(container)
})
afterEach(async () => { releaseChunk(); await act(async () => root.unmount()); container.remove() })
after(() => browser.happyDOM.close())

const render = async (props: Partial<Parameters<typeof IssueWorkspace>[0]> = {}) => { await act(async () => root.render(<IssueWorkspace user={user} {...props} />)) }
const frame = () => container.querySelector('[data-slot="app-frame-content"]')
const bar = () => container.querySelector('[data-slot="window-bar"]')
const rail = () => container.querySelector('[role="navigation"][aria-label="Main navigation"]')
const button = (text: string) => [...container.querySelectorAll('button')].find(node => node.textContent === text)!
const pin = async (text: string) => { await act(async () => notes!.add({ kind: 'element', url: 'https://fixture.example/page', label: 'Fixture element', selector: '#fixture', note: text })) }
async function go(href: string) {
  browser.history.pushState({}, '', href)
  await render()
}

test('a cold Settings chunk keeps the same frame, bar and rail; returning keeps pending browser notes and draft', async () => {
  await render()
  const original = { frame: frame(), bar: bar(), rail: rail() }
  assert.ok(original.frame && original.bar && original.rail)
  await pin('keep this annotation')
  await act(async () => editDraft('unsent draft'))
  assert.equal(notes?.hasComposer, true)
  await act(async () => button('settings').click())
  await render()
  assert.equal(browser.location.pathname, '/settings')
  assert.ok(frame() === original.frame, 'cold Settings must not replace the app frame with a full-window loader')
  assert.ok(bar() === original.bar, 'the window bar DOM node must survive Settings navigation')
  assert.ok(rail() === original.rail, 'the rail DOM node must survive Settings navigation')
  assert.ok(original.frame.querySelector('[data-loading-placeholder]'))
  assert.equal(composerUnmounts, 1)

  await act(async () => { releaseChunk(); await chunkReady })
  assert.ok(container.querySelector('[data-settings-section="preferences"]'))
  assert.equal(notes?.hasComposer, false, 'the unmounted composer must unregister while Settings is shown')
  assert.ok(frame() === original.frame, 'the frame DOM node must survive Settings navigation')
  assert.equal(railMounts, 1)
  await go('/settings/teams?workspace=workspace-one&team=team-one')
  assert.equal(container.querySelector('[data-team-workspace]')?.getAttribute('data-team-workspace'), workspaceId)
  assert.equal(container.querySelector('[data-settings-section]')?.getAttribute('data-team'), 'team-one')
  await go('/settings/members?workspace=workspace-one&invite=1')
  assert.equal(container.querySelector('[data-invite]')?.getAttribute('data-invite'), 'true')

  await act(async () => button('chats').click())
  await render()
  assert.ok(frame() === original.frame, 'the frame DOM node must survive Settings navigation')
  assert.ok(bar() === original.bar, 'the window bar DOM node must survive Settings navigation')
  assert.ok(rail() === original.rail, 'the rail DOM node must survive Settings navigation')
  assert.equal(railMounts, 1)
  assert.equal(composerMounts, 2)
  assert.equal(notes?.hasComposer, true)
  assert.equal(container.querySelector('textarea')?.value, 'unsent draft')
  assert.deepEqual(notes?.notes.map(note => [note.n, note.note]), [[1, 'keep this annotation']])
  await pin('next annotation')
  assert.deepEqual(notes?.notes.map(note => note.n), [1, 2])
  await go('/settings?workspace=workspace-one')
  assert.equal(notes?.hasComposer, false, 'a second visit must not retain a duplicate composer registration')
  assert.equal(railMounts, 1)
})

test('legacy Settings also loads inside the frame and keeps it when returning to chat', async () => {
  await render({ initialSettingsSection: 'account' })
  const original = { frame: frame(), bar: bar(), rail: rail() }
  assert.ok(original.frame && original.bar && original.rail, 'legacy Settings must retain the real shell while its chunk loads')
  assert.ok(original.frame.querySelector('[data-loading-placeholder]'))
  await act(async () => { releaseChunk(); await chunkReady })
  assert.ok(container.querySelector('[data-settings-section="account"]'))
  await act(async () => button('chats').click())
  await render()
  assert.ok(container.querySelector('textarea'))
  assert.ok(frame() === original.frame, 'the frame DOM node must survive Settings navigation')
  assert.ok(bar() === original.bar, 'the window bar DOM node must survive Settings navigation')
  assert.ok(rail() === original.rail, 'the rail DOM node must survive Settings navigation')
  assert.equal(railMounts, 1)
})

for (const legacy of [false, true]) test(`${legacy ? 'legacy' : 'routed'} Settings keyboard search follows the top bar and leaves other workspace shortcuts inactive`, async () => {
  releaseChunk()
  await render(legacy ? { initialSettingsSection: 'account' } : {})
  if (!legacy) await go('/settings?workspace=workspace-one')
  assert.ok(container.querySelector('[data-settings-section]'))
  const original = frame()
  const key = async (value: string, options: { metaKey?: boolean; ctrlKey?: boolean; isComposing?: boolean } = {}) => {
    const event = new browser.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options })
    await act(async () => { browser.dispatchEvent(event) })
    return event
  }
  await key('c')
  assert.equal(container.querySelector('[data-new-task-open]'), null)
  const modifier = legacy ? { ctrlKey: true } : { metaKey: true }
  await key('k', { ...modifier, isComposing: true })
  assert.equal(container.querySelector('[data-search-open]'), null)
  const dialog = browser.document.createElement('div') as unknown as HTMLDivElement
  dialog.setAttribute('role', 'dialog'); dialog.setAttribute('data-open', '')
  container.append(dialog)
  await key('k', modifier)
  assert.equal(container.querySelector('[data-search-open]'), null)
  dialog.remove()

  const event = await key('k', modifier)
  await render()
  assert.equal(event.defaultPrevented, true)
  assert.equal(browser.location.pathname, '/')
  assert.equal(new URLSearchParams(browser.location.search).get('workspace'), workspaceId)
  assert.equal(container.querySelector('[data-settings-section]'), null)
  assert.ok(container.querySelector('[data-search-open]'), 'Settings search shortcut must open the same search as the top-bar button')
  assert.ok(frame() === original)
  assert.equal(railMounts, 1)
})

test('the existing authenticated scope boundary still discards annotations across owners and workspaces', async () => {
  releaseChunk()
  await render()
  await pin('owner one private note')
  user = { ...user, id: 'owner-two', email: 'second@example.com' }
  await render()
  assert.equal(notes?.notes.length, 0)
  await pin('workspace one private note')
  workspaceId = 'workspace-two'
  await go('/?workspace=workspace-two')
  assert.equal(notes?.notes.length, 0)
  await pin('workspace two note')
  assert.deepEqual(notes?.notes.map(note => [note.n, note.note]), [[1, 'workspace two note']])
})

test('a standalone Settings shell still provides its frame and route-specific members content', async () => {
  browser.history.replaceState({}, '', '/settings/members?workspace=workspace-one&invite=1')
  await act(async () => root.render(<SettingsShell user={user} />))
  assert.equal(container.querySelectorAll('[data-slot="app-frame-content"]').length, 1)
  assert.ok(bar() && rail())
  assert.equal(container.querySelector('[data-settings-section]')?.getAttribute('data-settings-section'), 'members')
  assert.equal(container.querySelector('[data-members-workspace]')?.getAttribute('data-members-workspace'), workspaceId)
  assert.equal(container.querySelector('[data-invite]')?.getAttribute('data-invite'), 'true')
})
