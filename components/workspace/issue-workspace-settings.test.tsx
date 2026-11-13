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
import type { ComputerThread } from '@/components/computer/computer-agents'
import type { SettingsFrameProps } from '@/components/slots/settings-frame-contract'
import { browserAddressRequest, consumeBrowserAddress, openBrowserAddress } from '@/lib/browser/navigation'

const nothing = () => {}
const empty = () => null
const plain = ({ children }: { children?: ReactNode }) => <>{children}</>
const refreshed = async () => {}
const browser = new Window({ url: 'https://fixture.example/?workspace=workspace-one' })
let user = { id: 'owner-one', name: 'Fixture', email: 'fixture@example.com' }
let workspaceId = 'workspace-one'
let workspaceReady = true
let workspaceError: Error | undefined
let groupList: { id: string; title: string; workspaceId: string }[] = []
let groupListError: Error | undefined
let groupListRetries = 0
const teamIssuesId = '8055a7ae-204f-4045-8780-66b9c93ce229'
let scopedTeamFixture = false
let workspaceTasksPending = false
let scopedTasksPending = false
let scopedTeamPageMutations = 0
let probeEmbeddedAck = false
let acknowledgeNewTask: ((id: string) => void) | null = null
const workspace = () => ({ currentUserId: user.id, workspace: { id: workspaceId, name: 'Fixture', kind: 'team' }, members: [], role: 'admin' })
const emptyList = { data: { items: [] }, mutate: refreshed }
const bot = { id: '3f0c9d2e-5b1a-4c7e-9f00-1a2b3c4d5e6f', name: 'Ada', coordinator: false }
const botList = { data: { items: [bot] } }
const router = { push: (href: string) => browser.history.pushState({}, '', href), replace: (href: string) => browser.history.replaceState({}, '', href), refresh: nothing }

mock.module('next-intl', { namedExports: { useLocale: () => 'en', useTranslations: (namespace?: string) => Object.assign((key: string) => namespace ? `${namespace}.${key}` : key, { has: () => false }) } })
mock.module('next/navigation', { namedExports: { useSearchParams: () => new URLSearchParams(browser.location.search) } })
mock.module('@/i18n/navigation', { namedExports: { getPathname: ({ href }: { href: string }) => href, usePathname: () => browser.location.pathname, useRouter: () => router } })
mock.module('sonner', { namedExports: { toast: { error: nothing, dismiss: nothing } } })
mock.module('swr', { defaultExport: (key: unknown) => ({
  data: key === '/api/workspace/switcher' ? { ...workspace(), live: { ownerId: user.id } }
    : key === 'teams' && scopedTeamFixture ? [{ id: teamIssuesId, name: 'Scoped Team' }]
    : Array.isArray(key) && key[0] === 'team-issues-page' ? { items: [], next: null }
    : [],
  isLoading: Array.isArray(key) && key[0] === 'team-issues-page' ? scopedTasksPending : false,
  mutate: Array.isArray(key) && key[0] === 'team-issues-page' ? async () => { scopedTeamPageMutations++ } : refreshed,
}), namedExports: { SWRConfig: swr.SWRConfig, unstable_serialize: swr.unstable_serialize, useSWRConfig: swr.useSWRConfig } })
mock.module('@/lib/app-build', { namedExports: { APP_BUILD: '' } })
mock.module('@/lib/auth-client', { namedExports: { endSession: async () => ({}), authClient: { getSession: async () => ({ data: { user } }), useSession: () => ({ data: null }) } } })
mock.module('@/lib/settings-data', { namedExports: { fetchSettingsData: refreshed } })
mock.module('@/lib/use-presence', { namedExports: { usePresence: (open: boolean) => ({ value: open, open, onOpenChangeComplete: nothing }) } })
mock.module('@/hooks/use-workspace', { namedExports: { useWorkspace: () => ({ data: workspaceReady ? workspace() : undefined, error: workspaceError, mutate: async () => { workspaceError = undefined; workspaceReady = true } }) } })
mock.module('@/hooks/use-agent-history', { namedExports: { useAgentHistory: () => ({ data: { sessions: [] } }) } })
mock.module('@/hooks/use-focus-return', { namedExports: { focusChatComposer: nothing, useOpenerFocus: () => () => true } })
mock.module('@/hooks/use-live-key', { namedExports: { LiveProvider: plain, useLiveKey: nothing, useLiveKeys: nothing, useLiveScope: () => null } })
mock.module('@/hooks/use-live-lists', { namedExports: {
  useLiveIssueList: () => ({ ...emptyList, isLoading: workspaceTasksPending }), useLiveThreadList: () => emptyList,
  useLiveBotRoster: () => botList, useLiveBotChatList: () => ({ data: { items: {} } }), useLiveGroupList: () => ({
    data: groupList,
    error: groupListError,
    mutate: async () => { groupListRetries++; groupListError = undefined },
  }),
} })
for (const [file, names] of [
  ['../../app/actions/projects.ts', ['listProjects', 'listWorkspaceProjects']], ['../../app/actions/teams.ts', ['listTeams']],
  ['../../app/actions/team-relations.ts', ['listProjectTeams']], ['../../app/actions/workspace-secrets.ts', ['saveE2BKey']],
  ['../../app/actions/bots.ts', ['listBots']], ['../../app/actions/agents.ts', ['getThreadName', 'findThreadIssue']],
] as const) mock.module(new URL(file, import.meta.url).href, { namedExports: Object.fromEntries(names.map(name => [name, async () => []])) })

