import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import type { Cache } from 'swr'
import { Window } from 'happy-dom'
import * as live from '@/hooks/use-live-key'
import * as groupMessages from '@/lib/group-messages'
import { ViewStateProvider } from '@/lib/hooks/view-state'
import { Textarea } from '@/components/ui/textarea'

const browser = new Window({ url: 'https://fixture.example/?group=group-one' })
const nothing = () => {}
const empty = () => null
const translate = (key: string) => key
let failure: Error | null = null
let readWait: Promise<void> | null = null
let reads = 0
mock.module('next-intl', { namedExports: { useTranslations: () => translate, useMessages: () => ({ AgentCopy: {} }), useFormatter: () => ({}) } })
mock.module('@/lib/group-messages', { namedExports: { ...groupMessages, fetchGroupMessages: async () => {
  reads++
  if (readWait) await readWait
  if (failure) throw failure
  return { messages: [{ id: 'message-one', conversationId: 'group-one', position: '1', authorType: 'user', authorId: 'owner', body: 'Stored history', mentions: [], replyToId: null, createdAt: '2026-11-07T00:00:00Z' }], nextBefore: null } satisfies groupMessages.GroupMessagePage
} } })
mock.module('sonner', { namedExports: { toast: { error: nothing, dismiss: nothing } } })
mock.module('@/hooks/use-live-key', { namedExports: { ...live, useLiveKey: nothing } })
mock.module('@/lib/use-action-error', { namedExports: { useActionError: () => translate } })
mock.module('@/app/actions/agents', { namedExports: { listAgents: async () => [] } })
mock.module('@/app/actions/link-preview', { namedExports: { getLinkPreview: async () => null } })
mock.module('@/components/nav/conversation-pill', { namedExports: { ConversationPill: empty } })
mock.module('@/components/nav/group-avatar', { namedExports: { GroupAvatar: empty, groupMembersKey: (id: string) => ['group-members', id], memberAvatar: (member: { id: string }) => ({ id: member.id }), useGroupMembers: () => ({ data: [] }) } })
mock.module('@/components/nav/letter-avatar', { namedExports: { LetterAvatar: empty } })
mock.module('@/components/nav/bot-avatar', { namedExports: { BotAvatar: empty } })
mock.module('@/components/workspace/agent-markdown', { namedExports: { AgentMarkdown: empty } })
mock.module('@/components/workspace/message-reactions', { namedExports: { MessageReactions: empty, useMessageReactions: () => ({}) } })
mock.module('@/components/coordinator/chat-composer', { namedExports: { ChatComposer: ({ value, label, disabled }: { value: string; label: string; disabled: boolean }) => <Textarea aria-label={label} value={value} disabled={disabled} readOnly /> } })

let GroupChatView: typeof import('./group-chat-view')['GroupChatView']
let SWRConfig: typeof import('swr')['SWRConfig']
let useSWRConfig: typeof import('swr')['useSWRConfig']
let infiniteKey: typeof import('swr/infinite')['unstable_serialize']
let createRoot: typeof import('react-dom/client')['createRoot']
let refresh: () => Promise<unknown>
let root: Root, container: HTMLDivElement, cache: Cache
function ReadControl() {
  const { mutate } = useSWRConfig()
  refresh = () => mutate(infiniteKey(() => ['group-messages', 'group-one', null]))
  return null
}
before(async () => {
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'ResizeObserver'] as const) Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? browser : browser[key] })
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: browser.getComputedStyle.bind(browser) })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ SWRConfig, useSWRConfig } = await import('swr'))
  ;({ unstable_serialize: infiniteKey } = await import('swr/infinite'))
  ;({ GroupChatView } = await import('./group-chat-view'))
})
beforeEach(() => {
  failure = null; readWait = null; reads = 0; cache = new Map(); browser.sessionStorage.clear()
  container = browser.document.createElement('div') as unknown as HTMLDivElement; document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
after(() => browser.happyDOM.close())
async function render(visible = true) {
  await act(async () => root.render(<SWRConfig value={{ provider: () => cache, shouldRetryOnError: false, revalidateOnFocus: false, revalidateOnReconnect: false }}>
    <ReadControl /><ViewStateProvider scope="owner:workspace">
      {visible && <GroupChatView group={{ id: 'group-one', title: 'Fixture group', workspaceId: 'workspace' }} userId="owner" people={new Map()} />}
    </ViewStateProvider>
  </SWRConfig>))
}
const input = () => container.querySelector('textarea')!
test('a refused group retry completing across a quick remount unlocks the current view', async () => {
  await render()
  for (let attempt = 0; attempt < 30 && !container.querySelector('ol'); attempt++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  assert.ok(container.querySelector('ol'))
  failure = new groupMessages.GroupMessagesRequestError('not_found')
  await act(async () => { await refresh().catch(() => {}) })
  assert.equal(input().disabled, true)
  failure = null
  let release!: () => void
  readWait = new Promise<void>(resolve => { release = resolve })
  let pending!: Promise<unknown>
  const before = reads
  await act(async () => { pending = refresh() })
  assert.equal(reads, before + 1)
  await render(false)
  await render()
  assert.equal(reads, before + 1, 'the reopen deduplicates the pending successful read')
  await act(async () => { release(); await pending })
  for (let attempt = 0; attempt < 30 && input().disabled; attempt++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  assert.equal(input().disabled, false, 'the successful read unlocks the current mounted chat, not only the old onSuccess owner')
  assert.ok(container.querySelector('ol'))
})
