import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { after, before, mock, test } from 'node:test'
import { act, type ReactNode } from 'react'
import { Window } from 'happy-dom'
import { LIVE_KINDS } from '../lib/live/events'
import { BOT_COLORS, BOT_SHAPES, DEFAULT_BOT_COLOR, DEFAULT_BOT_SHAPE } from '../lib/bot-shapes'
import { issueWithMetadata } from '../lib/issue-metadata'

// Idle request budget (#1212): each main page's real client component, real SWR with the app's defaults
// (components/swr-defaults.tsx) and a healthy live channel, over one idle, visible minute on fake timers.
// Every server action and fetch is a counting fixture; no database is reached. Each page may make at most
// the calls tests/idle-request-budget.json allows, and the budgets only go down.

// Stylesheets are the bundler's; plain node has no loader for them.
registerHooks({ resolve(specifier, context, next) { return specifier.endsWith('.css') ? { url: 'data:text/javascript,export default {}', shortCircuit: true } : next(specifier, context) } })

const root = new URL('..', import.meta.url)
const calls = new Map<string, number>()
const missing = new Set<string>()
const fixtures: Record<string, (...args: unknown[]) => unknown> = {}
const routes: Record<string, (url: URL) => unknown> = {}
// Every answer takes a little time, as on a real network, so SWR's deduping and timers order as in a browser.
const LATENCY_MS = 40
const network = () => new Promise(resolve => setTimeout(resolve, LATENCY_MS))
const count = (name: string) => calls.set(name, (calls.get(name) ?? 0) + 1)

for (const file of readdirSync(new URL('app/actions/', root)).filter(name => name.endsWith('.ts') && !name.includes('.test.'))) {
  const source = readFileSync(new URL(`app/actions/${file}`, root), 'utf8')
  const names = [...source.matchAll(/^export async function (\w+)/gm)].map(match => match[1])
  const module = file.replace(/\.ts$/, '')
  mock.module(new URL(`app/actions/${file}`, root).href, { namedExports: Object.fromEntries(names.map(name => [name, async (...args: unknown[]) => {
    const id = `${module}.${name}`
    count(id)
    const fixture = fixtures[id]
    await network()
    if (!fixture) { missing.add(id); throw new Error(`no fixture for ${id}`) }
    return fixture(...args)
  }])) })
}

// The bloub avatar is a Solid animation runtime with no reads; plain node loads its server build.
const avatar = () => <span data-avatar="" />
mock.module(new URL('components/nav/bot-avatar.tsx', root).href, { namedExports: {
  BOT_COLORS, BOT_SHAPES, DEFAULT_BOT_COLOR, DEFAULT_BOT_SHAPE,
  BOT_MOOD_SECONDS: { idle: 2.4, thinking: 2.6, wink: 1.6, exclaim: 2, sleep: 2.4, wide: 1.8, hexagon: 1.6, burst: 2.6 }, colorFor: () => DEFAULT_BOT_COLOR,
  COORDINATOR_AVATAR: { color: 'encre', shape: 'cercle' }, CoordinatorAvatar: avatar, BotAvatar: avatar,
} })

// Keep the real Task controller, document reader and open run during the budget measurement.
let BudgetThreadPanel: typeof import('../components/workspace/issue-thread-panel').IssueThreadPanel
mock.module(new URL('components/slots/task-conversation.tsx', root).href, { namedExports: {
  TaskConversation: ({ issueId, runId }: import('../components/slots/task-conversation-contract').TaskConversationProps) =>
    <BudgetThreadPanel issueId={issueId} runId={runId} bare />,
} })
mock.module(new URL('components/slots/task-detail.tsx', root).href, { namedExports: {
  TaskDetailFrame: (props: import('../components/slots/task-detail-contract').TaskDetailFrameProps) =>
    <section><h1>{props.title}</h1>{props.description({ afterDescription: null, activity: () => null })}{props.panel}{props.dialogs}</section>,
} })

