import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import React, { act, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import messages from '../messages/en.json'
import { Input } from '../components/ui/input'
import { Textarea } from '../components/ui/textarea'

// Exercise the real read owners and Sonner action buttons. The only reads are
// in-memory fixtures; the shared renderer keeps its real bootstrap lifecycle.
const at = (path: string) => new URL(`../${path}`, import.meta.url).href
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(at(path), { namedExports })
const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>
const Empty = () => null
const platform = 'data:text/javascript,' + encodeURIComponent('export const platform="web",AuthForm=()=>null,BrowserRoute=()=>null,setSession=()=>{},onSessionChanged=()=>()=>{},authenticatedReturn=()=>null,bootstrapScope=()=>"workspace",PlatformExtras=()=>null,requireUpdate=()=>{}')
registerHooks({ resolve(specifier, context, next) {
  return specifier === 'mikka:platform' ? { url: platform, shortCircuit: true } : next(specifier, context)
} })

const failures = new Map<string, Error>()
const reads = new Map<string, number>()
async function read<T>(key: string, value: T): Promise<T> {
  reads.set(key, (reads.get(key) ?? 0) + 1)
  if (failures.has(key)) throw failures.get(key)
  return value
}
const artifact = { id: 'artifact', title: 'Retained artifact', kind: 'markdown', updatedAt: '2026-11-07T00:00:00Z', authorName: 'Fixture', issueKey: null }
const detail = { ...artifact, latestVersion: 1, runId: null, issueId: null, live: { ownerId: 'owner', workspaceId: null }, versions: [{ version: 1, authorName: 'Fixture', authorColor: null, authorShape: null, createdAt: '2026-11-07T00:00:00Z' }] }
const thread = { id: 'run', issueId: 'issue', status: 'succeeded', outcome: null, question: null, continuation: null, stopping: false, ownedByCurrentUser: true, createdAt: new Date(0), finishedAt: new Date(0), latestRunId: 'run', prompt: 'Fixture thread', stopRequestedAt: null, replyAvailable: true, retryAvailable: true, quota: null, feedbackEligible: false, detail: { name: 'Fixture thread', agentName: 'Claude Code', harness: 'claude_code', summary: null } }
stub('app/actions/artifacts.ts', {
  listArtifacts: () => read('library', [artifact]), getArtifact: () => read('detail', detail),
  getArtifactText: () => read('text', 'Retained document body.'), listRunArtifacts: async () => [],
})
stub('app/actions/agents.ts', {
  listAgents: async () => [],
  findThreadIssue: () => read('lookup', { issueId: 'issue' }),
  getIssueThread: () => read('thread', { thread, chunks: [{ chunk: { type: 'text-delta', id: 'reply', delta: 'Retained reply.' }, at: new Date(0) }], messages: [], chunksAppend: false }),
  getThreadChanges: async () => ({ state: 'none' }), getThreadInstructions: async () => '',
  getThreadMachine: async () => null, getThreadName: async () => null,
  listIssueThreads: async () => [], pollIssueThreads: async () => [],
  retryQuotaPausedRun: async () => null, resumeQuotaPausedRunOnApiKey: async () => null,
  sendIssueThreadReply: async () => { throw new Error('This read test must not send') }, stopRun: async () => ({}),
})
stub('hooks/use-live-key.tsx', { useLiveKey: Empty, useLiveKeys: Empty, watchPageVisibility: () => () => {} })
stub('components/artifacts/artifact-card.tsx', { ArtifactKindIcon: Empty, ArtifactAuthorAvatar: Empty })
stub('components/artifacts/artifact-share.tsx', { ArtifactShare: Empty })
stub('components/artifacts/selection-actions.tsx', { SelectionActions: Empty })
stub('components/ui/dialog.tsx', { Dialog: Pass, DialogContent: ({ children }: { children?: ReactNode }) => <div role="dialog">{children}</div>, DialogTitle: Pass, DialogDescription: Pass, DialogHeader: Pass })
stub('components/workspace/factory-acceptance.tsx', { useAcceptanceTasks: () => ({ tasks: [], allTasks: [] }), useThreadAcceptance: () => null, AcceptanceStateBadge: Empty, FactoryAcceptance: Empty, FactoryAcceptancePanel: Empty })
stub('components/workspace/factory-acceptance-pane.tsx', { FactoryAcceptancePane: Empty })
stub('components/workspace/thread-changes.tsx', { ThreadChangesPane: Empty, ChangesTabLabel: Empty })
stub('components/workspace/self-improvement.tsx', { ThreadFeedback: Empty })
stub('components/workspace/thread-run-place.tsx', { ThreadRunPlace: Empty })
stub('components/workspace/thread-execution-identity.tsx', { ThreadExecutionIdentity: Empty })
stub('components/workspace/artifact-review.tsx', { ThreadArtifactButton: Empty, ThreadArtifactCards: Empty })
stub('components/workspace/thread-quota.tsx', { ThreadModelFallbackNotice: Empty, ThreadQuotaPausedCard: Empty, ThreadQuotaSwitchLine: Empty })
stub('components/computer/computer-card.tsx', { ComputerCard: Empty })
stub('components/workspace/issue-threads.tsx', { harnessLabel: () => 'Agent', IssueThreads: Empty, ThreadEventRow: Empty, useIssueThreads: () => ({ data: [] }), useAgentActivity: () => ({ rows: [], error: null }) })
stub('components/nav/context-panel.tsx', { PANEL_WIDTH: { storageKey: 'fixture-panel-width', min: 320, max: 'half', initial: 360, edge: 'start' } })
stub('components/coordinator/chat-composer.tsx', { ChatComposer: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => <Textarea value={value} onChange={event => onChange(event.target.value)} /> })
mock.module('next/dynamic', { defaultExport: () => Empty })

const issue = { id: 'issue', userId: 'owner', title: 'Retained task', content: { type: 'doc', content: [] }, status: 'review', priority: 'normal', revision: 1, identifier: 'FIX-1', metadata: {}, createdAt: new Date(0), updatedAt: new Date(0) }
stub('app/actions/issues.ts', { pollIssue: () => read('task', { viewerId: 'owner', version: '1', issue }), pollIssueVersionSummaries: async () => ({ viewerId: 'owner', snapshot: { version: '1', items: [] } }), listIssueVersions: async () => [], saveIssue: async () => { throw new Error('This read test must not save') } })
stub('app/actions/issue-operations.ts', { getDeletedIssue: async () => null, listIssueConnections: async () => [], setIssueDeleted: async () => { throw new Error('This read test must not delete') } })
stub('components/workspace/issue-editor.tsx', { createDocumentSeed: () => null, IssueEditor: Empty })
for (const [file, name] of [['issue-description-history', 'IssueDescriptionHistory'], ['issue-relations', 'IssueRelations'], ['issue-members', 'IssueMembers'], ['issue-activity-feed', 'IssueActivityFeed']]) stub(`components/workspace/${file}.tsx`, { [name]: Empty })
const groupMessages = await import('../lib/group-messages')
stub('lib/group-messages.ts', { ...groupMessages, fetchGroupMessages: () => read('group', { messages: [{ id: 'message', conversationId: 'group', position: '1', authorType: 'user', authorId: 'owner', body: 'Retained group message', mentions: [], replyToId: null, createdAt: '2026-11-07T00:00:00Z' }], nextBefore: null }) })
stub('app/actions/link-preview.ts', { getLinkPreview: async () => null })
stub('components/nav/conversation-pill.tsx', { ConversationPill: Empty })
stub('components/nav/group-avatar.tsx', { GroupAvatar: Empty, groupMembersKey: (id: string) => ['group-members', id], memberAvatar: (member: { id: string }) => ({ id: member.id }), useGroupMembers: () => ({ data: [] }) })
stub('components/nav/letter-avatar.tsx', { LetterAvatar: Empty })
stub('components/nav/bot-avatar.tsx', { BotAvatar: Empty, CoordinatorAvatar: Empty })
// The task page's layer frame (docs/ui-overlay.md task-detail); this test reads through the open-source layout.
stub('components/workspace/task-detail-frame.tsx', { FramedTask: ({ titleField }: import('../components/workspace/task-detail-frame').FramedTaskProps) => <Input id="task-title" value={titleField.value} readOnly /> })
stub('components/slots/task-conversation.tsx', { TaskConversation: ({ issueId, runId }: { issueId: string; runId: string }) => <ol data-task-conversation={issueId}><li>{runId}</li></ol> })
stub('components/workspace/message-reactions.tsx', { MessageReactions: Empty, useMessageReactions: () => ({}) })

const Workspace = () => <main data-fixture-workspace="">Retained workspace</main>
stub('apps/desktop/src/renderer/bootstrap.ts', {
  readBootstrap: () => read('bootstrap', { user: { id: 'owner', name: 'Fixture' }, session: { id: 'session' }, cacheWorkspace: null, googleEnabled: false, githubEnabled: false, emailEnabled: false }),
  readAuthentication: async () => { throw new Error('Unexpected authentication-only read in workspace recovery test') },
})
stub('apps/desktop/src/renderer/workspace-loader.ts', { loadWorkspace: async () => ({ default: Workspace }), preloadWorkspace: async () => {} })
stub('apps/desktop/src/renderer/installed-workspace.tsx', { InstalledWorkspace: Empty })
stub('apps/desktop/src/renderer/offline.tsx', { Offline: Empty })
stub('apps/desktop/src/renderer/client-configuration.ts', { setClientConfiguration: () => {} })
stub('apps/desktop/src/renderer/location.ts', { useLocation: () => new URL('https://fixture.example/'), localeOf: () => 'en', withoutLocale: () => '/', navigate: () => {}, REFRESH_EVENT: 'fixture-refresh' })
stub('apps/desktop/src/renderer/i18n-navigation.tsx', { Link: Pass })
stub('components/theme-provider.tsx', { ThemeProvider: Pass })
stub('components/swr-defaults.tsx', { SWRDefaults: Pass })
stub('components/blocks/auth-19/components/auth.tsx', { Auth: Pass })
stub('components/blocks/auth-19/components/auth-card.tsx', { AuthCard: Pass })
stub('components/workspace/workspace-loading.tsx', { WorkspaceLoading: Empty })
stub('components/workspace/create-workspace-form.tsx', { CreateWorkspaceForm: Empty })
stub('components/workspace/invitation-card.tsx', { InvitationCard: Empty })
stub('components/device-authorization.tsx', { DeviceAuthorization: Empty })
mock.module(at('components/app-shell/not-found.tsx'), { defaultExport: Empty })

const browser = new Window({ url: 'https://fixture.example/' })
let createRoot: typeof import('react-dom/client')['createRoot']
let SWRConfig: typeof import('swr')['SWRConfig'], useSWRConfig: typeof import('swr')['useSWRConfig'], serialize: typeof import('swr')['unstable_serialize']
let Toaster: typeof import('sonner')['Toaster'], toast: typeof import('sonner')['toast']
let IntlProvider: typeof import('next-intl')['NextIntlClientProvider']
let ArtifactLibrary: typeof import('../components/artifacts/artifact-library')['ArtifactLibrary']
let ArtifactViewer: typeof import('../components/artifacts/artifact-viewer')['ArtifactViewer']
let IssueThreadPanel: typeof import('../components/workspace/issue-thread-panel')['IssueThreadPanel']
let ThreadColumn: typeof import('../components/workspace/thread-column')['ThreadColumn']
let TaskDetail: typeof import('../components/workspace/task-detail')['TaskDetail']
let GroupChatView: typeof import('../components/workspace/group-chat-view')['GroupChatView']
let infiniteKey: typeof import('swr/infinite')['unstable_serialize']
let App: React.ComponentType
let setTransportState: typeof import('../apps/desktop/src/renderer/transport-state')['setTransportState']
let cache = new Map(), root: Root, container: HTMLDivElement
let mutate: ReturnType<typeof import('swr')['useSWRConfig']>['mutate']
let unexpectedNetwork = 0
function ReadControl() { mutate = useSWRConfig().mutate; return null }

before(async () => {
  for (const key of ['window', 'document', 'navigator', 'location', 'HTMLElement', 'Element', 'Node', 'Text', 'DocumentFragment', 'ShadowRoot', 'customElements', 'CSS', 'MutationObserver', 'ResizeObserver', 'getComputedStyle', 'matchMedia', 'requestAnimationFrame', 'cancelAnimationFrame', 'MouseEvent', 'Event', 'KeyboardEvent'] as const) {
    const value = key === 'window' ? browser : (browser as unknown as Record<string, unknown>)[key]
    if (value !== undefined) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: typeof value === 'function' && !/^[A-Z]/.test(key) ? (value as (...args: unknown[]) => unknown).bind(browser) : value })
  }
  // The desktop source has its own classic-JSX tsconfig; its production bundler
  // supplies React. Keep that runtime binding when Node loads the real App.
  Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })
  globalThis.fetch = async () => { unexpectedNetwork++; throw new Error('Unexpected network request in read-only component test') }
  ;({ createRoot } = await import('react-dom/client'))
  ;({ SWRConfig, useSWRConfig, unstable_serialize: serialize } = await import('swr'))
  ;({ Toaster, toast } = await import('sonner'))
  ;({ NextIntlClientProvider: IntlProvider } = await import('next-intl'))
  ;({ ArtifactLibrary } = await import('../components/artifacts/artifact-library'))
  ;({ ArtifactViewer } = await import('../components/artifacts/artifact-viewer'))
  ;({ IssueThreadPanel } = await import('../components/workspace/issue-thread-panel'))
  ;({ ThreadColumn } = await import('../components/workspace/thread-column'))
  ;({ TaskDetail } = await import('../components/workspace/task-detail'))
  ;({ GroupChatView } = await import('../components/workspace/group-chat-view'))
  ;({ unstable_serialize: infiniteKey } = await import('swr/infinite'))
  // The renderer has a separate typecheck for its bundler-only virtual modules.
  ;({ App } = await import(at('apps/desktop/src/renderer/app.tsx')))
  ;({ setTransportState } = await import('../apps/desktop/src/renderer/transport-state'))
})
beforeEach(() => {
  failures.clear(); reads.clear(); cache = new Map(); unexpectedNetwork = 0
  setTransportState('ready')
  container = browser.document.createElement('div') as unknown as HTMLDivElement
  document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => { toast.dismiss(); root.unmount() }); container.remove() })
