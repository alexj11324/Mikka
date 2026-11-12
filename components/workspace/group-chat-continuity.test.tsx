import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import * as live from '@/hooks/use-live-key'
import * as groupMessages from '@/lib/group-messages'
import type { GroupMessage, GroupMessagePage } from '@/lib/group-messages'
import { ViewStateProvider, useViewState } from '@/lib/hooks/view-state'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

const nothing = () => {}
const empty = () => null
const translate = (key: string) => key
let pages: GroupMessagePage[] | undefined
let readError: Error | undefined
let reads = 0
const mutate = async () => { reads++; return pages }
const sent: { group: string; body: string }[] = []
let post: (id: string, body: string) => Promise<GroupMessage>
const notices = new Map<string, { message: string; action?: { label: string; onClick: (event: Event) => void } }>()
mock.module('next-intl', { namedExports: { useTranslations: () => translate, useMessages: () => ({ AgentCopy: {} }), useFormatter: () => ({}) } })
mock.module('swr', { defaultExport: () => ({ data: undefined }), namedExports: { useSWRConfig: () => ({ mutate: async () => {} }), unstable_serialize: (key: unknown) => JSON.stringify(key) } })
mock.module('swr/infinite', { defaultExport: () => ({ data: pages, error: readError, size: 1, setSize: async () => {}, mutate, isValidating: false }), namedExports: { unstable_serialize: (getKey: (index: number, previous: null) => unknown) => '$inf$' + JSON.stringify(getKey(0, null)) } })
mock.module('@/lib/group-messages', { namedExports: { ...groupMessages, postGroupMessage: async (id: string, body: string) => { sent.push({ group: id, body }); return post(id, body) } } })
mock.module('sonner', { namedExports: { toast: {
  error: (message: string, options?: { id?: string; action?: { label: string; onClick: (event: Event) => void } }) => { notices.set(options?.id ?? message, { message, action: options?.action }) },
  dismiss: (id: string) => { notices.delete(id) },
} } })
mock.module('@/hooks/use-live-key', { namedExports: { ...live, useLiveKey: nothing } })
mock.module('@/lib/use-action-error', { namedExports: { useActionError: () => translate } })
mock.module('@/app/actions/agents', { namedExports: { listAgents: async () => [] } })
mock.module('@/app/actions/link-preview', { namedExports: { getLinkPreview: async () => null } })
mock.module('@/components/nav/conversation-pill', { namedExports: { ConversationPill: empty } })
mock.module('@/components/nav/group-avatar', { namedExports: { GroupAvatar: empty, groupMembersKey: (id: string) => ['group-members', id], memberAvatar: (member: { id: string }) => ({ id: member.id }), useGroupMembers: () => ({ data: [] }) } })
mock.module('@/components/nav/letter-avatar', { namedExports: { LetterAvatar: empty } })
mock.module('@/components/nav/bot-avatar', { namedExports: { BotAvatar: empty } })
mock.module('@/components/workspace/agent-markdown', { namedExports: { AgentMarkdown: ({ text }: { text: string }) => <p>{text}</p> } })
mock.module('@/components/workspace/message-reactions', { namedExports: { MessageReactions: empty, useMessageReactions: () => ({}) } })
type ComposerProps = { value: string; onChange: (value: string) => void; onSubmit: () => void; disabled: boolean; label: string }
let composer: ComposerProps
mock.module('@/components/coordinator/chat-composer', { namedExports: { ChatComposer: (props: ComposerProps) => {
  composer = props
  return <div><Textarea aria-label={props.label} value={props.value} disabled={props.disabled} onChange={event => props.onChange(event.target.value)} /><Button disabled={props.disabled} onClick={props.onSubmit}>send</Button></div>
} } })