// Feature flags come from PostHog, not from Mikka's server.
mock.module('posthog-js', { defaultExport: { getFeatureFlag: () => undefined, onFeatureFlags: () => () => {}, capture: () => {}, isFeatureEnabled: () => false } })

const browser = new Window({ url: 'https://mikka.example/', width: 1440, height: 900 })
const sockets: FakeSocket[] = []
const presenceGrants = new Map<string, number>()
const presenceProof = () => {
  const expiresAt = Date.now() + 300_000, token = `fixture-${expiresAt}.${'a'.repeat(64)}`
  presenceGrants.set(token, expiresAt)
  return { token, expiresAt }
}
/** A healthy live channel: it opens, says which kinds it serves, answers pings and sends no events. */
class FakeSocket {
  readyState = 0
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  constructor(readonly url: string) {
    sockets.push(this)
    queueMicrotask(() => {
      if (this.readyState !== 0) return
      this.readyState = 1; this.onopen?.()
      this.onmessage?.({ data: JSON.stringify({ type: 'live_ready', version: 1, kinds: LIVE_KINDS }) })
      if (new URL(url).searchParams.get('presence') === '1') this.onmessage?.({ data: JSON.stringify({ type: 'presence_ready', version: 1 }) })
    })
  }
  send(value: string) {
    if (value === 'ping') { queueMicrotask(() => this.onmessage?.({ data: 'pong' })); return }
    const command = JSON.parse(value)
    if (command.type !== 'presence_watch') return
    const expiresAt = presenceGrants.get(command.token)
    assert.ok(expiresAt, 'a watch uses the proof from an actual fixture read')
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: 'presence_ack', id: command.id, expiresAt }) }))
  }
  close() { this.readyState = 3; this.onclose?.() }
}

/** Fake timers from `now`, with no timer left from before. A browser runs a missing or invalid delay at once;
 * node's mock would queue it at NaN and stop every later timer, so delays are read as a browser reads them. */
function fakeClock(now: number) {
  mock.timers.reset()
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now })
  const delay = (ms: unknown) => { const value = Number(ms); return Number.isFinite(value) && value > 0 ? value > 2_147_483_647 ? 1 : value : 0 }
  const [timeout, interval] = [globalThis.setTimeout, globalThis.setInterval]
  globalThis.setTimeout = ((callback: () => void, ms?: number, ...rest: unknown[]) => timeout(callback, delay(ms), ...rest)) as typeof setTimeout
  globalThis.setInterval = ((callback: () => void, ms?: number, ...rest: unknown[]) => interval(callback, delay(ms), ...rest)) as typeof setInterval
}