// Exercise the production lazy/Suspense boundary, with its chunk deliberately
// unresolved while checking the frame. Page/data leaves are unrelated here.
let chunkReady: Promise<void>
let releaseChunk: () => void
const delayedDynamic: typeof dynamic = (loader, options) => dynamic(async () => { await chunkReady; return loader() }, options)
mock.module('next/dynamic', { defaultExport: delayedDynamic })
for (const [file, names] of [
  // The real app-frame slot also exports an unused rail; its account menu is outside this shell-state fixture.
  ['../workspace-menu.tsx', ['WorkspaceMenu']],
  ['../nav/new-bot-dialog.tsx', ['NewBotDialog']],
  ['../onboarding/onboarding.tsx', ['Onboarding']], ['../teams/team-home.tsx', ['TeamHome']],
  ['./issue-list.tsx', ['IssueList']], ['./board-page.tsx', ['BoardPage']],
  ['../nav/context-panel.tsx', ['ContextPanel']],
  ['../nav/group-panel.tsx', ['GroupPanel']], ['../nav/conversation-pill.tsx', ['ConversationPillButton']],
  ['../nav/group-avatar.tsx', ['GroupPillAvatar']],
  ['./thread-column.tsx', ['ThreadColumn']], ['./task-column.tsx', ['TaskColumn']],
  ['../plugins/plugins-view.tsx', ['PluginsPage']], ['../suggestions/suggestion-feed.tsx', ['SuggestionFeed', 'SuggestionsRefresh', 'useSuggestionCount']],
  ['../artifacts/artifact-library.tsx', ['ArtifactLibrary']], ['./legacy-chat-archive.tsx', ['LegacyChatArchive']],
] as const) mock.module(new URL(file, import.meta.url).href, { namedExports: Object.fromEntries(names.map(name => [name, name === 'useSuggestionCount' ? () => 0 : name === 'BoardPage' ? () => <section data-team-board-visible="">{probeEmbeddedAck && <EmbeddedSaveProbe />}</section> : empty])) })
// The Team detail fixture exercises acknowledged save/delete callbacks, not a fake list mutation.
mock.module(new URL('./task-detail.tsx', import.meta.url).href, { namedExports: {
  TaskDetail: ({ id, onSaved, onDeleted }: { id: string; onSaved: (id: string) => void; onDeleted: () => void }) =>
    <section data-team-task-detail=""><Button data-detail-save="" onClick={() => onSaved(id)}>save task</Button><Button data-detail-delete="" onClick={onDeleted}>delete task</Button></section>,
} })
mock.module('./group-chat-view', { namedExports: {
  GroupChatView: ({ group }: { group: { id: string } }) => <section data-open-group={group.id} />,
} })
mock.module('../browser/browser-pane', { namedExports: { BrowserPane: () => <section data-browser-pane="" /> } })
mock.module('@/components/nav/new-group-dialog', { namedExports: {
  NewGroupDialog: ({ open, workspaceId }: { open: boolean; workspaceId: string }) => open ? <div data-create-group={workspaceId} /> : null,
} })
mock.module('@/components/nav/bot-list', { namedExports: { BotList: () => <div data-retired-bot-list="" />, useChatNav: () => ({ entries: [], reloadGroups: async () => {} }) } })
mock.module('@/components/nav/thread-list', { namedExports: { threadName: () => '' } })
mock.module('@/components/nav/bot-avatar', { namedExports: { BotAvatar: empty, COORDINATOR_AVATAR: {} } })
mock.module('@/components/nav/all-threads', { namedExports: { AllThreadsColumn: empty, AllThreadsToggle: empty } })
mock.module('@/components/browser/browser-toggle', { namedExports: { useBrowserFits: () => true, BrowserToggle: ({ onToggle }: { onToggle: () => void }) => <Button onClick={onToggle}>browser</Button> } })
mock.module('@/components/ui/sheet', { namedExports: { Sheet: empty, SheetContent: plain, SheetHeader: plain, SheetTitle: plain, SheetDescription: plain } })
mock.module('@/components/nav/global-search', { namedExports: { GlobalSearch: ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) => open ? <div data-search-open=""><Button onClick={() => onOpenChange(false)}>dismiss search</Button></div> : null, SearchPill: ({ onSearch }: { onSearch: () => void }) => <Button onClick={onSearch}>search</Button> } })
mock.module('@/components/coordinator/new-task-dialog', { namedExports: { NewTaskDialog: ({ open, onCreated }: { open: boolean; onCreated: (id: string) => void }) => {
  acknowledgeNewTask = onCreated
  return open ? <div data-new-task-open="" /> : null
} } })
let railMounts = 0
mock.module('@/components/nav/icon-rail', { namedExports: { IconRail: ({ onSettings, onNavigate, chats }: { onSettings: () => void; onNavigate: (destination: 'chats') => void; chats?: { onNewGroup: () => void } }) => {
  useEffect(() => { railMounts++ }, [])
  return <div role="navigation" aria-label="Main navigation"><Button onClick={() => onSettings()}>settings</Button><Button onClick={() => onNavigate('chats')}>chats</Button>{chats && <Button onClick={chats.onNewGroup}>new group</Button>}</div>
} } })