const browser = new Window({ url: 'https://fixture.example/?group=group-one' })
let root: Root, container: HTMLDivElement
let createRoot: typeof import('react-dom/client')['createRoot']
let GroupChatView: typeof import('./group-chat-view')['GroupChatView']
let pendingSnapshot: unknown[] = []
function PendingState({ groupId, owner, workspace }: { groupId: string; owner: string; workspace: string }) {
  const [value] = useViewState<unknown[]>(`chat-send:group:${owner}:${workspace}:${groupId}`, [])
  pendingSnapshot = value
  return null
}
function message(body = 'existing history', id = 'stored-one', position = '1'): GroupMessage {
  return { id, conversationId: 'group-one', position, authorType: 'user', authorId: 'owner', body, mentions: [], replyToId: null, createdAt: '2026-11-07T00:00:00Z' }
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

before(async () => {
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'ResizeObserver'] as const) Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? browser : browser[key] })
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: browser.getComputedStyle.bind(browser) })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ GroupChatView } = await import('./group-chat-view'))
})
beforeEach(() => {
  pages = [{ messages: [message()], nextBefore: null, agentStatus: null }]
  readError = undefined; reads = 0; sent.length = 0; notices.clear(); pendingSnapshot = []
  post = async () => { throw new groupMessages.GroupMessagesRequestError('unavailable') }
  browser.sessionStorage.clear()
  container = browser.document.createElement('div') as unknown as HTMLDivElement
  document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
after(() => browser.happyDOM.close())
const render = async ({ visible = true, owner = 'owner', workspace = 'workspace', groupId = 'group-one' } = {}) => {
  await act(async () => root.render(<ViewStateProvider scope={`${owner}:${workspace}`}>
    <PendingState groupId={groupId} owner={owner} workspace={workspace} />
    {visible && <GroupChatView key={groupId} group={{ id: groupId, title: 'Fixture group', workspaceId: workspace }} userId={owner} people={new Map()} />}
  </ViewStateProvider>))
}
const draft = async (value: string) => { await act(async () => composer.onChange(value)) }
const send = async () => { await act(async () => composer.onSubmit()) }
const pending = () => container.querySelector('[data-pending]')
const input = () => container.querySelector('textarea')!

test('a failed group send survives leaving for Settings and returning, with explicit retry only', async () => {
  await render(); await draft('keep the failed message'); await send()
  assert.equal(pending()?.getAttribute('data-pending'), 'failed')
  await render({ visible: false }); await render()
  assert.ok(pending()?.textContent?.includes('keep the failed message'), 'navigation must not discard the only remaining copy of a failed send')
  assert.equal(pending()?.getAttribute('data-pending'), 'failed')
  assert.equal(sent.length, 1, 'reopening the chat must not retry automatically')
  const retry = pending()!.querySelector('button')!
  await act(async () => retry.click())
  assert.equal(sent.length, 2)
  assert.deepEqual(sent.map(item => item.body), ['keep the failed message', 'keep the failed message'])
})

test('a send still in flight stays pending through a remount and receives the same late failure', async () => {
  const response = deferred<GroupMessage>()
  post = () => response.promise
  await render(); await draft('in flight'); await send()
  await render({ visible: false }); await render()
  assert.equal(pending()?.getAttribute('data-pending'), 'sending')
  assert.equal(pending()?.querySelector('button'), null, 'an in-flight send must not become retryable on remount')
  assert.equal(sent.length, 1)
  await act(async () => response.reject(new groupMessages.GroupMessagesRequestError('unavailable')))
  assert.equal(pending()?.getAttribute('data-pending'), 'failed')
  assert.ok(pending()?.textContent?.includes('in flight'))
  assert.equal(sent.length, 1)
})

test('a confirmed send finishing offscreen is never retried and is pruned when its stored message arrives', async () => {
  const response = deferred<GroupMessage>()
  post = () => response.promise
  await render(); await draft('stored offscreen'); await send()
  await render({ visible: false })
  const stored = message('stored offscreen', 'newly-stored', '2')
  await act(async () => response.resolve(stored))
  await render()
  assert.ok(pending()?.textContent?.includes('stored offscreen'))
  assert.equal(pending()?.querySelector('button'), null)
  assert.equal(sent.length, 1)
  pages = [{ messages: [stored, message()], nextBefore: null }]
  await render()
  assert.equal(pending(), null)
  assert.equal(pendingSnapshot.length, 0, 'confirmed messages must leave the scoped pending cell once read')
  assert.equal(container.querySelectorAll('ol [data-slot="user-message-text"]').length, 2)
})

test('a background read failure keeps the mounted history, failed send, draft, selection and reading position', async () => {
  await render(); await draft('failed message'); await send(); await draft('next unsent draft')
  const transcript = container.querySelector('ol')!
  const textarea = input()
  const scroller = container.querySelector('.overflow-y-auto') as HTMLDivElement
  Object.defineProperties(scroller, { scrollHeight: { configurable: true, value: 2000 }, clientHeight: { configurable: true, value: 200 } })
  scroller.scrollTop = 640
  await act(async () => { scroller.dispatchEvent(new browser.Event('scroll') as unknown as Event); textarea.focus(); textarea.setSelectionRange(5, 11) })
  readError = new groupMessages.GroupMessagesRequestError('unavailable')
  await render()
  assert.ok(container.querySelector('ol') === transcript, 'a refresh failure must not replace already visible messages')
  assert.ok(pending()?.textContent?.includes('failed message'))
  assert.ok(input() === textarea)
  assert.equal(textarea.disabled, false)
  assert.equal(textarea.value, 'next unsent draft')
  assert.ok(document.activeElement === textarea)
  assert.deepEqual([textarea.selectionStart, textarea.selectionEnd, scroller.scrollTop], [5, 11, 640])
  const notice = [...notices.values()].find(item => item.message === 'loadError')
  assert.ok(notice?.action, 'the retained history still needs a visible retry action')
  await act(async () => notice.action!.onClick(new Event('click', { cancelable: true })))
  assert.equal(reads, 1)
  readError = undefined
  await render()
  assert.equal(notices.size, 0)
  assert.ok(container.querySelector('ol') === transcript)
})

for (const code of ['unauthorized', 'not_found'] as const) test(`${code} still hides previously visible group messages and disables its composer`, async () => {
  await render(); await draft('private pending'); await send()
  readError = new groupMessages.GroupMessagesRequestError(code)
  await render()
  assert.equal(container.querySelector('ol'), null)
  assert.equal(pending(), null)
  assert.equal(input().disabled, true)
  assert.ok(container.querySelector('[role="alert"]'))
})

for (const status of [401, 403, 404]) test(`a ${status} refusal cannot revive cached group history after a later transport failure`, async () => {
  await render()
  readError = new groupMessages.GroupMessagesRequestError(status === 401 ? 'unauthorized' : status === 404 ? 'not_found' : 'unavailable', status)
  await render()
  assert.equal(!!container.querySelector('ol'), false)
  assert.equal(input().disabled, true)
  readError = new groupMessages.GroupMessagesRequestError('unavailable')
  await render()
  assert.equal(!!container.querySelector('ol'), false, 'a later network failure must not turn rejected cached data back into readable history')
  assert.equal(input().disabled, true)
  assert.equal(notices.size, 0)
  readError = undefined
  await render()
  assert.ok(container.querySelector('ol'))
  assert.equal(input().disabled, false)
})

test('an initial unavailable read keeps the existing local error state without inventing empty history', async () => {
  pages = undefined
  readError = new groupMessages.GroupMessagesRequestError('unavailable')
  await render()
  assert.equal(container.querySelector('ol'), null)
  assert.ok(container.querySelector('[role="alert"]')?.textContent?.includes('loadError'))
  assert.equal(input().disabled, true)
})

test('pending group messages stay isolated by group, authenticated owner and workspace', async () => {
  await render(); await draft('owner one pending'); await send()
  await render({ groupId: 'group-two' })
  assert.equal(pending(), null)
  await render({ owner: 'other-owner' })
  assert.equal(pending(), null)
  await render({ workspace: 'other-workspace' })
  assert.equal(pending(), null)
  await render()
  assert.ok(pending()?.textContent?.includes('owner one pending'))
  assert.equal(sent.length, 1)
})