before(async () => {
  fakeClock(Date.parse('2026-11-05T09:00:00.000Z'))
  const start = Date.now()
  const timers = {
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (id: Parameters<typeof clearTimeout>[0]) => clearTimeout(id),
    setInterval: (...args: Parameters<typeof setInterval>) => setInterval(...args),
    clearInterval: (id: Parameters<typeof clearInterval>[0]) => clearInterval(id),
    requestAnimationFrame: (callback: (time: number) => void) => setTimeout(() => callback(Date.now() - start), 16),
    cancelAnimationFrame: (id: Parameters<typeof clearTimeout>[0]) => clearTimeout(id),
  }
  for (const [key, value] of Object.entries(timers)) Object.defineProperty(browser, key, { configurable: true, writable: true, value })
  mock.method(performance, 'now', () => Date.now() - start)
  for (const key of ['document', 'navigator', 'location', 'HTMLElement', 'Element', 'Node', 'Text', 'DocumentFragment', 'customElements', 'ShadowRoot', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'DOMParser', 'Range', 'Selection', 'getComputedStyle', 'matchMedia', 'CSS', 'localStorage', 'sessionStorage', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'FocusEvent', 'InputEvent', 'ClipboardEvent', 'DragEvent', 'Event', 'CustomEvent', 'HTMLInputElement', 'HTMLTextAreaElement', 'SVGElement', 'getSelection'] as const) {
    const value = (browser as unknown as Record<string, unknown>)[key]
    if (value !== undefined) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: typeof value === 'function' && !/^[A-Z]/.test(key) ? (value as (...args: unknown[]) => unknown).bind(browser) : value })
  }
  for (const [key, value] of Object.entries({ window: browser, requestAnimationFrame: timers.requestAnimationFrame, cancelAnimationFrame: timers.cancelAnimationFrame, WebSocket: FakeSocket, IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  // happy-dom has no Web Animations; Base UI asks for running animations before it unmounts a popup.
  const elementPrototype = browser.Element.prototype as unknown as { getAnimations?: () => unknown[] }
  elementPrototype.getAnimations ??= () => []
  Object.defineProperty(browser.document, 'visibilityState', { configurable: true, value: 'visible' })
  Object.defineProperty(browser.document, 'hidden', { configurable: true, value: false })
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'https://mikka.example')
    count(`fetch ${url.pathname}`)
    await network()
    if (url.pathname === '/api/live/ticket') return Response.json({ url: `wss://live.invalid/${url.searchParams.get('workspace')}`, protocol: 'fixture', expiresAt: Date.now() + 3_600_000 })
    const route = routes[url.pathname] ?? routes[url.pathname.replace(/^\/api\/conversations\/[^/]+\/(read|messages|members)$/, '/api/conversations/:id/$1')]
    if (route) { const value = route(url); return value instanceof Response ? value : Response.json(value) }
    missing.add(`fetch ${url.pathname}`)
    return new Response('{}', { status: 404 })
  }
})
after(async () => { mock.timers.reset(); mock.restoreAll(); await browser.happyDOM.close() })

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)) }
async function advance(ms: number, step = 100) {
  for (let elapsed = 0; elapsed < ms; elapsed += step) await act(async () => { mock.timers.tick(Math.min(step, ms - elapsed)); await flush() })
}

async function measure(page: ReactNode) {
  const { createRoot } = await import('react-dom/client')
  const { SWRConfig } = await import('swr')
  const { SWRDefaults } = await import('../components/swr-defaults')
  const { LiveProvider } = await import('../hooks/use-live-key')
  const { NextIntlClientProvider } = await import('next-intl')
  const { SidebarProvider } = await import('../components/ui/sidebar')
  const messages = (await import('../messages/en.json')).default
  const container = browser.document.createElement('div') as unknown as HTMLElement; document.body.append(container)
  const view = createRoot(container)
  calls.clear(); missing.clear(); sockets.length = 0
  await act(async () => { view.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}><SWRDefaults><SWRConfig value={{ provider: () => new Map() }}><LiveProvider ownerId={OWNER} workspaceId={WORKSPACE}><SidebarProvider>{page}</SidebarProvider></LiveProvider></SWRConfig></SWRDefaults></NextIntlClientProvider>) })
  // The first load settles: reads, the live ticket and its catch-up read after the socket opens.
  await advance(5_000, 50)
  calls.clear()
  await advance(60_000)
  const idle = new Map(calls)
  const open = { opened: sockets.length, open: sockets.filter(socket => socket.readyState === 1).length }
  // Dialogs and sheets render in a portal on the body.
  const text = document.body.textContent ?? ''
  const chatLoadFailure = Boolean(document.querySelector('[data-chat-failure=load]'))
  await act(async () => { view.unmount() }); container.remove()
  // Nothing a page left scheduled may fire into the next page's count.
  fakeClock(Date.now())
  return { idle, missing: new Set(missing), sockets: open, text, chatLoadFailure }
}

const OWNER = '10000000-0000-4000-8000-000000000001'
const OWNER_HOME = '20000000-0000-4000-8000-000000000002'
const MEMBER = '10000000-0000-4000-8000-000000000002'
const DEVICE = '70000000-0000-4000-8000-000000000001'
const AGENT = '80000000-0000-4000-8000-000000000001'
const WORKSPACE = '20000000-0000-4000-8000-000000000001'