let useBrowserNotes: typeof import('../browser/browser-notes')['useBrowserNotes']
let useBrowserNotesComposer: typeof import('../browser/browser-notes')['useBrowserNotesComposer']
let useConversationPanels: typeof import('../coordinator/conversation-panels')['useConversationPanels']
let EmbeddedTaskLifecycleContext: typeof import('../coordinator/conversation-panels')['EmbeddedTaskLifecycle']
function EmbeddedSaveProbe() {
  const lifecycle = React.useContext(EmbeddedTaskLifecycleContext)
  return <Button data-embedded-save-ack="" onClick={() => lifecycle?.onSaved('8055a7ae-204f-4045-8780-66b9c93ce232')}>save embedded Task</Button>
}
let notes: ReturnType<typeof useBrowserNotes>
let ComputerConversation: typeof import('../computer/computer-agents')['ComputerConversation']
let useConversationThread: typeof import('../computer/computer-agents')['useConversationThread']
let useRegisterComputerThread: typeof import('../computer/computer-agents')['useRegisterComputerThread']
const conversationId = 'fixture-conversation'
const registeredComputerThread: ComputerThread = { botId: bot.id, botName: bot.name, runId: 'fixture-computer-run', name: 'Fixture computer thread' }
let registerComputer = false
let computerThread: ComputerThread | null = null
function RegisterComputerThread() {
  useRegisterComputerThread(registeredComputerThread)
  return null
}
let editDraft: (value: string) => void
let composerMounts = 0, composerUnmounts = 0
let reportWorkTask: ((taskId: string | null) => void) | undefined
function Conversation({ bot: activeBot }: { bot?: { id: string; name: string } }) {
  const panels = useConversationPanels()
  reportWorkTask = panels?.onActiveTask
  notes = useBrowserNotesComposer(true)
  computerThread = useConversationThread(conversationId)
  const [draft, setDraft] = useViewState(`settings-fixture:${activeBot?.id ?? 'coordinator'}:draft`, '')
  editDraft = setDraft
  useEffect(() => { composerMounts++; return () => { composerUnmounts++ } }, [])
  return <>{registerComputer && <ComputerConversation id={conversationId}><RegisterComputerThread /></ComputerConversation>}<p>Cached conversation</p><Textarea aria-label="composer" data-chat={activeBot?.name ?? 'Coordinator'} value={draft} onChange={event => setDraft(event.target.value)} />{panels?.revealId === 'browser' && panels.tabs.find(tab => tab.id === 'browser')?.content}</>
}
mock.module('./workspace-overview', { namedExports: { WorkspaceOverview: Conversation } })
mock.module('@/components/settings/settings-view', { namedExports: { SettingsView: ({ activeSection, initialSection, selectedTeamId, workspaceId: id, inviteInitially, onRail }: { activeSection?: string; initialSection?: string; selectedTeamId?: string; workspaceId?: string; inviteInitially?: boolean; onRail: (destination: 'chats') => void }) => {
  notes = useBrowserNotes()
  computerThread = useConversationThread(conversationId)
  return <main data-settings-section={activeSection ?? initialSection} data-team={selectedTeamId} data-workspace={id} data-invite={inviteInitially}><Button onClick={() => onRail('chats')}>leave settings</Button></main>
} } })

