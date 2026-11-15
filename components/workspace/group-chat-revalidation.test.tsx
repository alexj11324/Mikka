import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import type { ReadCacheState } from '@/lib/swr/persistent-cache'
import { Window } from 'happy-dom'
import * as live from '@/hooks/use-live-key'
import * as groupMessages from '@/lib/group-messages'
import { ViewStateProvider, useForgetGroupDrafts, useViewState } from '@/lib/hooks/view-state'
import { useGroupMembershipLoss } from './group-membership-cache'
import { Textarea } from '@/components/ui/textarea'

const browser = new Window({ url: 'https://fixture.example/?group=group-one' })
const nothing = () => {}
const empty = () => null
const translate = (key: string) => key
let failure: Error | null = null
let readWait: Promise<void> | null = null
let reads = 0
let currentRole: 'owner' | 'member' = 'owner'
let leaveStatus = 200
let leftId = ''
let namedRevision: number | undefined
mock.module('next-intl', { namedExports: { useTranslations: () => translate, useMessages: () => ({ AgentCopy: {} }), useFormatter: () => ({}) } })
mock.module('@/lib/group-messages', { namedExports: { ...groupMessages, leaveGroupConversation: async (id: string, self: string) => {
  assert.equal(id, 'group-one'); assert.equal(self, 'owner')
  if (leaveStatus !== 200) throw new groupMessages.GroupMessagesRequestError('unavailable', leaveStatus)
}, fetchGroupMessages: async () => {
  reads++
  if (readWait) await readWait
  if (failure) throw failure
  return { messages: [{ id: 'message-one', conversationId: 'group-one', position: '1', authorType: 'user', authorId: 'owner', body: 'Stored history', mentions: [], replyToId: null, createdAt: '2026-11-07T00:00:00Z' }], nextBefore: null, readRevision: namedRevision } satisfies groupMessages.GroupMessagePage
} } })
mock.module('@/components/workspace/thread-header', { namedExports: { ThreadHeader: empty } })
mock.module('sonner', { namedExports: { toast: { error: nothing, dismiss: nothing } } })
mock.module('@/hooks/use-live-key', { namedExports: { ...live, useLiveKey: nothing } })
mock.module('@/lib/use-action-error', { namedExports: { useActionError: () => translate } })
mock.module('@/app/actions/agents', { namedExports: { listAgents: async () => [] } })
mock.module('@/app/actions/link-preview', { namedExports: { getLinkPreview: async () => null } })
mock.module('@/components/nav/conversation-pill', { namedExports: { ConversationPill: empty } })
mock.module('@/components/nav/group-avatar', { namedExports: { GroupAvatar: empty, groupMembersKey: (id: string) => ['group-members', id], memberAvatar: (member: { id: string }) => ({ id: member.id }), useGroupMembers: () => ({ data: [{ id: 'owner', memberType: 'user', role: currentRole }] }) } })
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
let root: Root, container: HTMLDivElement, cache: Map<string, ReadCacheState>
function ReadControl() {
  const { mutate } = useSWRConfig()
  refresh = () => mutate(infiniteKey(() => ['group-messages', 'group-one', null]))
  return null
}
before(async () => {
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'ResizeObserver'] as const) Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? browser : browser[key] })
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: browser.getComputedStyle.bind(browser) })
  for (const key of ['requestAnimationFrame', 'cancelAnimationFrame'] as const) Object.defineProperty(globalThis, key, { configurable: true, value: browser[key].bind(browser) })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ SWRConfig, useSWRConfig } = await import('swr'))
  ;({ unstable_serialize: infiniteKey } = await import('swr/infinite'))
  ;({ GroupChatView } = await import('./group-chat-view'))
})
beforeEach(() => {
  currentRole = 'owner'; leaveStatus = 200; leftId = ''; namedRevision = undefined; failure = null; readWait = null; reads = 0; cache = new Map(); browser.sessionStorage.clear()
  container = browser.document.createElement('div') as unknown as HTMLDivElement; document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
after(() => browser.happyDOM.close())
async function render(visible = true) {
  await act(async () => root.render(<SWRConfig value={{ provider: () => cache, shouldRetryOnError: false, revalidateOnFocus: false, revalidateOnReconnect: false }}>
    <ReadControl /><ViewStateProvider scope="owner:workspace">
      {visible && <GroupChatView group={{ id: 'group-one', title: 'Fixture group', workspaceId: 'workspace', creationPurpose: namedRevision === undefined ? 'group' : 'conversation' }} userId="owner" people={new Map()} onLeft={id => { leftId = id }} />}
    </ViewStateProvider>
  </SWRConfig>))
}
const input = () => container.querySelector('textarea')!
test('a named transcript sends the observed manual-mark revision only when its end enters view', async t => {
  namedRevision = 0
  let observer: IntersectionObserverCallback | undefined
  class ObservedEnd {
    constructor(callback: IntersectionObserverCallback) { observer = callback }
    observe() {}
    disconnect() {}
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, 'IntersectionObserver')
  Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: ObservedEnd })
  t.after(() => { if (original) Object.defineProperty(globalThis, 'IntersectionObserver', original); else Reflect.deleteProperty(globalThis, 'IntersectionObserver') })
  const writes: { messageId: string; readRevision: number }[] = []
  t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, options?: RequestInit) => {
    assert.match(String(url), /\/api\/conversations\/group-one\/read$/)
    writes.push(JSON.parse(String(options?.body)))
    return new Response('{}', {status:200})
  })
  await render()
  assert.ok(observer)
  const visibility = (seen: boolean) => observer!([{isIntersecting:seen,intersectionRatio:Number(seen)} as IntersectionObserverEntry], {} as IntersectionObserver)
  visibility(false)
  assert.deepEqual(writes, [])
  visibility(true)
  visibility(true)
  assert.deepEqual(writes, [{messageId:'message-one',readRevision:0}])
  namedRevision = 1
  await act(async () => { await refresh() })
  visibility(true)
  assert.deepEqual(writes.at(-1), {messageId:'message-one',readRevision:1})
})

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