const ISSUE = '30000000-0000-4000-8000-000000000001'
const RUN = '40000000-0000-4000-8000-000000000001'
const BOT = '50000000-0000-4000-8000-000000000001'
const ARTIFACT = '60000000-0000-4000-8000-000000000001'
const noop = () => {}
const AT = '2026-11-05T08:00:00.000Z'
const live = { ownerId: OWNER, workspaceId: OWNER_HOME }
const doc = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
const issue = (id: string, title: string, status = 'todo') => ({ ...issueWithMetadata({ id, userId: OWNER, title, content: doc(title), status, priority: 'normal', scope: 'workspace' as const, scopeVersion: 1, linearSyncBlocked: false, scopeSetBy: 'user' as const, scopeConfidence: null, revision: 3, createdAt: new Date(AT), updatedAt: new Date(AT) }), identifier: 'MIK-7', linearTargetVerified: false })
const CHAT_VERSION = '0123456789abcdef0123456789abcdef'
const chat = { botId: BOT, enabled: true, version: CHAT_VERSION, working: false, error: null, cursor: 2, sources: {}, artifacts: {}, persistedStreamIds: [], live, items: [
  { id: 'm1', position: 1, from: 'person', text: 'Can you fix the sign-in redirect?', tools: [], threads: [], artifacts: [], createdAt: AT },
  { id: 'm2', position: 2, from: 'coordinator', text: 'Done: the redirect is fixed.', tools: [], threads: [], artifacts: [], createdAt: AT },
] }
const attempt = { runId: RUN, attempt: 1, status: 'running', outcome: null, stopping: false, createdAt: new Date(AT), finishedAt: null }
const thread = { id: RUN, status: 'running', outcome: null, stopping: false, createdAt: new Date(AT), finishedAt: null, ownedByCurrentUser: true, ownerName: null,
  detail: { name: 'Fix sign-in redirect', agentName: 'Claude Code', harness: 'claude_code', summary: null, bot: null }, rootRunId: RUN, latestRunId: RUN, attempts: [attempt], question: null, continuation: null }