let container: HTMLDivElement, root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let IssueWorkspace: typeof import('./issue-workspace')['IssueWorkspace']
let HostedIssueWorkspace: typeof IssueWorkspace
let OfficialIssueWorkspace: typeof IssueWorkspace
let SettingsShell: typeof import('../settings/settings-shell')['SettingsShell']
let closeReview: typeof import('@/hooks/code-review/use-review-page')['closeReview']
mock.module(new URL('../slots/review-summary.tsx', import.meta.url).href, { namedExports: { REVIEW_ENABLED: true, ReviewSummaryLine: empty } })
mock.module(new URL('../slots/review-page.tsx', import.meta.url).href, { namedExports: { ReviewPage: ({ taskId }: { taskId: string }) => <p data-review-task={taskId}>Review</p> } })
before(async () => {
  for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'ResizeObserver', 'navigator'] as const) Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? browser : browser[key] })
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: browser.getComputedStyle.bind(browser) })
  // The desktop tsconfig leaves JSX to its bundler; tsx uses classic JSX for
  // that one imported adapter while the root components use the JSX runtime.
  Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ useBrowserNotes, useBrowserNotesComposer } = await import('../browser/browser-notes'))
  ;({ useConversationPanels, EmbeddedTaskLifecycle: EmbeddedTaskLifecycleContext } = await import('../coordinator/conversation-panels'))
  ;({ closeReview } = await import('@/hooks/code-review/use-review-page'))
  ;({ ComputerConversation, useConversationThread, useRegisterComputerThread } = await import('../computer/computer-agents'))
  ;({ IssueWorkspace } = await import('./issue-workspace'))
  ;({ SettingsShell } = await import('../settings/settings-shell'))
  // Exercise the hosted contract without importing private UI. The original
  // module keeps the default slot; the second module gets a distinct frame.
  mock.module(new URL('../slots/settings-frame.tsx', import.meta.url).href, { namedExports: {
    OWN_SETTINGS_FRAME: true,
    SettingsFrame: ({ children, onRail }: SettingsFrameProps) => <section data-hosted-settings-frame=""><Button onClick={() => onRail('chats')}>hosted chats</Button>{children}</section>,
  } })
  const hostedModule = new URL('./issue-workspace.tsx?hosted-provider-test', import.meta.url).href
  ;({ IssueWorkspace: HostedIssueWorkspace } = await import(hostedModule))
  const shell = await import('../app-shell')
  mock.module('../app-shell', { namedExports: { ...shell, FRAME_OWNS_PANEL: true, FRAME_LISTS_CHATS: undefined } })
  ;({ IssueWorkspace: OfficialIssueWorkspace } = await import(new URL('./issue-workspace.tsx?browser-panel-test', import.meta.url).href))
})
beforeEach(() => {
  closeReview(); reportWorkTask = undefined
  const pendingAddress = browserAddressRequest()
  if (pendingAddress) consumeBrowserAddress(pendingAddress)
  user = { id: 'owner-one', name: 'Fixture', email: 'fixture@example.com' }
  workspaceId = 'workspace-one'
  workspaceReady = true
  workspaceError = undefined
  groupList = []
  groupListError = undefined
  groupListRetries = 0
  scopedTeamFixture = false; workspaceTasksPending = false; scopedTasksPending = false; scopedTeamPageMutations = 0; acknowledgeNewTask = null; probeEmbeddedAck = false
  browser.history.replaceState({}, '', '/?workspace=workspace-one')
  browser.localStorage.clear(); browser.sessionStorage.clear()
  notes = null; railMounts = 0; composerMounts = 0; composerUnmounts = 0
  registerComputer = false; computerThread = null
  chunkReady = new Promise(resolve => { releaseChunk = resolve })
  container = browser.document.createElement('div') as unknown as HTMLDivElement
  document.body.append(container); root = createRoot(container)
})
afterEach(async () => { releaseChunk(); await act(async () => root.unmount()); container.remove() })
after(() => browser.happyDOM.close())