after(() => browser.happyDOM.close())
async function until(check: () => boolean, message: string) {
  for (let attempt = 0; attempt < 100 && !check(); attempt++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  assert.ok(check(), message)
}
const cases = [
  { name: 'Artifact library', read: 'library', key: 'artifacts', title: messages.ArtifactsPage.loadError, node: 'li button' },
  { name: 'Artifact detail', read: 'detail', key: ['artifact', 'artifact'], title: messages.Artifact.loadError, node: '[data-slot="artifact-document"]' },
  { name: 'Artifact text', read: 'text', key: ['artifact-text', 'artifact', 1], title: messages.Artifact.loadError, node: '[data-slot="artifact-document"]' },
  { name: 'Thread detail', read: 'thread', key: ['issue-thread', 'issue', 'run'], title: messages.IssueThreads.loadFailed, node: 'ol:not([data-sonner-toaster])' },
  { name: 'Thread lookup', read: 'lookup', key: ['thread-issue', 'run'], title: messages.IssueThreads.loadFailed, node: 'ol:not([data-sonner-toaster])' },
  { name: 'Task detail', read: 'task', key: ['issue', 'issue'], title: messages.Workspace.detail.readFailed, node: '#task-title' },
  { name: 'Group history', read: 'group', key: null, title: messages.GroupChat.loadError, node: 'ol:not([data-sonner-toaster])' },
  { name: 'Connection status', read: 'bootstrap', key: null, title: messages.DesktopRenderer.serverUnavailable, node: '[data-fixture-workspace]' },
]
for (const item of cases) test(`${item.name}: a failed Retry stays available, then success dismisses it`, async () => {
  const isApp = item.read === 'bootstrap'
  const key = item.read === 'group' ? infiniteKey(() => ['group-messages', 'group', null]) : item.key
  const view = item.read === 'library' ? <ArtifactLibrary />
    : item.read === 'detail' || item.read === 'text' ? <ArtifactViewer artifactId="artifact" onArtifactChange={() => {}} onClose={() => {}} quotes={[]} bot={{ name: 'Fixture', avatar: null }} chat={() => <Textarea defaultValue="Retained draft" />} />
    : item.read === 'thread' ? <IssueThreadPanel issueId="issue" runId="run" bare />
    : item.read === 'lookup' ? <ThreadColumn runId="run" />
    : item.read === 'group' ? <GroupChatView group={{ id: 'group', title: 'Fixture group', workspaceId: 'workspace' }} userId="owner" people={new Map()} />
    : item.read === 'task' ? <TaskDetail id="issue" thread={null} origin="Tasks" user={{ id: 'owner', name: 'Fixture', email: 'fixture@example.invalid' }} navigation={{ index: -1, total: 0, onOpen: () => {} }} onOpen={() => {}} onSaved={() => {}} onDirty={() => {}} onClose={() => {}} onDeleted={() => {}} onRegisterFlush={() => {}} /> : <App />
  await act(async () => root.render(<SWRConfig value={{ provider: () => cache, shouldRetryOnError: false, revalidateOnFocus: false, revalidateOnReconnect: false, dedupingInterval: 0 }}>
    <IntlProvider locale="en" timeZone="UTC" messages={messages}><ReadControl />{view}{!isApp && <Toaster />}</IntlProvider>
  </SWRConfig>))
  await until(() => !!container.querySelector(item.node), 'The initial read must produce retained content')
  const original = container.querySelector(item.node)
  failures.set(item.read, new TypeError('fixture continuing read failure'))
  await act(async () => { if (isApp) setTransportState('offline'); else await mutate(key).catch(() => {}) })
  const notice = () => [...container.querySelectorAll('[data-sonner-toast]')].find(element => element.textContent?.includes(item.title))
  const retry = () => notice()?.querySelector<HTMLButtonElement>('button[data-action]')
  await until(() => !!retry(), 'The actual Sonner Retry button must appear')
  const before = reads.get(item.read)!
  await act(async () => retry()!.click())
  await until(() => reads.get(item.read) === before + 1, 'Retry must perform the next read')
  // The installed Sonner removes an action toast after 200 ms, independent of duration.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)) })
  assert.equal(container.querySelector(item.node), original, 'The retained content stays mounted')
  if (!isApp) assert.ok(cache.get(serialize(key))?.error, 'The retried read still failed')
  assert.ok(retry(), 'A failed Retry must preserve its in-place recovery action')
  failures.delete(item.read)
  await act(async () => retry()!.click())
  await until(() => reads.get(item.read) === before + 2 && !notice(), 'A later successful read must dismiss the notice')
  assert.equal(container.querySelector(item.node), original)
  assert.equal(unexpectedNetwork, 0)
})