const person = { id: OWNER, name: 'Ada', email: 'ada@example.invalid', image: null }
const user = { id: OWNER, name: 'Ada', email: 'ada@example.invalid' }
Object.assign(fixtures, {
  'issues.getIssue': (id: unknown) => ({ issue: issue(String(id), 'Fix sign-in redirect') }),
  'issues.pollIssue': (id: unknown, known: unknown) => known === CHAT_VERSION ? { viewerId: OWNER, unchanged: true, version: CHAT_VERSION } : { viewerId: OWNER, issue: issue(String(id), 'Fix sign-in redirect'), version: CHAT_VERSION },
  'issues.pollIssueVersionSummaries': () => ({ viewerId: OWNER, snapshot: { version: CHAT_VERSION, items: [], positions: [] } }),
  'issues.listIssueVersions': () => [],
  'issue-operations.getDeletedIssue': () => null,
  'issue-operations.listIssueConnections': () => [],
  'teams.listTeams': () => [],
  'team-relations.getIssueTeam': () => null,
  // The authorized live scope each read returns (app/actions/collaboration.ts, agents.ts).
  'collaboration.exchangeDocument': () => ({ version: 'v1', workspaceId: WORKSPACE }),
  'collaboration.listMembers': () => ({ members: [{ ...person, id: MEMBER, name: 'Grace', email: 'grace@example.invalid', createdAt: new Date(AT) }], owner: person, currentUserId: OWNER, isOwner: true, live: { workspaceId: WORKSPACE } }),
  'agents.listDevices': () => [{ id: DEVICE, name: 'Ada’s MacBook', deviceType: 'laptop', hostname: 'ada-mbp', platform: 'darwin', arch: 'arm64', harnesses: [], online: true, enabled: true, lastSeenAt: new Date(AT), repos: [] }],
  // An online gateway-only device: its acknowledged watch covers expiry and
  // disconnects without a database heartbeat or a minute fallback read.
  'agents.pollDevices': () => ({ devices: [{ id: DEVICE, name: 'Ada’s MacBook', deviceType: 'laptop', hostname: 'ada-mbp', platform: 'darwin', arch: 'arm64', harnesses: [], online: true, enabled: true, lastSeenAt: new Date(AT), repos: [] }], live: { ...live, presence: presenceProof() }, presenceFallback: true }),
  'artifacts.getArtifact': () => ({ id: ARTIFACT, kind: 'markdown', title: 'Release notes', latestVersion: 2, runId: RUN, issueId: ISSUE, botId: BOT, shared: false,
    versions: [1, 2].map(version => ({ version, authorName: 'Scout', authorColor: 'bleu', authorShape: 'cercle', createdAt: AT })), live }),
  'artifacts.listRunArtifacts': () => [],
  'agents.pollIssueThreads': () => ({ threads: [thread], live: { workspaceId: WORKSPACE } }),
  'agents.getIssueThread': () => ({ live: { runs: [{ id: RUN, workspaceId: WORKSPACE }], issueWorkspaceId: WORKSPACE, questionDeadline: null }, thread: { ...thread, prompt: 'Fix the sign-in redirect', stopRequestedAt: null, feedbackEligible: false, error: null, quota: null }, chunks: [{ chunk: { type: 'text-delta', id: 't1', delta: 'Looking at the redirect handler.' }, at: new Date(AT) }], messages: [], chunkCursor: null, chunksAppend: false }),
  'agents.getThreadChanges': () => ({ state: 'none' }),
  'agents.getThreadMachine': () => ({ kind: 'laptop', state: 'online', name: 'Ada’s MacBook', platform: 'darwin', arch: 'arm64', hostname: null, lastSeenAt: new Date(AT).toISOString(), cloud: null }),
  'agents.listAgents': () => [{ id: AGENT, name: 'Claude Code', description: '', instructions: '', harness: 'claude_code', deviceId: DEVICE, deviceName: 'Ada’s MacBook' }],
  'linear-sync.getLinearBoardSync': () => ({ synced: false }),
  'task-runs.pollTaskRuns': () => ({ items: [{ issueId: ISSUE, runId: RUN, issueTitle: 'Fix sign-in redirect', agentId: AGENT, agentName: 'Claude Code', status: 'running', outcome: null, error: null, finishedAt: null, bot: null, harnesses: ['claude_code'] }], live }),
  'execution-settings.getBotModelMenu': () => ({ groups: [{ kind: 'subscription', provider: 'claude', plan: 'Max', credentialLabel: 'ada@example.invalid', options: [{ id: 'binding-1', modelId: 'claude-sonnet-4-6', provider: 'claude' }] }],
    current: { id: 'binding-1', modelId: 'claude-sonnet-4-6', provider: 'claude', kind: 'subscription', chosen: false, available: true } }),
  'coordinator.pollCoordinatorChat': (_bot: unknown, known: unknown) => known === CHAT_VERSION ? { unchanged: true, version: CHAT_VERSION, cursor: 2, working: false, error: null, botId: BOT, enabled: true, live } : chat,
  'coordinator.syncCoordinatorChat': (_bot: unknown, known: unknown) => ({ chat: known === CHAT_VERSION ? { unchanged: true, version: CHAT_VERSION, cursor: 2, working: false, error: null, botId: BOT, enabled: true, live } : chat }),
  'coordinator.getCoordinatorChat': () => chat,
  'coordinator.pollBotChatSummaries': () => ({ items: { [BOT]: { at: AT, text: 'Done: the redirect is fixed.' } }, live }),
  'artifacts.getArtifactText': () => '# Release notes\n\nSign-in redirect fixed.',
})
// A bodyless native create prewarms the mapped session without starting a turn.
// The public v27 protocol reports tail -1 until its first delivery; resume catches up and closes while idle.
routes['/api/agents/eve/v1/session'] = () => ({ ok: true, sessionId: 'wrun_idle_fixture' })
routes['/api/agents/eve/v1/session/wrun_idle_fixture/stream'] = () => new Response('', { headers: {
  'content-type': 'application/x-ndjson', 'x-eve-stream-format': 'ndjson', 'x-eve-stream-version': '27', 'x-eve-stream-tail-index': '-1',
} })
routes['/api/auth/get-session'] = () => ({ user: { ...person, emailVerified: true, createdAt: AT, updatedAt: AT }, session: { id: 'session', userId: OWNER, token: 'fixture', expiresAt: '2026-12-05T00:00:00.000Z', createdAt: AT, updatedAt: AT } })
routes['/api/workspace/switcher'] = () => ({ workspace: { id: WORKSPACE, name: 'Mikka' }, live, accounts: [{ id: OWNER, email: person.email, choices: [{ id: OWNER_HOME, name: 'Personal', kind: 'personal' }, { id: WORKSPACE, name: 'Mikka', kind: 'team' }] }] })
routes['/api/pending-actions'] = () => new Response('[]', { headers: { 'content-type': 'application/json', 'x-mikka-viewer': OWNER, 'x-mikka-observed-at': AT } })
routes['/api/approved-writes'] = () => ({ enabled: false })
// Sub-agent login prompts: one read on mount, then only on a subagent_events push.
routes['/api/computer/events'] = url => ({ events: [], cursor: url.searchParams.get('after') ?? '0', hasMore: false })
routes['/api/conversations'] = url => ({ conversations: [], viewerId: OWNER, workspaceId: url.searchParams.get('workspaceId') })
routes['/api/factory/tasks'] = () => ({ tasks: [], liveWorkspaceId: WORKSPACE })
routes['/api/conversations/:id/read'] = () => ({ lastReadMessageId: 'm2', lastReadPosition: 2, unreadCount: 0 })
routes['/api/settings/model-order'] = () => ({ deviceModels: { [DEVICE]: ['claude-sonnet-4-6'] } })
const GROUP = '90000000-0000-4000-8000-000000000001'
const groupMessage = (position: number, authorType: 'user' | 'bot', body: string) => ({ id: `90000000-0000-4000-8000-00000000000${position + 1}`, conversationId: GROUP, position: String(position), authorType, authorId: authorType === 'user' ? OWNER : BOT, body, mentions: [], replyToId: null, createdAt: AT })
// A bot is answering: the case that used to re-read the chat every 2.5 s.
routes['/api/conversations/:id/messages'] = url => ({ messages: url.searchParams.get('after') ? [] : [groupMessage(2, 'bot', 'Looking into the redirect now.'), groupMessage(1, 'user', 'Who can fix the sign-in redirect?')],
  nextBefore: null, agentStatus: { status: 'running' }, routingError: null, stopped: false, ...(url.searchParams.get('after') ? { unchanged: true } : {}) })