test('a valid browser request from a board clears only competing columns and opens the existing browser', async () => {
  const selectedRun = '00000000-0000-4000-8000-000000000021'
  browser.history.replaceState({}, '', `/?workspace=workspace-one&account=active&section=all-issues&thread=${selectedRun}&task=${selectedRun}&threads=all`)
  await act(async () => root.render(<OfficialIssueWorkspace user={user} initialSection="all-issues" />))
  await act(async () => assert.equal(openBrowserAddress('/preview'), true))
  assert.equal(container.querySelectorAll('[data-browser-pane]').length, 1)
  const params = new URL(browser.location.href).searchParams
  assert.equal(params.get('section'), 'all-issues')
  assert.equal(params.get('workspace'), 'workspace-one')
  assert.equal(params.get('account'), 'active')
  for (const key of ['task', 'thread', 'threads']) assert.equal(params.has(key), false)
})

test('a valid browser request reveals the conversation browser tab without changing the selected Bot', async () => {
  browser.history.replaceState({}, '', `/?workspace=workspace-one&account=active&bot=${bot.id}`)
  await act(async () => root.render(<OfficialIssueWorkspace user={user} />))
  assert.equal(container.querySelectorAll('[data-browser-pane]').length, 0)
  await act(async () => assert.equal(openBrowserAddress('/preview'), true))
  assert.equal(container.querySelectorAll('[data-browser-pane]').length, 1)
  const params = new URL(browser.location.href).searchParams
  assert.equal(params.get('bot'), bot.id)
  assert.equal(params.get('workspace'), 'workspace-one')
  assert.equal(params.get('account'), 'active')
})

test('an invalid browser address does not reveal or create a browser pane', async () => {
  await act(async () => root.render(<OfficialIssueWorkspace user={user} initialSection="all-issues" />))
  await act(async () => assert.equal(openBrowserAddress('javascript:alert(1)'), false))
  assert.equal(container.querySelectorAll('[data-browser-pane]').length, 0)
})

const render = async (props: Partial<Parameters<typeof IssueWorkspace>[0]> = {}) => { await act(async () => root.render(<IssueWorkspace user={user} {...props} />)) }
for (const value of ['false', 'undefined']) test(`a frame with FRAME_LISTS_CHATS ${value} keeps one chat navigation and group command`, async () => {
  if (value === 'false') {
    const { FRAME_LISTS_CHATS } = await import('../slots/app-frame')
    assert.equal(FRAME_LISTS_CHATS, false)
    await render()
  } else {
    await act(async () => root.render(<OfficialIssueWorkspace user={user} />))
  }
  assert.ok(container.querySelector('[aria-label="Main navigation"]'))
  assert.equal(Boolean(container.querySelector('[data-retired-bot-list]')), false)
  const createGroup = [...container.querySelectorAll('button')].find(button => button.textContent === 'new group')
  assert.ok(createGroup)
  await act(async () => createGroup.click())
  assert.equal(container.querySelector('[data-create-group]')?.getAttribute('data-create-group'), workspaceId)
})

const renderHosted = async () => { await act(async () => root.render(<HostedIssueWorkspace user={user} />)) }
const frame = () => container.querySelector('[data-slot="app-frame-content"]')
const bar = () => container.querySelector('[data-slot="window-bar"]')
const rail = () => container.querySelector('[role="navigation"][aria-label="Main navigation"]')
const button = (text: string) => [...container.querySelectorAll('button')].find(node => node.textContent === text)!
const pin = async (text: string) => { await act(async () => notes!.add({ kind: 'element', url: 'https://fixture.example/page', label: 'Fixture element', selector: '#fixture', note: text })) }
async function go(href: string) {
  browser.history.pushState({}, '', href)
  await render()
}

test('Team Issues first-page readiness is independent of the unrelated workspace-wide list', async () => {
  scopedTeamFixture = true
  workspaceTasksPending = true // The large global page is slow; the authorized Team page is ready.
  browser.history.replaceState({}, '', `/?workspace=${workspaceId}&team=${teamIssuesId}&section=team-issues`)
  await render({ initialSection: 'team-issues' })
  assert.ok(container.querySelector('[data-team-board-visible]'), 'the ready Team list must be reachable without waiting for global pagination')
  assert.equal(container.querySelector('[role="status"][aria-label="Workspace.loadingEditor"]'), null)

  scopedTasksPending = true // The Team-scoped read itself remains a real loading gate.
  await render({ initialSection: 'team-issues' })
  assert.equal(container.querySelector('[data-team-board-visible]'), null)
  assert.ok(container.querySelector('[role="status"][aria-label="Workspace.loadingEditor"]'))
})

