import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, createContext, type ReactNode, type Ref } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import { emptySessionView } from 'eve/events'
import { ViewStateProvider } from '@/lib/hooks/view-state'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

let reply: unknown = { queued: true }
let calls = 0
let currentBuild = true
let buildCheck = async () => currentBuild
let submissions = 0, removedNotes = 0, scrollRequests = 0
const submitted: { text: string; context: { retryOf?: number } | undefined }[] = []
let chatItems: import('@/lib/coordinator/context').ChatItem[] = []
let chatError: string | null = null
let chatEnabled = false
let streamStatus: 'idle' | 'resuming' = 'idle'
let welcomeReply: unknown = { queued: true }
let welcomeCalls = 0
const modelPicks: (string | null)[] = []
// A chat whose welcome failed: its read, the model menu's 可用, the refusal code and whether the tab is visible.
let chatData: Record<string, unknown> | null = null
let menu: unknown = undefined
let refusalCode: string | null = null
let visibility: 'visible' | 'hidden' = 'visible'
let versionReads = 0
let pageRefreshRequired = false
let pathname = '/mikka/en', search = ''
let serverVersion: { build: string } = { build: 'fixture-current' }
const notices: unknown[] = []
const notes = [{ n: 1, kind: 'region' as const, url: 'https://example.com', label: 'fixture', note: 'keep this note', rect: { x: 0, y: 0, width: 1, height: 1, viewportWidth: 1, viewportHeight: 1 } }]
let composer: { sending?: boolean; editableWhileSending?: boolean; value: string; onChange: (value: string) => void; onSubmit: () => void }
const plain = ({ children }: { children?: ReactNode }) => <div>{children}</div>
const nothing = () => null
const artifactChat = { activeArtifactId: 'fixture-artifact', quote: null, clearQuote: nothing, openArtifact: nothing }
mock.module(new URL('../../hooks/use-factory-questions.ts', import.meta.url).href, { namedExports: {
  factoryQuestionUnavailable: () => null,
  useFactoryQuestions: () => ({ questions: [], error: null, reload: nothing }),
} })
mock.module(new URL('../slots/thread.tsx', import.meta.url).href, { namedExports: {
  ThreadScreen: (props: import('../slots/thread-contract').ThreadScreenProps) => {
    composer = props.composer
    const { entries } = props
    return <div data-official-thread="">
    {entries?.map(entry => entry.role === 'person' ? <div key={entry.id} data-testid={entry.status === 'failed' ? 'failed-message' : 'local-message'}>
      {entry.text}{entry.attachments?.map(item => <span key={item.id}>{item.name}</span>)}{entry.deliveryMessage}
      {entry.onRetry && <Button onClick={entry.onRetry}>Retry</Button>}
    </div> : <div key={entry.id}>{entry.parts.map((part, i) =>
      part.kind === 'error' ? <span key={i}>{part.text}{part.actions}</span> : null)}</div>)}
  </div>
  },
} })
// Portal primitives cache DOM availability on import; this fixture imports the
// shared Button before happy-dom. Keep this unit focused on guard state; the
// real portal is reviewed in the production-build screenshots.
mock.module(new URL('../ui/alert-dialog.tsx', import.meta.url).href, { namedExports: {
  AlertDialog: ({ open, children }: { open: boolean; children: ReactNode }) => open ? <div role="alertdialog">{children}</div> : null,
  AlertDialogContent: plain, AlertDialogHeader: plain, AlertDialogTitle: plain, AlertDialogFooter: plain,
} })
mock.module(new URL('../../app/actions/coordinator.ts', import.meta.url).href, { namedExports: {
  retryCoordinatorTurn: async () => { calls++; if (reply instanceof Error) throw reply; if (typeof reply === 'function') return reply(); return reply },
  getCoordinatorChat: async () => ({}), pollCoordinatorChat: async () => ({}), syncCoordinatorChat: async () => ({}), coordinatorHistory: async () => ({}), stopCoordinatorTurn: async () => ({}),
  welcomeCoordinator: async () => { welcomeCalls++; if (welcomeReply instanceof Error) throw welcomeReply; if (typeof welcomeReply === 'function') return welcomeReply(); return welcomeReply }, coordinatorCitationSources: async () => ({}),
} })
mock.module(new URL('../../app/actions/execution-settings.ts', import.meta.url).href, { namedExports: { getBotModelMenu: async () => ({}) } })
mock.module('next-intl', { namedExports: { useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}` } })
mock.module(new URL('../../lib/use-action-error.ts', import.meta.url).href, { namedExports: { useActionError: () => (key: string) => `Errors.${key}` } })
mock.module(new URL('../../lib/billing/verification-client.ts', import.meta.url).href, { namedExports: { hostedRefusal: () => refusalCode } })
mock.module(new URL('../../lib/app-build.ts', import.meta.url).href, { namedExports: {
  checkPageBuildBeforeAction: () => buildCheck(),
  markPageNeedsRefresh: () => { pageRefreshRequired = true }, pageNeedsRefresh: () => pageRefreshRequired, APP_BUILD: 'fixture-current', STALE_BUILD_EVENT: 'mikka:stale-build',
  subscribePageRefresh: (target: Pick<Window, 'addEventListener' | 'removeEventListener'>, offer: () => void) => {
    target.addEventListener('mikka:stale-build', offer)
    if (pageRefreshRequired) offer()
    return () => { target.removeEventListener('mikka:stale-build', offer) }
  },
  isStaleBuild: (page: string, server: string) => Boolean(page && server && page !== server),
  desktopBelowMinimum: () => false,
  readAppVersion: async () => { versionReads++; return serverVersion },
} })
mock.module('next/navigation', { namedExports: { usePathname: () => pathname, useSearchParams: () => new URLSearchParams(search) } })
mock.module(new URL('../../i18n/navigation.ts', import.meta.url).href, { namedExports: { Link: plain, useRouter: () => ({ push: nothing }), usePathname: () => pathname } })
mock.module('sonner', { namedExports: { toast: Object.assign((...args: unknown[]) => { notices.push(args) }, { error: nothing }) } })
mock.module('swr', { defaultExport: (key: unknown) => Array.isArray(key) && key[0] === 'bot-model-menu' ? { data: menu, mutate: async () => {} } : ({ data: chatData ?? { items: chatItems, enabled: chatEnabled, working: false, error: chatError, artifacts: {} }, mutate: async () => {} }), namedExports: { useSWRConfig: () => ({ mutate: async () => {} }), unstable_serialize: (key: unknown) => JSON.stringify(key) } })
mock.module(new URL('./use-coordinator-submit.ts', import.meta.url).href, { namedExports: { useCoordinatorSubmit: () => ({ submit: async (text: string, context?: { retryOf?: number }) => { submissions++; submitted.push({ text, context }); return { kind: 'accepted' } }, failureMessage: () => 'fixture failed' }) } })
mock.module(new URL('./use-coordinator-agent.ts', import.meta.url).href, { namedExports: { useCoordinatorAgent: () => ({ replies: [], error: false, reconnect: nothing, status: streamStatus, view: emptySessionView(), session: { sessionId: 'wrun_fixture' } }) } })
mock.module(new URL('./chat-composer.tsx', import.meta.url).href, { namedExports: { ChatComposer: (props: { value: string; onChange: (value: string) => void; onSubmit: () => void; ref: Ref<HTMLTextAreaElement>; quote?: ReactNode }) => {
  composer = props
  return <div>{props.quote}<Textarea ref={props.ref} value={props.value} onChange={event => props.onChange(event.target.value)} /><Button onClick={props.onSubmit}>fixture-send</Button></div>
} } })
mock.module(new URL('../ui/message-scroller.tsx', import.meta.url).href, { namedExports: Object.fromEntries([
  ...['MessageScroller', 'MessageScrollerContent', 'MessageScrollerItem', 'MessageScrollerProvider', 'MessageScrollerViewport'].map(name => [name, plain]),
  ['MessageScrollerItem', ({ children, 'data-testid': testId }: { children?: ReactNode; 'data-testid'?: string }) => <div data-testid={testId}>{children}</div>],
  ['MessageScrollerButton', nothing], ['useMessageScroller', () => ({ scrollToEnd: () => { scrollRequests++ } })],
]) })
mock.module(new URL('../workspace/agent-interaction.tsx', import.meta.url).href, { namedExports: { AgentInteractionContext: createContext({}) } })
mock.module(new URL('../workspace/agent-theme.tsx', import.meta.url).href, { namedExports: { AgentThemeProvider: plain } })
mock.module(new URL('../workspace/agent-citations.tsx', import.meta.url).href, { namedExports: { useLinkPreviews: () => ({}), LinkCitation: nothing, CitationSources: nothing, AgentCitationsContext: createContext(null) } })
mock.module(new URL('./reply-activity.tsx', import.meta.url).href, { namedExports: { ReplyActivity: nothing, ReplyWaiting: nothing, ActivityExpansionContext: createContext(null), useActivityExpansion: () => null, useThreadToolRows: () => () => [] } })
mock.module(new URL('../workspace/agent-decision.tsx', import.meta.url).href, { namedExports: { ReplyAnswer: plain } })
mock.module(new URL('../workspace/message-reactions.tsx', import.meta.url).href, { namedExports: { MessageReactions: nothing, useMessageReactions: () => ({}) } })
mock.module(new URL('../../lib/hooks/use-unread-indicators.ts', import.meta.url).href, { namedExports: { MESSAGE_POSITION_ATTR: 'data-message-position', UNREAD_DIVIDER_ATTR: 'data-unread-divider', useUnreadIndicators: () => ({ showTop: false, showBottom: false }) } })
mock.module(new URL('../browser/browser-notes.tsx', import.meta.url).href, { namedExports: { BrowserNoteChip: ({ note }: { note: { note: string } }) => <span>{note.note}</span>, BrowserNoteLine: nothing, useBrowserNotesComposer: () => ({ notes, remove: nothing, removeMany: () => { removedNotes++ } }) } })
for (const [file, names] of [
  ['./coordinator-reply.tsx', ['CoordinatorReply']], ['./chat-event-line.tsx', ['ChatEventLine']], ['./thread-card.tsx', ['ThreadCard']], 
  ['./pending-actions.tsx', ['PendingActions']], ['./subagent-login-needs.tsx', ['SubagentLoginNeeds']],
  ['./hosted-unavailable-notice.tsx', ['HostedUnavailableNotice']], ['./quota-notice.tsx', ['QuotaNotice', 'QuotaSwitchLine']],
  ['../billing/hosted-refusal-notice.tsx', ['HostedRefusalNotice']], ['../nav/bot-avatar.tsx', ['BotAvatar', 'COORDINATOR_AVATAR']],
  ['../suggestions/mobile-card.tsx', ['SentSuggestion']], ['../artifacts/artifact-card.tsx', ['ArtifactCard', 'ArtifactChip']], ['../workspace/artifact-review.tsx', ['ArtifactReviewCard']],
] as const) mock.module(new URL(file, import.meta.url).href, { namedExports: Object.fromEntries(names.map(name => [name, nothing])) })
mock.module(new URL('./bot-model-picker.tsx', import.meta.url).href, { namedExports: { BotModelPicker: nothing, openModelPicker: (botId: string | null) => { modelPicks.push(botId) }, botModelMenuKey: (botId: string | null) => ['bot-model-menu', botId ?? 'coordinator'] } })
let quoteReply: (text: string) => void = nothing
let quoteRemovals = 0
mock.module(new URL('../chat/selection-quote.tsx', import.meta.url).href, { namedExports: { QUOTE_SOURCE_ATTR: 'data-quote-source', SelectionQuote: ({ onQuote }: { onQuote: (text: string) => void }) => { quoteReply = onQuote; return null } } })
mock.module(new URL('../artifacts/artifact-quote.tsx', import.meta.url).href, { namedExports: {
  ArtifactQuoteChip: nothing, ArtifactQuoteLine: nothing,
  QuoteLine: ({ text }: { text: string }) => <span data-slot="reply-quote">{text}</span>,
  QuoteChip: ({ text, onRemove }: { text: string; onRemove: () => void }) => <span data-slot="reply-quote-chip">{text}<Button onClick={() => { quoteRemovals++; onRemove() }}>fixture-remove-quote</Button></span>,
} })
const browser = new Window({ url: 'https://fixture.example/mikka' })
let container: HTMLDivElement, root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let RetryReplyButton: typeof import('./retry-reply-button')['RetryReplyButton']
let CoordinatorChat: typeof import('./coordinator-chat')['CoordinatorChat']
let VersionGuard: typeof import('../version-guard')['VersionGuard']
before(async () => {
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true, HTMLElement: browser.HTMLElement, Element: browser.Element })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  for (const key of ['Node', 'getComputedStyle', 'MutationObserver', 'ResizeObserver'] as const) {
    const value = (browser as unknown as Record<string, unknown>)[key]
    Object.defineProperty(globalThis, key, { configurable: true, value: typeof value === 'function' && key === 'getComputedStyle' ? (value as (...args: unknown[]) => unknown).bind(browser) : value })
  }
  ;({ createRoot } = await import('react-dom/client'))
  ;({ RetryReplyButton } = await import('./retry-reply-button'))
  ;({ CoordinatorChat } = await import('./coordinator-chat'))
  ;({ VersionGuard } = await import('../version-guard'))
  Object.defineProperty(browser.document, 'visibilityState', { configurable: true, get: () => visibility })
})
beforeEach(() => { streamStatus = 'idle'; welcomeCalls = 0; welcomeReply = { queued: true }; chatData = null; menu = undefined; refusalCode = null; visibility = 'visible'; calls = 0; currentBuild = true; buildCheck = async () => currentBuild; submissions = 0; scrollRequests = 0; submitted.length = 0; chatItems = []; chatError = null; chatEnabled = false; modelPicks.length = 0; removedNotes = 0; versionReads = 0; pageRefreshRequired = false; pathname = '/mikka/en'; search = ''; serverVersion = { build: 'fixture-current' }; notices.length = 0; reply = { queued: true }; container = browser.document.createElement('div') as unknown as HTMLDivElement; document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
after(() => browser.happyDOM.close())
const render = async (onQueued = async () => {}) => { await act(async () => root.render(<RetryReplyButton botId={null} onQueued={onQueued} />)) }
const click = async () => { await act(async () => (container.querySelector('button') as HTMLButtonElement).click()) }

for (const full of [true, false]) for (const live of [true, false]) test(`a ${live ? 'current' : 'historical'} API balance refusal opens the Bot model picker in ${full ? 'full' : 'embedded'} chat without retrying`, async () => {
  chatEnabled = true
  chatError = live ? 'Step "step//@ai-sdk/workflow@2.0.80//doStreamStep" failed after 0 retries: Insufficient Balance (request_id: 11111111-1111-4111-8111-111111111111)' : null
  chatItems = [{ id: 'fixture-balance-message', position: 84, from: 'person', text: 'fixture API balance check', tools: [], threads: [], artifacts: [], createdAt: '2026-11-05T03:07:28Z', failure: { kind: 'failed', reason: 'balance' } }]
  const bot = { id: 'fixture-bot', name: 'fixture-bot' } as NonNullable<Parameters<typeof CoordinatorChat>[0]['bot']>
  await act(async () => root.render(<CoordinatorChat embedded={full ? undefined : artifactChat} bot={bot} onOpenIssue={nothing} userId="fixture-owner" />))
  const notice = container.querySelector(full ? '[data-official-thread]' : `[data-message-failure="${live ? 'live' : 'past'}"]`)!
  assert.ok(notice)
  assert.match(notice.textContent ?? '', /Coordinator.apiBalance/)
  assert.doesNotMatch(notice.textContent ?? '', /Common.retry|Coordinator.resend|request_id|doStreamStep|11111111|Billing/)
  assert.equal(notice.querySelectorAll('button').length, 1)
  assert.equal(notice.querySelector('button')?.textContent, 'Coordinator.modelPicker.changeModel')
  await act(async () => notice.querySelector<HTMLButtonElement>('button')!.click())
  assert.deepEqual(modelPicks, ['fixture-bot'])
  assert.equal(calls, 0)
  assert.equal(submissions, 0)
})

for (const live of [true, false]) test(`a ${live ? 'current' : 'historical'} cloud quota refusal offers cloud billing without resending`, async () => {
  chatEnabled = true
  chatError = live ? 'Step "step//@ai-sdk/workflow@2.0.80//doStreamStep" failed after 0 retries: cloud_quota_exhausted' : null
  chatItems = [{ id: 'fixture-cloud-quota', position: 86, from: 'person', text: 'fixture cloud quota', tools: [], threads: [], artifacts: [], createdAt: '2026-11-08T05:07:38Z', failure: { kind: 'failed', cloudCode: 'cloud_quota_exhausted' } }]
  await act(async () => root.render(<CoordinatorChat embedded={artifactChat} onOpenIssue={nothing} userId="fixture-owner" />))
  const notice = container.querySelector(`[data-message-failure="${live ? 'live' : 'past'}"]`)!
  assert.ok(notice)
  assert.match(notice.textContent ?? '', /RunErrors.cloud_quota_exhausted.default/)
  assert.doesNotMatch(notice.textContent ?? '', /Coordinator.failedTitle|Common.retry|Coordinator.resend|doStreamStep/)
  const link = notice.querySelector<HTMLAnchorElement>('a')!
  assert.equal(link.textContent, 'Settings.cloud.topUp')
  assert.equal(link.getAttribute('href'), '/api/cloud/models/billing?redirect=1')
  assert.equal(link.target, '_blank')
  assert.equal(link.rel, 'noreferrer')
  assert.equal(link.getAttribute('role'), 'link')
  assert.equal(calls, 0)
  assert.equal(submissions, 0)
})

test('a generic current reply failure retains its explicit retry action', async () => {
  chatEnabled = true
  chatError = 'model timed out'
  chatItems = [{ id: 'fixture-generic-message', position: 85, from: 'person', text: 'fixture generic check', tools: [], threads: [], artifacts: [], createdAt: '2026-11-05T03:08:00Z', failure: { kind: 'failed' } }]
  await act(async () => root.render(<CoordinatorChat embedded={artifactChat} onOpenIssue={nothing} userId="fixture-owner" />))
  const notice = container.querySelector('[data-message-failure="live"]')!
  assert.match(notice.textContent ?? '', /Coordinator.failedTitle/)
  assert.equal(notice.querySelector('button')?.textContent, 'Common.retry')
  await act(async () => notice.querySelector<HTMLButtonElement>('button')!.click())
  assert.equal(calls, 1)
  assert.deepEqual(modelPicks, [])
})

test('background chat catch-up preserves the reading position and an in-progress draft', async () => {
  const message = (position: number): import('@/lib/coordinator/context').ChatItem => ({ id: `fixture-person-${position}`, position, from: 'person', text: `message ${position}`, tools: [], threads: [], artifacts: [], createdAt: '2026-11-06T20:00:00Z' })
  chatItems = [message(1)]
  const renderChat = () => root.render(<CoordinatorChat embedded={artifactChat} onOpenIssue={nothing} userId="fixture-owner" />)
  await act(async () => renderChat())
  await act(async () => composer.onChange('keep reading and editing'))
  const editor = container.querySelector('textarea')!
  editor.focus()
  editor.setSelectionRange(5, 12)
  assert.equal(scrollRequests, 0)
  // A live push or reconnect can reveal messages sent from another window.
  chatItems = [...chatItems, message(3), message(5)]
  await act(async () => renderChat())
  assert.equal(scrollRequests, 0, 'background data must not request a jump to the end')
  assert.equal(composer.value, 'keep reading and editing')
  assert.equal(document.activeElement, editor, 'background data keeps the focused composer mounted')
  assert.deepEqual([editor.selectionStart, editor.selectionEnd], [5, 12])
})

test('an accepted send in this composer scrolls once; unrelated reads do not scroll again', async () => {
  await act(async () => root.render(<CoordinatorChat embedded={artifactChat} onOpenIssue={nothing} userId="fixture-owner" />))
  await act(async () => composer.onChange('a deliberate local send'))
  await act(async () => composer.onSubmit())
  assert.equal(submissions, 1)
  assert.equal(scrollRequests, 1)
  await act(async () => root.render(<CoordinatorChat embedded={artifactChat} onOpenIssue={nothing} userId="fixture-owner" />))
  assert.equal(scrollRequests, 1)
})

test('existing window drafts migrate once and survive a chat remount in the scoped store', async () => {
  browser.sessionStorage.clear()
  browser.sessionStorage.setItem('mikka:draft:fixture-owner:coordinator', 'draft from before this fix')
  const chat = () => <ViewStateProvider scope="fixture-owner:workspace"><CoordinatorChat onOpenIssue={nothing} userId="fixture-owner" /></ViewStateProvider>
  await act(async () => root.render(chat()))
  assert.equal(composer.value, 'draft from before this fix')
  assert.equal(browser.sessionStorage.getItem('mikka:draft:fixture-owner:coordinator'), null)
  await act(async () => root.render(null))
  await act(async () => root.render(chat()))
  assert.equal(composer.value, 'draft from before this fix')
  await act(async () => composer.onChange(''))
  await act(async () => root.render(null))
  await act(async () => root.render(chat()))
  assert.equal(composer.value, '')
  browser.sessionStorage.clear()
})

for (const valid of [false, true]) test(`retrying a historical failure ${valid ? 'keeps retryOf in the submission' : 'keeps the original bubble when stale'}`, async () => {
  currentBuild = valid
  chatItems = [{ id: 'fixture-failed-message', position: 7, from: 'person', text: 'retry this original message', tools: [], threads: [], artifacts: [], createdAt: '2026-11-02T20:00:00Z', failure: { kind: 'failed' } }]
  await act(async () => root.render(<CoordinatorChat embedded={artifactChat} onOpenIssue={nothing} userId="fixture-owner" />))
  assert.match(container.textContent ?? '', /retry this original message/)
  await act(async () => container.querySelector<HTMLButtonElement>('[data-message-failure="past"] button')!.click())
  assert.equal(submissions, valid ? 1 : 0)
  if (valid) {
    assert.equal(submitted[0].text, 'retry this original message')
    assert.equal(submitted[0].context?.retryOf, 7)
    assert.equal(container.querySelector('[data-message-failure="past"]'), null)
  } else {
    assert.match(container.textContent ?? '', /retry this original message/)
    assert.equal(container.querySelectorAll('[data-message-failure="past"]').length, 0)
    assert.equal(container.querySelectorAll('[data-testid="failed-message"]').length, 1)
    assert.match(container.querySelector('[data-testid="failed-message"]')!.textContent ?? '', /retry this original message/)
  }
})

for (const valid of [true, false]) test(`parallel sends during a pending version probe are serialized (${valid ? 'current' : 'stale'})`, async () => {
  let finish!: (value: boolean) => void
  let probes = 0
  const pending = new Promise<boolean>(resolve => { finish = resolve })
  buildCheck = () => { probes++; return pending }
  await act(async () => root.render(<CoordinatorChat embedded={artifactChat} onOpenIssue={nothing} userId="fixture-owner" />))
  await act(async () => composer.onChange('one immutable draft'))
  await act(async () => { composer.onSubmit(); composer.onSubmit() })
  assert.equal(composer.value, '')
  assert.match(container.querySelector('[data-testid="local-message"]')?.textContent ?? '', /one immutable draft/)
  assert.equal(probes, 1)
  assert.equal(submissions, 0)
  await act(async () => finish(valid))
  assert.equal(submissions, valid ? 1 : 0)
  if (!valid) {
    assert.equal(composer.value, '')
    assert.match(container.querySelector('[data-testid="failed-message"]')?.textContent ?? '', /one immutable draft/)
    assert.equal(removedNotes, 0)
  }
  // The lock is released on both the stale early return and a completed send.
  buildCheck = async () => true
  await act(async () => composer.onChange('a later explicit message'))
  await act(async () => composer.onSubmit())
  assert.equal(submissions, valid ? 2 : 1)
})

test('a stale send moves its original text and attachments to the retry bubble and preserves browser notes', async () => {
  currentBuild = false
  await act(async () => root.render(<CoordinatorChat embedded={artifactChat} onOpenIssue={nothing} userId="fixture-owner" />))
  const draft = 'keep my draft\n\n[attached.txt]\nattached content'
  await act(async () => composer.onChange(draft))
  await act(async () => composer.onSubmit())
  assert.equal(submissions, 0)
  assert.equal(composer.value, '')
  assert.match(container.querySelector('[data-testid="failed-message"]')?.textContent ?? '', /attached content/)
  assert.equal(removedNotes, 0)
  assert.match(container.textContent ?? '', /keep this note/)
  assert.ok(container.querySelector('[data-testid="failed-message"] button'))
})

test('a stale send keeps the immutable artifact quote on the pending message', async () => {
  currentBuild = false
  let cleared = 0
  const embedded = { quote: { artifactId: 'fixture-artifact', version: 1, kind: 'text' as const, text: 'keep this quote', label: 'fixture' }, clearQuote: () => { cleared++ }, openArtifact: nothing, activeArtifactId: 'fixture-artifact' }
  await act(async () => root.render(<CoordinatorChat onOpenIssue={nothing} userId="fixture-owner" embedded={embedded} />))
  await act(async () => composer.onChange('keep the quote attached'))
  await act(async () => composer.onSubmit())
  assert.equal(submissions, 0)
  assert.equal(cleared, 1)
  assert.match(container.querySelector('[data-testid="failed-message"]')?.textContent ?? '', /fixture/)
  assert.equal(composer.value, '')
})

test('required refresh raised before VersionGuard mounts still shows a prompt without document reload', async () => {
  pageRefreshRequired = true
  await act(async () => root.render(<VersionGuard />))
  assert.match(document.body.textContent ?? '', /Common.appUpdated/)
})

test('switching only the Bot search parameter checks the page version and requires a refresh', async () => {
  await act(async () => root.render(<VersionGuard />))
  assert.equal(versionReads, 1)
  assert.equal(notices.length, 0)
  search = 'bot=fixture-new-bot'
  serverVersion = { build: 'fixture-new' }
  await act(async () => root.render(<VersionGuard />))
  assert.equal(versionReads, 2)
  assert.match(document.body.textContent ?? '', /Common.appUpdated/)
})

test('a stale page does not retry the old action or claim it queued a reply', async () => {
  currentBuild = false
  let refreshes = 0
  await render(async () => { refreshes++ })
  await click()
  assert.equal(calls, 0)
  assert.equal(refreshes, 0)
  assert.equal(container.querySelector('[role="status"]'), null)
  assert.equal(container.querySelector('button')?.disabled, false)
})

test('a returned action error is visible and does not claim the reply was queued', async () => {
  reply = { error: 'authRequired' }; let queued = 0
  await render(async () => { queued++ }); await click()
  assert.equal(container.querySelector('[role="alert"]')?.textContent, 'Errors.authRequired')
  assert.equal(queued, 0)
})
for (const reason of ['working', 'nothingToRetry', 'unavailable']) test(`queued:false reports ${reason} instead of silent success`, async () => {
  reply = { queued: false, reason }; let refreshed = 0
  await render(async () => { refreshed++ }); await click()
  assert.match(container.textContent ?? '', new RegExp(`Coordinator.replyRetry.${reason}`))
  assert.equal(refreshed, 1)
})
test('a transport rejection reports an unconfirmed retry without exposing its message', async () => {
  reply = new Error('fixture-private-upstream-details')
  await render(); await click()
  assert.match(container.textContent ?? '', /Coordinator.replyRetry.unconfirmed/)
  assert.ok(!container.textContent?.includes('fixture-private'))
})
test('a confirmed enqueue survives a refresh error and cannot be submitted twice while pending', async () => {
  let finish!: (value: unknown) => void
  reply = () => new Promise(resolve => { finish = resolve })
  await render(async () => { throw new Error('fixture-refetch-failed') })
  await act(async () => { const button = container.querySelector('button')!; button.click(); button.click() })
  assert.equal(calls, 1)
  await act(async () => finish({ queued: true }))
  assert.match(container.textContent ?? '', /Coordinator.replyRetry.queued/)
})

test('words quoted from a reply wait above the draft, head the sent message as quote lines and then leave', async () => {
  await act(async () => root.render(<CoordinatorChat embedded={artifactChat} onOpenIssue={nothing} userId="fixture-owner" />))
  await act(async () => quoteReply('先把首页截图放大\n再换成深色'))
  assert.equal(container.querySelector('[data-slot="reply-quote-chip"]')?.textContent?.startsWith('先把首页截图放大'), true)
  await act(async () => composer.onChange('要整宽还是半宽？'))
  await act(async () => composer.onSubmit())
  assert.equal(submitted[0].text, '> 先把首页截图放大\n> 再换成深色\n\n要整宽还是半宽？')
  assert.equal(container.querySelector('[data-slot="reply-quote-chip"]'), null)
})

test('a removed quote is not sent', async () => {
  quoteRemovals = 0
  await act(async () => root.render(<CoordinatorChat embedded={artifactChat} onOpenIssue={nothing} userId="fixture-owner" />))
  await act(async () => quoteReply('不要这段'))
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'fixture-remove-quote')!.click())
  assert.equal(quoteRemovals, 1)
  await act(async () => composer.onChange('只发这句'))
  await act(async () => composer.onSubmit())
  assert.equal(submitted[0].text, '只发这句')
})

test('a sent message that quotes a reply shows the quote above its words, and every message has 复制', async () => {
  chatItems = [
    { id: 'fixture-reply', position: 1, from: 'coordinator', text: '**首页**已改好', tools: [], threads: [], artifacts: [], createdAt: '2026-11-03T04:00:00Z' },
    { id: 'fixture-person', position: 2, from: 'person', text: '> 首页已改好\n\n截图呢？', tools: [], threads: [], artifacts: [], createdAt: '2026-11-03T04:01:00Z' },
  ]
  await act(async () => root.render(<CoordinatorChat embedded={artifactChat} onOpenIssue={nothing} userId="fixture-owner" />))
  assert.equal(container.querySelector('[data-slot="reply-quote"]')?.textContent, '首页已改好')
  assert.match(container.textContent ?? '', /截图呢？/)
  assert.doesNotMatch(container.textContent ?? '', /> 首页/)
  assert.equal(container.querySelectorAll('[data-slot="message-actions"] [data-copy-state]').length, 2)
})


test('an idle page detects the new build on its minute probe and keeps the draft mounted', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const page = () => <><VersionGuard /><Textarea defaultValue="keep this draft" /></>
  await act(async () => root.render(page()))
  const draft = container.querySelector('textarea')!
  serverVersion = { build: 'fixture-new' }
  await act(async () => t.mock.timers.tick(60_000))
  assert.equal(versionReads, 2)
  assert.match(document.querySelector('[role="alertdialog"]')?.textContent ?? '', /Common.refresh/)
  assert.equal(container.querySelector('textarea'), draft)
  assert.equal(draft.value, 'keep this draft')
  await act(async () => root.render(null))
  await act(async () => t.mock.timers.tick(60_000))
  assert.equal(versionReads, 2, 'unmount clears the probe')
})

// A [Welcome] turn that failed (store.failTurn): the chat as chatView reads it.
const welcomeFailed = (error = 'Error: verification_required') => {
  chatItems = [{ id: 'fixture-welcome', position: 1, from: 'coordinator', text: '', tools: [], threads: [], artifacts: [], createdAt: '2026-11-05T03:00:00Z', welcome: true, failure: { kind: 'hosted', code: 'verification_required' } }]
  chatData = { items: chatItems, enabled: true, working: false, error, artifacts: {} }
  refusalCode = error.includes('verification_required') ? 'verification_required' : error
}
const chat = () => root.render(<CoordinatorChat embedded={artifactChat} onOpenIssue={nothing} userId="fixture-owner" />)

test('a failed welcome shows on the Bot\'s side in the chat, not only above the composer', async () => {
  welcomeFailed()
  await act(async () => chat())
  assert.ok(container.querySelector('[data-message-failure="welcome"]'), 'the welcome failure sits in the chat')
  assert.equal(calls, 0)
})

test('the refused welcome is not retried when the model already reads runnable on open', async () => {
  welcomeFailed(); menu = { current: { id: 'mikka', available: true } }
  await act(async () => chat())
  await act(async () => chat())
  assert.equal(calls, 0, 'opening the chat never fires another refused turn')
})

test('the refused welcome runs again exactly once when its model turns runnable while the chat is open', async () => {
  welcomeFailed(); menu = { current: { id: 'mikka', available: false } }
  await act(async () => chat())
  assert.equal(calls, 0)
  menu = { current: { id: 'mikka', available: true } }
  await act(async () => chat())
  await act(async () => chat())
  assert.equal(calls, 1)
})

for (const code of ['usage_in_progress', 'usage_concurrency_limit', 'usage_cost_unavailable']) test(`a passing usage limit (${code}) is never retried on its own`, async () => {
  welcomeFailed(code); menu = { current: { id: 'mikka', available: false } }
  await act(async () => chat())
  menu = { current: { id: 'mikka', available: true } }
  await act(async () => chat())
  assert.equal(calls, 0)
})

test('a hidden tab never retries the welcome', async () => {
  welcomeFailed(); visibility = 'hidden'; menu = { current: { id: 'mikka', available: false } }
  await act(async () => chat())
  menu = { current: { id: 'mikka', available: true } }
  await act(async () => chat())
  assert.equal(calls, 0)
})

for (const failure of [new Error('private transport detail'), { error: 'authRequired' }]) test(`a welcome ${failure instanceof Error ? 'transport rejection' : 'action refusal'} stops the waiting line and offers a guarded explicit retry`, async () => {
  chatEnabled = true
  welcomeReply = failure
  await act(async () => chat())
  assert.equal(welcomeCalls, 1)
  const notice = container.querySelector('[data-chat-failure="welcome-request"]')!
  assert.ok(notice)
  assert.doesNotMatch(container.textContent ?? '', /writingWelcome|private transport detail/)
  const retry = notice.parentElement!.querySelector<HTMLButtonElement>('button')!
  assert.equal(retry.textContent, 'Common.retry')
  await act(async () => chat())
  assert.equal(welcomeCalls, 1, 'rendering a failed welcome does not submit it again')
  currentBuild = false
  await act(async () => retry.click())
  assert.equal(welcomeCalls, 1, 'stale-build retry keeps the existing page guard')
  currentBuild = true
  let finish!: (value: unknown) => void
  welcomeReply = () => new Promise(resolve => { finish = resolve })
  await act(async () => { retry.click(); retry.click() })
  assert.equal(welcomeCalls, 2, 'one request even before the asynchronous build guard finishes')
  assert.equal(retry.disabled, true)
  await act(async () => finish({ queued: false }))
  assert.equal(container.querySelector('[data-chat-failure="welcome-request"]'), null)
})

test('a rejected automatic welcome recovery retains its stored refusal and never rejects the render effect', async () => {
  welcomeFailed(); menu = { current: { id: 'mikka', available: false } }
  await act(async () => chat())
  reply = new Error('private recovery transport detail')
  menu = { current: { id: 'mikka', available: true } }
  await act(async () => chat())
  assert.equal(calls, 1)
  assert.ok(container.querySelector('[data-message-failure="welcome"]'))
  assert.doesNotMatch(container.textContent ?? '', /private recovery transport detail/)
  await act(async () => chat())
  assert.equal(calls, 1)
})

test('a reconnect keeps the first draft editable without sending or stopping the recovering turn', async () => {
  chatEnabled = true
  const show = () => act(async () => root.render(<CoordinatorChat onOpenIssue={nothing} userId="fixture-owner" />))
  await show()
  assert.equal(composer.sending, false)
  streamStatus = 'resuming'
  await show()
  assert.equal(composer.sending, true)
  assert.equal(composer.editableWhileSending, true)
  await act(async () => composer.onChange('first reconnect draft'))
  await act(async () => composer.onSubmit())
  assert.equal(submissions, 0)
  assert.equal(composer.value, 'first reconnect draft')
  streamStatus = 'idle'
  await show()
  assert.equal(composer.sending, false)
  assert.equal(composer.editableWhileSending, false)
  await act(async () => composer.onSubmit())
  assert.equal(submissions, 1)
  assert.equal(submitted[0].text, 'first reconnect draft')
})