routes['/api/conversations/:id/members'] = () => ({ members: [{ id: OWNER, name: 'Ada', memberType: 'user' }, { id: BOT, name: 'Scout', memberType: 'bot', color: 'bleu', shape: 'galet' }] })
routes['/api/mobile/reactions'] = () => ({ reactions: {} })
const CONNECTION = 'a0000000-0000-4000-8000-000000000001'
routes['/api/subscriptions'] = () => ({ enabled: true, providers: [{ provider: 'claude', available: true }, { provider: 'codex', available: true }], connections: [{ id: CONNECTION, provider: 'claude', state: 'connected', revision: 1, account: 'ada@example.invalid', paused: false, bots: [] }] })
routes['/api/subscriptions/usage'] = () => ({ connections: [{ id: CONNECTION, status: 'ok', account: 'ada@example.invalid', plan: 'Max', windows: [{ kind: 'five_hour', remaining: 72, resetsAt: null }, { kind: 'weekly', remaining: 40, resetsAt: null }], observedAt: AT }] })
const PULL_REQUEST = 'https://github.com/mikka/app/pull/81'
routes['/api/github/pull-request-status'] = () => ({ viewerId: OWNER, url: PULL_REQUEST, state: 'open', updatedAt: AT, live: { workspaceId: WORKSPACE } })