test('a Team detail ACK refreshes its own authorized list after save and deletion', async () => {
  scopedTeamFixture = true
  const issueId = '8055a7ae-204f-4045-8780-66b9c93ce230'
  browser.history.replaceState({}, '', `/?workspace=${workspaceId}&team=${teamIssuesId}&section=team-issues&issue=${issueId}`)
  await render({ initialSection: 'team-issues', initialSelected: issueId })
  await act(async () => { releaseChunk(); await Promise.resolve() })
  const save = container.querySelector<HTMLButtonElement>('[data-detail-save]')
  assert.ok(save, 'the Task detail must be reachable in the Team view')
  await act(async () => { save.click() })
  assert.equal(scopedTeamPageMutations, 1, 'the separate Team first page must be invalidated on a successful save')
  const remove = container.querySelector<HTMLButtonElement>('[data-detail-delete]')
  assert.ok(remove)
  await act(async () => { remove.click() })
  assert.equal(scopedTeamPageMutations, 2, 'an acknowledged deletion must retire the Team page too')
})

test('an embedded Task save ACK invalidates the same Team page as the full Task detail', async () => {
  scopedTeamFixture = true
  probeEmbeddedAck = true
  browser.history.replaceState({}, '', `/?workspace=${workspaceId}&team=${teamIssuesId}&section=team-issues`)
  await render({ initialSection: 'team-issues' })
  const save = container.querySelector<HTMLButtonElement>('[data-embedded-save-ack]')
  assert.ok(save, 'the embedded Task lifecycle must remain reachable from the official Team frame')
  await act(async () => { save.click() })
  assert.equal(scopedTeamPageMutations, 1, 'a successful embedded Task save must invalidate the authorized Team page')
})

test('a new Team task ACK invalidates the scoped first page before opening its detail', async () => {
  scopedTeamFixture = true
  browser.history.replaceState({}, '', `/?workspace=${workspaceId}&team=${teamIssuesId}&section=team-issues`)
  await render({ initialSection: 'team-issues' })
  const acknowledged = acknowledgeNewTask
  assert.ok(acknowledged, 'the authorized Team creation dialog must be wired')
  assert.equal(scopedTeamPageMutations, 0)
  await act(async () => { acknowledged('8055a7ae-204f-4045-8780-66b9c93ce231') })
  assert.equal(scopedTeamPageMutations, 1, 'a confirmed Team Task creation must invalidate the authorized Team page')
})

test('a group absent from stale rows offers retry until a successful membership read', async () => {
  const id = '8055a7ae-204f-4045-8780-66b9c93ce228'
  groupList = [{ id: 'other-group', title: 'Another group', workspaceId }]
  groupListError = new Error('offline during the reload after creation')
  browser.history.replaceState({}, '', `/?workspace=${workspaceId}&group=${id}`)
  await render()

  const alert = container.querySelector('[role="alert"]')
  assert.ok(alert)
  assert.ok(alert.textContent?.includes('GroupChat.loadError'))
  assert.doesNotMatch(container.textContent ?? '', /GroupChat\.notFound/)
  const retry = alert.querySelector('button')
  assert.ok(retry)
  await act(async () => retry.click())
  assert.equal(groupListRetries, 1)
  await render()
  assert.match(container.textContent ?? '', /GroupChat\.notFound/)
  assert.equal(container.querySelector('[data-open-group]'), null)

  groupList = [...groupList, { id, title: 'New group', workspaceId }]
  groupListError = new Error('a subsequent refresh failed')
  await render()
  assert.equal(container.querySelector('[data-open-group]')?.getAttribute('data-open-group'), id)
  assert.doesNotMatch(container.textContent ?? '', /GroupChat\.loadError/)
})