// The same GroupChatView is mounted for sidebar and deep-linked official clients.
test('leave is hidden for owners, preserves a refused chat, and clears only the departed group', async () => {
  const { unstable_serialize } = await import('swr')
  const listKey = ['bot-list-groups', 'owner', 'workspace']
  const membersKey = ['group-members', 'group-one']
  const otherKey = ['group-members', 'group-two']
  const rows = [{ id: 'group-one' }, { id: 'group-two' }]
  for (const [key, data] of [[listKey, rows], [membersKey, ['first']], [otherKey, ['second']]] as const) {
    cache.set(unstable_serialize(key), { _k: key, data })
  }
  await render()
  assert.equal(container.querySelector('[data-slot="alert-dialog-trigger"]'), null)
  currentRole = 'member'
  await render()
  const trigger = container.querySelector<HTMLButtonElement>('[data-slot="alert-dialog-trigger"]')!
  assert.ok(trigger)
  await act(async () => trigger.click())
  const confirm = () => document.querySelector<HTMLButtonElement>('[data-slot="alert-dialog-action"]')!
  leaveStatus = 403
  await act(async () => confirm().click())
  assert.equal(leftId, '')
  assert.match(document.body.textContent ?? '', /leaveDenied/)
  assert.deepEqual(cache.get(unstable_serialize(listKey))?.data, rows)
  leaveStatus = 200
  await act(async () => confirm().click())
  assert.equal(leftId, 'group-one')
  assert.deepEqual(cache.get(unstable_serialize(listKey))?.data, [{ id: 'group-two' }])
  assert.equal(cache.get(unstable_serialize(membersKey))?.data, undefined)
  assert.equal(cache.get(infiniteKey(() => ['group-messages', 'group-one', null]))?.data, undefined)
  assert.deepEqual(cache.get(unstable_serialize(otherKey))?.data, ['second'])
})

