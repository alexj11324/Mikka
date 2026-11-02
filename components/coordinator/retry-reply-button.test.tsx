import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, createContext, type ReactNode, type Ref } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

let reply: unknown = { queued: true }
let calls = 0
let currentBuild = true
let buildCheck = async () => currentBuild
let submissions = 0, removedNotes = 0
const submitted: { text: string; context: { retryOf?: number } | undefined }[] = []
let chatItems: import('@/lib/coordinator/context').ChatItem[] = []
let versionReads = 0
let pathname = '/mikka/en', search = ''
let serverVersion: { build: string } = { build: 'fixture-current' }
const notices: unknown[] = []
const notes = [{ n: 1, kind: 'region' as const, url: 'https://example.com', label: 'fixture', note: 'keep this note', rect: { x: 0, y: 0, width: 1, height: 1, viewportWidth: 1, viewportHeight: 1 } }]
let composer: { value: string; onChange: (value: string) => void; onSubmit: () => void }
const plain = ({ children }: { children?: ReactNode }) => <div>{children}</div>
const nothing = () => null
mock.module(new URL('../../app/actions/coordinator.ts', import.meta.url).href, { namedExports: {
  retryCoordinatorTurn: async () => { calls++; if (reply instanceof Error) throw reply; if (typeof reply === 'function') return reply(); return reply },
  getCoordinatorChat: async () => ({}), stopCoordinatorTurn: async () => ({}), welcomeCoordinator: async () => ({}),
} })
mock.module('next-intl', { namedExports: { useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}` } })
mock.module(new URL('../../lib/use-action-error.ts', import.meta.url).href, { namedExports: { useActionError: () => (key: string) => `Errors.${key}` } })
mock.module(new URL('../../lib/billing/verification-client.ts', import.meta.url).href, { namedExports: { hostedRefusal: () => null } })
mock.module(new URL('../../lib/app-build.ts', import.meta.url).href, { namedExports: {
  checkPageBuildBeforeAction: () => buildCheck(),
  APP_BUILD: 'fixture-current', STALE_BUILD_EVENT: 'mikka:stale-build',
  isStaleBuild: (page: string, server: string) => Boolean(page && server && page !== server),
  desktopBelowMinimum: () => false,
  readAppVersion: async () => { versionReads++; return serverVersion },
} })
mock.module('next/navigation', { namedExports: { usePathname: () => pathname, useSearchParams: () => new URLSearchParams(search) } })
mock.module(new URL('../../i18n/navigation.ts', import.meta.url).href, { namedExports: { Link: plain, useRouter: () => ({ push: nothing }), usePathname: () => pathname } })
mock.module('sonner', { namedExports: { toast: Object.assign((...args: unknown[]) => { notices.push(args) }, { error: nothing }) } })
mock.module('swr', { defaultExport: () => ({ data: { items: chatItems, enabled: false, working: false, error: null, artifacts: {} }, mutate: async () => {} }), namedExports: { useSWRConfig: () => ({ mutate: async () => {} }) } })
mock.module(new URL('./use-coordinator-submit.ts', import.meta.url).href, { namedExports: { useCoordinatorSubmit: () => ({ submit: async (text: string, context?: { retryOf?: number }) => { submissions++; submitted.push({ text, context }); return { kind: 'accepted' } }, failureMessage: () => 'fixture failed' }) } })
mock.module(new URL('./use-coordinator-stream.ts', import.meta.url).href, { namedExports: { useCoordinatorStream: () => ({ replies: [], error: false, reconnect: nothing }) } })
mock.module(new URL('./chat-composer.tsx', import.meta.url).href, { namedExports: { ChatComposer: (props: { value: string; onChange: (value: string) => void; onSubmit: () => void; ref: Ref<HTMLTextAreaElement>; quote?: ReactNode }) => {
  composer = props
  return <div>{props.quote}<Textarea ref={props.ref} value={props.value} onChange={event => props.onChange(event.target.value)} /><Button onClick={props.onSubmit}>fixture-send</Button></div>
} } })
mock.module(new URL('../ui/message-scroller.tsx', import.meta.url).href, { namedExports: Object.fromEntries([
  ...['MessageScroller', 'MessageScrollerContent', 'MessageScrollerItem', 'MessageScrollerProvider', 'MessageScrollerViewport'].map(name => [name, plain]),
  ['MessageScrollerButton', nothing], ['useMessageScroller', () => ({ scrollToEnd: nothing })],
]) })
mock.module(new URL('../workspace/agent-interaction.tsx', import.meta.url).href, { namedExports: { AgentInteractionContext: createContext({}) } })
mock.module(new URL('../workspace/agent-theme.tsx', import.meta.url).href, { namedExports: { AgentThemeProvider: plain } })
mock.module(new URL('../workspace/agent-citations.tsx', import.meta.url).href, { namedExports: { useLinkPreviews: () => ({}), LinkCitation: nothing } })
mock.module(new URL('../workspace/agent-decision.tsx', import.meta.url).href, { namedExports: { ReplyAnswer: plain } })
mock.module(new URL('../workspace/message-reactions.tsx', import.meta.url).href, { namedExports: { MessageReactions: nothing, useMessageReactions: () => ({}) } })
mock.module(new URL('../../lib/hooks/use-unread-indicators.ts', import.meta.url).href, { namedExports: { MESSAGE_POSITION_ATTR: 'data-message-position', UNREAD_DIVIDER_ATTR: 'data-unread-divider', useUnreadIndicators: () => ({ showTop: false, showBottom: false }) } })
mock.module(new URL('../browser/browser-notes.tsx', import.meta.url).href, { namedExports: { BrowserNoteChip: ({ note }: { note: { note: string } }) => <span>{note.note}</span>, BrowserNoteLine: nothing, useBrowserNotesComposer: () => ({ notes, remove: nothing, removeMany: () => { removedNotes++ } }) } })
for (const [file, names] of [
  ['./coordinator-reply.tsx', ['CoordinatorReply']], ['./chat-event-line.tsx', ['ChatEventLine']], ['./thread-card.tsx', ['ThreadCard']], ['./tools-used.tsx', ['ToolsUsed']],
  ['./pending-actions.tsx', ['PendingActions']], ['./subagent-login-needs.tsx', ['SubagentLoginNeeds']], ['./bot-model-picker.tsx', ['BotModelPicker', 'openModelPicker']],
  ['./hosted-unavailable-notice.tsx', ['HostedUnavailableNotice']], ['./quota-notice.tsx', ['QuotaNotice', 'QuotaSwitchLine']],
  ['../billing/hosted-refusal-notice.tsx', ['HostedRefusalNotice']], ['../nav/bot-avatar.tsx', ['BotAvatar', 'COORDINATOR_AVATAR']],
  ['../suggestions/mobile-card.tsx', ['SentSuggestion']], ['../artifacts/artifact-card.tsx', ['ArtifactCard', 'ArtifactChip']],
  ['../artifacts/artifact-quote.tsx', ['ArtifactQuoteChip', 'ArtifactQuoteLine']],
] as const) mock.module(new URL(file, import.meta.url).href, { namedExports: Object.fromEntries(names.map(name => [name, nothing])) })
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
})
beforeEach(() => { calls = 0; currentBuild = true; buildCheck = async () => currentBuild; submissions = 0; submitted.length = 0; chatItems = []; removedNotes = 0; versionReads = 0; pathname = '/mikka/en'; search = ''; serverVersion = { build: 'fixture-current' }; notices.length = 0; reply = { queued: true }; container = browser.document.createElement('div') as unknown as HTMLDivElement; document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
after(() => browser.happyDOM.close())
const render = async (onQueued = async () => {}) => { await act(async () => root.render(<RetryReplyButton botId={null} onQueued={onQueued} />)) }
const click = async () => { await act(async () => (container.querySelector('button') as HTMLButtonElement).click()) }

for (const valid of [false, true]) test(`retrying a historical failure ${valid ? 'keeps retryOf in the submission' : 'keeps the original bubble when stale'}`, async () => {
  currentBuild = valid
  chatItems = [{ id: 'fixture-failed-message', position: 7, from: 'person', text: 'retry this original message', tools: [], threads: [], artifacts: [], createdAt: '2026-11-02T20:00:00Z', failure: { kind: 'failed' } }]
  await act(async () => root.render(<CoordinatorChat onOpenIssue={nothing} userId="fixture-owner" />))
  assert.match(container.textContent ?? '', /retry this original message/)
  await act(async () => container.querySelector<HTMLButtonElement>('[data-message-failure="past"] button')!.click())
  assert.equal(submissions, valid ? 1 : 0)
  if (valid) {
    assert.equal(submitted[0].text, 'retry this original message')
    assert.equal(submitted[0].context?.retryOf, 7)
    assert.equal(container.querySelector('[data-message-failure="past"]'), null)
  } else {
    assert.match(container.textContent ?? '', /retry this original message/)
    assert.ok(container.querySelector('[data-message-failure="past"]'))
    assert.equal(container.querySelector('[data-testid="failed-message"]'), null)
  }
})

for (const valid of [true, false]) test(`parallel sends during a pending version probe are serialized (${valid ? 'current' : 'stale'})`, async () => {
  let finish!: (value: boolean) => void
  let probes = 0
  const pending = new Promise<boolean>(resolve => { finish = resolve })
  buildCheck = () => { probes++; return pending }
  await act(async () => root.render(<CoordinatorChat onOpenIssue={nothing} userId="fixture-owner" />))
  await act(async () => composer.onChange('one immutable draft'))
  await act(async () => { composer.onSubmit(); composer.onSubmit() })
  assert.equal(probes, 1)
  assert.equal(submissions, 0)
  await act(async () => finish(valid))
  assert.equal(submissions, valid ? 1 : 0)
  if (!valid) {
    assert.equal(composer.value, 'one immutable draft')
    assert.equal(removedNotes, 0)
  }
  // The lock is released on both the stale early return and a completed send.
  buildCheck = async () => true
  await act(async () => composer.onChange('a later explicit message'))
  await act(async () => composer.onSubmit())
  assert.equal(submissions, valid ? 2 : 1)
})

test('a stale send leaves the composer draft, attached text and browser notes intact', async () => {
  currentBuild = false
  await act(async () => root.render(<CoordinatorChat onOpenIssue={nothing} userId="fixture-owner" />))
  const draft = 'keep my draft\n\n[attached.txt]\nattached content'
  await act(async () => composer.onChange(draft))
  await act(async () => composer.onSubmit())
  assert.equal(submissions, 0)
  assert.equal(composer.value, draft)
  assert.equal(removedNotes, 0)
  assert.match(container.textContent ?? '', /keep this note/)
  assert.equal(container.querySelector('[data-testid="failed-message"]'), null)
})

test('a stale send does not clear an artifact quote', async () => {
  currentBuild = false
  let cleared = 0
  const embedded = { quote: { artifactId: 'fixture-artifact', version: 1, kind: 'text' as const, text: 'keep this quote', label: 'fixture' }, clearQuote: () => { cleared++ }, openArtifact: nothing, activeArtifactId: 'fixture-artifact' }
  await act(async () => root.render(<CoordinatorChat onOpenIssue={nothing} userId="fixture-owner" embedded={embedded} />))
  await act(async () => composer.onChange('keep the quote attached'))
  await act(async () => composer.onSubmit())
  assert.equal(submissions, 0)
  assert.equal(cleared, 0)
  assert.equal(composer.value, 'keep the quote attached')
})

test('switching only the Bot search parameter checks the page version and offers a refresh', async () => {
  await act(async () => root.render(<VersionGuard />))
  assert.equal(versionReads, 1)
  assert.equal(notices.length, 0)
  search = 'bot=fixture-new-bot'
  serverVersion = { build: 'fixture-new' }
  await act(async () => root.render(<VersionGuard />))
  assert.equal(versionReads, 2)
  assert.equal(notices.length, 1)
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