test('a cached conversation cannot accept a draft before its authenticated workspace scope resolves', async () => {
  workspaceReady = false
  await render()
  assert.equal(Boolean(container.querySelector('textarea')), false, 'a cached transcript must not expose an editable loading-scope draft')
  assert.ok(container.querySelector('[data-loading-placeholder]'))
  assert.equal(composerMounts, 0)

  workspaceReady = true
  await render()
  assert.ok(container.textContent?.includes('Cached conversation'))
  await act(async () => editDraft('Lifecycle readiness draft'))
  await render()
  assert.equal(container.querySelector('textarea')?.value, 'Lifecycle readiness draft')

  workspaceId = 'workspace-two'
  await render()
  assert.equal(container.querySelector('textarea')?.value, '', 'another workspace must not inherit the startup draft')
  await act(async () => editDraft('another workspace draft'))
  user = { ...user, id: 'owner-two' }
  await render()
  assert.equal(container.querySelector('textarea')?.value, '', 'another account must not inherit a workspace draft')
  user = { ...user, id: 'owner-one' }
  workspaceId = 'workspace-one'
  await render()
  assert.equal(container.querySelector('textarea')?.value, 'Lifecycle readiness draft')
})

test('a failed workspace read keeps editing unavailable and offers the normal read retry', async () => {
  workspaceReady = false
  workspaceError = new Error('unavailable fixture workspace')
  await render()
  assert.equal(Boolean(container.querySelector('textarea')), false)
  assert.equal(Boolean(container.querySelector('[data-loading-placeholder]')), false, 'a failed read must not remain a perpetual loader')
  assert.ok(container.querySelector('[role="alert"]'))
  const retry = button('Common.retry')
  assert.ok(retry)
  await act(async () => retry.click())
  await render()
  assert.ok(container.querySelector('textarea'))
  await act(async () => editDraft('draft after retry'))
  await render()
  assert.equal(container.querySelector('textarea')?.value, 'draft after retry')
})

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
  assert.equal(container.querySelector('[data-settings-section]')?.getAttribute('data-workspace'), workspaceId)
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

test('hosted Settings preserves pending browser notes and the computer registry across its distinct frame', async t => {
  registerComputer = true
  await renderHosted()
  assert.deepEqual(computerThread, registeredComputerThread)
  // The registering card is gone before navigation. A remount cannot silently
  // recreate its historical registry entry and hide the provider state loss.
  registerComputer = false
  await renderHosted()
  await pin('keep hosted annotation')
  await act(async () => editDraft('hosted unsent draft'))
  const workspaceFrame = frame()

  await act(async () => button('settings').click())
  await renderHosted()
  assert.equal(browser.location.pathname, '/settings')
  const hostedFrame = container.querySelector('[data-hosted-settings-frame]')
  assert.ok(hostedFrame, 'the hosted slot keeps its own settings appearance')
  assert.ok(!workspaceFrame?.isConnected, 'the distinct visual frame is intentional')
  assert.ok(hostedFrame.querySelector('[data-loading-placeholder]'), 'the cold chunk loads inside the hosted frame')
  await act(async () => { releaseChunk(); await chunkReady })
  const duringSettings = { notes: notes?.notes.length ?? null, hasComposer: notes?.hasComposer ?? null, computerRun: computerThread?.runId ?? null }

  await act(async () => button('hosted chats').click())
  await renderHosted()
  const after = { draft: container.querySelector('textarea')?.value, notes: notes?.notes.map(note => [note.n, note.note]), computerRun: computerThread?.runId ?? null }
  t.diagnostic(JSON.stringify({ duringSettings, after }))
  assert.deepEqual(after, { draft: 'hosted unsent draft', notes: [[1, 'keep hosted annotation']], computerRun: registeredComputerThread.runId })
  assert.deepEqual(duringSettings, { notes: 1, hasComposer: false, computerRun: registeredComputerThread.runId })
  assert.equal(notes?.hasComposer, true)
  await pin('next hosted annotation')
  assert.deepEqual(notes?.notes.map(note => note.n), [1, 2])
})