const boardIssue = (id: string, title: string, status: string) => ({ id, ownerId: OWNER, ownerName: 'Ada', ownerImage: null, title, status, priority: 'normal', scope: 'workspace' as const, revision: 2,
  createdAt: new Date(AT), updatedAt: new Date(AT), identifier: `MIK-${id.slice(-1)}`, teamId: null, metadata: { ...issue(id, title).metadata, assignee: { kind: 'member' as const, id: OWNER, name: 'Ada', image: null } }, checklist: { total: 0, checked: 0, percentage: 0 } })
const boardIssues = [boardIssue(ISSUE, 'Fix sign-in redirect', 'doing'), boardIssue('30000000-0000-4000-8000-000000000002', 'Write release notes', 'todo'), boardIssue('30000000-0000-4000-8000-000000000003', 'Rotate the preview key', 'done')]
const bots = [{ id: '50000000-0000-4000-8000-000000000000', name: 'Coordinator', color: 'encre', shape: 'cercle', coordinator: true }, { id: BOT, name: 'Scout', color: 'bleu', shape: 'galet' }]
const listedThread = { id: RUN, botId: BOT, source: null, agentName: 'Scout', issueId: ISSUE, prompt: 'Fix the sign-in redirect', status: 'running' as const, error: null, createdAt: AT, updatedAt: AT, lastReply: 'Looking at the redirect handler.', lastReplyAt: AT, outcome: null, harness: 'claude_code' }

/** Each page's top-level client component, as the app mounts it, with fixture props. */
/** Words each page shows once loaded, so a crash or a skeleton cannot pass as an idle page. */
const shows: Record<string, string[]> = {
  board: ['Write release notes', 'Rotate the preview key', 'Done: the redirect is fixed.'],
  'task-detail': ['Fix sign-in redirect', 'Looking at the redirect handler.', 'Grace'],
  'bot-chat': ['Can you fix the sign-in redirect?', 'Done: the redirect is fixed.'],
  devices: ['Ada’s MacBook'],
  'artifact-viewer': ['Release notes', 'Sign-in redirect fixed.'],
  'nav-bot-list': ['Scout'],
  'group-chat': ['Who can fix the sign-in redirect?', 'Looking into the redirect now.'],
  'subscription-settings': ['ada@example.invalid'],
  'pull-request-badge': ['#81'],
}
const pages: Record<string, () => Promise<ReactNode>> = {
  board: async () => {
    const { BoardPage } = await import('../components/workspace/board-page')
    return <BoardPage issues={boardIssues as never} userId={OWNER} onOpen={noop} onUpdated={async () => {}} onBusyChange={noop} />
  },
  // A task with a running thread open on the right, its relations and its members (the members dialog's body).
  'task-detail': async () => {
    ;({ IssueThreadPanel: BudgetThreadPanel } = await import('../components/workspace/issue-thread-panel'))
    const { TaskDetail } = await import('../components/workspace/task-detail')
    const { IssueMembers } = await import('../components/workspace/issue-members')
    return <><TaskDetail id={ISSUE} thread={RUN} origin="Board" user={user} navigation={{ index: 0, total: 1, onOpen: noop }} onOpen={noop} onSaved={noop} onDirty={noop} onClose={noop} onDeleted={noop} onRegisterFlush={noop} /><IssueMembers id={ISSUE} /></>
  },
  'bot-chat': async () => {
    const { CoordinatorChat } = await import('../components/coordinator/coordinator-chat')
    return <CoordinatorChat onOpenIssue={noop} userId={OWNER} bot={bots[1]} />
  },
  devices: async () => {
    const { DevicesSettings } = await import('../components/devices/devices-settings')
    return <DevicesSettings workspaceId={WORKSPACE} />
  },
  // The chat beside the reader is the bot chat, measured on its own page.
  'artifact-viewer': async () => {
    const { ArtifactViewer } = await import('../components/artifacts/artifact-viewer')
    return <ArtifactViewer artifactId={ARTIFACT} onArtifactChange={noop} onClose={noop} bot={{ name: 'Scout', avatar: null }} quotes={[]} chat={() => null} />
  },
  'nav-bot-list': async () => {
    const { BotList } = await import('../components/nav/bot-list')
    return <BotList bots={bots} workspaceId={WORKSPACE} threads={[listedThread]} issues={boardIssues as never} active={{ kind: 'coordinator' }} onOpen={noop} onNewBot={noop} rail={null} onRail={noop} user={user} onSettings={noop} onSignOut={noop} signingOut={false} />
  },
  'group-chat': async () => {
    const { GroupChatView } = await import('../components/workspace/group-chat-view')
    return <GroupChatView group={{ id: GROUP, title: 'Sign-in', workspaceId: WORKSPACE }} userId={OWNER} people={new Map([[OWNER, 'Ada']])} />
  },
  // 设置 › 模型与订阅 with a connected subscription: its meters re-read on push and on a stale focus only.
  'subscription-settings': async () => {
    const { SubscriptionSettings } = await import('../components/settings/subscription-settings')
    return <SubscriptionSettings workspaceId={WORKSPACE} />
  },
  // A task's linked PR in its detail properties: GitHub's state through our API.
  'pull-request-badge': async () => {
    const { IssuePullRequestLink } = await import('../components/workspace/issue-pull-request-link')
    return <IssuePullRequestLink issueId={ISSUE} pr={{ url: PULL_REQUEST, state: 'open' }} />
  },
}