test('a second open tab retires only memberships removed by a same-scope list refresh', async () => {
  const removed: string[] = []
  function Observer({ ids, workspace }: { ids?: string[]; workspace: string }) {
    const groups = ids?.map(id => ({ id, title: id, workspaceId: workspace, createdAt: '', lastMessage: null }))
    useGroupMembershipLoss('owner', workspace, groups, id => removed.push(id), async () => {})
    return null
  }
  const show = (ids: string[] | undefined, workspace = 'workspace') => act(async () => {
    root.render(<Observer ids={ids} workspace={workspace} />)
  })
  await show(['one', 'two'])
  await show(undefined)
  assert.deepEqual(removed, [], 'network interruption preserves the last authorized snapshot')
  await show(['two'])
  await show(['two'])
  assert.deepEqual(removed, ['one'])
  await show([], 'another-workspace')
  assert.deepEqual(removed, ['one'], 'changing Workspace cannot revoke the previous scope')
})


test('an authenticated peer membership loss clears its draft and send journal and fences previous setters after a rejoin', async () => {
  const legacyKey = 'group:one:pending'
  const firstKey = 'chat-send:group:owner:workspace:one'
  const secondKey = 'chat-send:group:owner:workspace:two'
  let write!: (text: string) => void
  let snapshot!: { draft: string; legacy: string[]; first: string[]; second: string[] }
  function Cells() {
    const [draft, setDraft] = useViewState('group:one:draft', '')
    const [legacy, setLegacy] = useViewState<string[]>(legacyKey, [])
    const [first, setFirst] = useViewState<string[]>(firstKey, [])
    const [second, setSecond] = useViewState<string[]>(secondKey, [])
    snapshot = { draft, legacy, first, second }
    write = text => { setDraft(text); setLegacy([text]); setFirst([text]); setSecond(['other group']) }
    return null
  }
  function Peer({ ids, visit }: { ids?: string[]; visit: number }) {
    const forget = useForgetGroupDrafts('owner', 'workspace')
    const groups = ids?.map(id => ({ id, title: id, workspaceId: 'workspace', createdAt: '', lastMessage: null }))
    useGroupMembershipLoss('owner', 'workspace', groups, forget, async () => {})
    return <Cells key={visit} />
  }
  const show = (ids: string[] | undefined, visit = 1) => act(async () => {
    root.render(<ViewStateProvider scope="owner:workspace"><Peer ids={ids} visit={visit} /></ViewStateProvider>)
  })
  await show(['one', 'two'])
  await act(async () => write('unknown result'))
  const previousMembership = write
  await show(undefined)
  assert.deepEqual(snapshot.first, ['unknown result'])
  await show(['two'])
  assert.deepEqual(snapshot, { draft: '', legacy: [], first: [], second: ['other group'] })
  await act(async () => previousMembership('late receipt'))
  assert.deepEqual(snapshot, { draft: '', legacy: [], first: [], second: ['other group'] })
  await show(['one', 'two'], 2)
  await act(async () => write('after rejoin'))
  await act(async () => previousMembership('old connection'))
  assert.deepEqual(snapshot, { draft: 'after rejoin', legacy: ['after rejoin'], first: ['after rejoin'], second: ['other group'] })
})

test('a confirmed local departure wakes only peer tabs of the same account and workspace', { timeout: 3_000 }, async () => {
  const { BroadcastChannel } = await import('node:worker_threads')
  const original = Object.getOwnPropertyDescriptor(window, 'BroadcastChannel')
  Object.defineProperty(window, 'BroadcastChannel', { value: BroadcastChannel, configurable: true })
  const refreshed: string[] = []
  const removed: string[] = []
  const replied = Promise.withResolvers<void>()
  let announce = nothing
  function Tab({ label, owner = 'owner', workspace = 'workspace' }: { label: string; owner?: string; workspace?: string }) {
    const notify = useGroupMembershipLoss(owner, workspace, undefined, id => removed.push(id), async () => {
      refreshed.push(label)
      if (label === 'peer') replied.resolve()
    })
    if (label === 'sender') announce = notify
    return null
  }
  try {
    await act(async () => root.render(<><Tab label="sender" /><Tab label="peer" /><Tab label="other owner" owner="other" /><Tab label="other workspace" workspace="other" /></>))
    announce()
    await replied.promise
    assert.deepEqual(refreshed, ['peer'])
    assert.deepEqual(removed, [], 'a local notification alone cannot remove a group or draft')
  } finally {
    if (original) Object.defineProperty(window, 'BroadcastChannel', original)
    else Reflect.deleteProperty(window, 'BroadcastChannel')
  }
})