test('hosted Settings providers still retire state when the owner or workspace changes', async () => {
  releaseChunk()
  registerComputer = true
  await renderHosted()
  registerComputer = false
  await renderHosted()
  await pin('owner one private annotation')
  await act(async () => button('settings').click())
  await renderHosted()

  user = { ...user, id: 'owner-two', email: 'second@example.com' }
  await renderHosted()
  assert.equal(notes?.notes.length, 0)
  assert.equal(computerThread, null)
  await pin('workspace one private annotation')
  workspaceId = 'workspace-two'
  browser.history.pushState({}, '', '/settings?workspace=workspace-two')
  await renderHosted()
  assert.equal(notes?.notes.length, 0)
  assert.equal(computerThread, null)
  await pin('workspace two annotation')
  assert.deepEqual(notes?.notes.map(note => [note.n, note.note]), [[1, 'workspace two annotation']])
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

for (const routerFirst of [false, true]) test(`Settings search and repeated Back/Forward restore the addressed bot when the router renders ${routerFirst ? 'before' : 'after'} popstate`, async () => {
  releaseChunk()
  const chatHref = `/?workspace=workspace-one&bot=${bot.id}`
  browser.history.replaceState({}, '', chatHref)
  await render()
  const original = { frame: frame(), bar: bar(), rail: rail() }
  const assertChat = () => {
    assert.equal(new URLSearchParams(browser.location.search).get('bot'), bot.id)
    assert.equal(container.querySelector('textarea')?.dataset.chat, 'Ada', 'the visible chat must agree with the bot in the restored address')
    assert.equal(container.querySelector('textarea')?.value, 'Ada unsent draft')
  }
  await act(async () => editDraft('Ada unsent draft'))
  assertChat()
  await act(async () => button('settings').click())
  await render()
  const settingsHref = `${browser.location.pathname}${browser.location.search}`
  assert.ok(container.querySelector('[data-settings-section]'))
  await act(async () => { browser.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true })) })
  await render()
  assert.equal(browser.location.pathname, '/')
  assert.ok(container.querySelector('[data-search-open]'))
  await act(async () => button('dismiss search').click())

  // A router's own history subscription can render the new pathname before
  // the workspace's popstate listener runs. Deliver both valid event orders;
  // the real navigation singleton and canonical-address effect remain active.
  const pop = async (href: string, renderFirst = false) => {
    browser.history.replaceState({}, '', href)
    if (renderFirst) await render()
    await act(async () => { browser.dispatchEvent(new browser.PopStateEvent('popstate')) })
    await render()
  }
  await pop(settingsHref)
  await pop(chatHref)
  assertChat()
  await pop(settingsHref)
  assert.ok(container.querySelector('[data-settings-section]'))
  await pop(chatHref, routerFirst)
  assertChat()
  assert.ok(frame() === original.frame && bar() === original.bar && rail() === original.rail)
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
  assert.equal(container.querySelector('[data-settings-section]')?.getAttribute('data-workspace'), workspaceId)
  assert.equal(container.querySelector('[data-invite]')?.getAttribute('data-invite'), 'true')
})

const taskOne = '00000000-0000-4000-8000-000000000041'
const taskTwo = '00000000-0000-4000-8000-000000000042'
const reviewShortcut = () => browser.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'B', metaKey: true, shiftKey: true, bubbles: true, cancelable: true }))
const reviewedTask = () => container.querySelector<HTMLElement>('[data-review-task]')?.dataset.reviewTask

test('Review keyboard targets the actual active work task after its URL was consumed and clears on a non-task tab', async () => {
  await act(async () => root.render(<OfficialIssueWorkspace user={user} />))
  assert.ok(reportWorkTask, 'the current conversation exposes its active-task boundary')
  assert.equal(new URLSearchParams(browser.location.search).has('task'), false)
  await act(async () => reportWorkTask!(taskOne))
  await act(async () => reviewShortcut())
  assert.equal(reviewedTask(), taskOne)
  await act(async () => { closeReview(); reportWorkTask!(taskTwo) })
  await act(async () => reviewShortcut())
  assert.equal(reviewedTask(), taskTwo)
  await act(async () => { closeReview(); reportWorkTask!(null) })
  await act(async () => reviewShortcut())
  assert.equal(reviewedTask(), undefined, 'Browser, New and closed tabs cannot reuse the last task')
})

test('an old workarea callback cannot replace the active task after the workspace or account changes', async () => {
  const renderOwner = () => root.render(<OfficialIssueWorkspace user={user} />)
  await act(async () => renderOwner())
  const oldWorkspace = reportWorkTask!
  assert.ok(oldWorkspace)
  await act(async () => oldWorkspace(taskOne))
  workspaceId = 'workspace-two'
  await act(async () => renderOwner())
  await act(async () => reviewShortcut())
  assert.equal(reviewedTask(), undefined)
  const newWorkspace = reportWorkTask!
  await act(async () => { newWorkspace(taskTwo); oldWorkspace(taskOne) })
  await act(async () => reviewShortcut())
  assert.equal(reviewedTask(), taskTwo)
  await act(async () => closeReview())
  user = { ...user, id: 'owner-two' }
  await act(async () => renderOwner())
  await act(async () => { newWorkspace(taskTwo); oldWorkspace(taskOne) })
  await act(async () => reviewShortcut())
  assert.equal(reviewedTask(), undefined, 'a new account has no review target from the previous account')
})