type Budget = { max: number; tracking?: string; why?: string }
const budgets = JSON.parse(readFileSync(new URL('idle-request-budget.json', import.meta.url), 'utf8')) as { pages: Record<string, Record<string, Budget>> }
const measured: Record<string, Record<string, number>> = {}

test('the budget file lists exactly the measured pages, and every allowance names its issue', () => {
  assert.deepEqual(Object.keys(budgets.pages).sort(), Object.keys(pages).sort())
  for (const [page, allowed] of Object.entries(budgets.pages)) for (const [call, budget] of Object.entries(allowed)) {
    assert.ok(Number.isInteger(budget.max) && budget.max > 0, `${page} ${call}: a budget is a positive whole number; a call with none is allowed 0`)
    assert.match(budget.tracking ?? '', /^#\d+$/, `${page} ${call}: an idle allowance names the issue that removes it`)
  }
})

for (const [name, page] of Object.entries(pages)) test(`${name}: an idle, visible minute stays within its request budget`, { timeout: 60_000 }, async () => {
  const result = await measure(await page())
  measured[name] = Object.fromEntries([...result.idle].sort(([a], [b]) => a.localeCompare(b)))
  assert.deepEqual([...result.missing], [], 'every read the page makes has a fixture, so no failure retries are counted')
  assert.equal(result.chatLoadFailure, false, 'the native chat session must be healthy before its idle budget is accepted')
  for (const words of shows[name]) assert.ok(result.text.includes(words), `${name} shows “${words}”`)
  assert.equal(result.sockets.open, result.sockets.opened, 'every live channel the page opened is still connected')
  const allowed = budgets.pages[name] ?? {}
  const over = [...result.idle].filter(([call, calls]) => calls > (allowed[call]?.max ?? 0)).map(([call, calls]) => `${call}: ${calls} calls, budget ${allowed[call]?.max ?? 0}`)
  assert.deepEqual(over, [], `${name} called the server while idle more than tests/idle-request-budget.json allows. An idle page must not call the server: let the live channel (hooks/use-live-key.tsx) say when to read`)
  const lower = Object.entries(allowed).filter(([call, budget]) => (result.idle.get(call) ?? 0) <= budget.max / 2).map(([call, budget]) => `${call}: ${result.idle.get(call) ?? 0} calls, budget ${budget.max}`)
  assert.deepEqual(lower, [], `${name} now makes at most half its idle budget. Lower the budget in tests/idle-request-budget.json to the measured value (remove the entry at 0); budgets only go down`)
})

after(() => { if (process.env.IDLE_BUDGET_REPORT) console.log(JSON.stringify(measured, null, 2)) })
