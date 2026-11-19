import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, useRef, useState } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import { Textarea } from '@/components/ui/textarea'
import type { ChatComposerProps } from '@/components/slots/chat-composer-contract'
import * as live from '@/hooks/use-live-key'
import type { GroupMember, GroupMessage, GroupMessagePage } from '@/lib/group-messages'

let pages: GroupMessagePage[] = []
let hasMemberPage = true
let groupMembers: GroupMember[] = []
let membersError: Error | undefined
mock.module('next-intl', { namedExports: {
  useTranslations: () => (key: string) => key,
  useMessages: () => ({ AgentCopy: {} }),
  useFormatter: () => ({}),
} })
const infinite: { config?: Record<string, unknown> } = {}
const liveKeys: unknown[][] = []
const refreshed: unknown[] = []
let headerTitleChanged: (() => void) | undefined
mock.module('swr', { defaultExport: () => ({ data: undefined }), namedExports: { useSWRConfig: () => ({ mutate: async (key: unknown) => { refreshed.push(key) } }), unstable_serialize: (key: unknown) => JSON.stringify(key) } })
mock.module('swr/infinite', {
  defaultExport: (_key: unknown, _fetcher: unknown, config: Record<string, unknown>) => { infinite.config = config; return { data: pages, size: 1, setSize: async () => {}, mutate: async () => {}, isValidating: false } },
  namedExports: { unstable_serialize: (getKey: (index: number, previous: null) => unknown) => '$inf$' + JSON.stringify(getKey(0, null)) },
})
mock.module(new URL('../../hooks/use-live-key.tsx', import.meta.url).href, { namedExports: {
  ...live,
  useLiveKey: (...args: unknown[]) => { liveKeys.push(args) },
} })
mock.module(new URL('../../app/actions/agents.ts', import.meta.url).href, { namedExports: { listAgents: async () => [] } })
mock.module(new URL('../../app/actions/link-preview.ts', import.meta.url).href, { namedExports: { getLinkPreview: async () => null, getLinkPreviews: async () => ({}) } })
mock.module(new URL('../../lib/hooks/view-state.tsx', import.meta.url).href, { namedExports: {
  useViewState: <T,>(_key: string, initial: T) => useState(initial),
  useViewScroll: () => useRef(null),
} })
mock.module(new URL('../../app/actions/task-runs.ts', import.meta.url).href, { namedExports: { findThreadReferences: async () => [{ kind: 'task', id: issueId, title: 'Authorized task' }] } })
mock.module(new URL('./thread-header.tsx', import.meta.url).href, { namedExports: { ThreadHeader: ({ onTitleChanged }: { onTitleChanged?: () => void }) => { headerTitleChanged = onTitleChanged; return null } } })
mock.module(new URL('../coordinator/bot-model-picker.tsx', import.meta.url).href, { namedExports: { BotModelPicker: ({ botId, running }: { botId: string; running: boolean }) => <span aria-label="Fixture Bot model">{botId} {running ? 'next message' : 'current'}</span> } })
mock.module(new URL('../coordinator/chat-composer.tsx', import.meta.url).href, { namedExports: { ChatComposer: ({ ref, value, onChange, model }: ChatComposerProps) => <>{model}<Textarea ref={ref} value={value} onChange={event => onChange(event.currentTarget.value)} /></> } })
mock.module(new URL('../nav/conversation-pill.tsx', import.meta.url).href, { namedExports: { ConversationPill: () => null } })
mock.module(new URL('../nav/group-avatar.tsx', import.meta.url).href, { namedExports: { GroupAvatar: () => null, groupMembersKey: (id: string) => ['group-members', id], memberAvatar: (member: { id: string }) => ({ id: member.id }), useGroupMembers: () => ({ data: hasMemberPage ? groupMembers : undefined, error: membersError }) } })
mock.module(new URL('../nav/letter-avatar.tsx', import.meta.url).href, { namedExports: { LetterAvatar: () => null } })
mock.module(new URL('../nav/bot-avatar.tsx', import.meta.url).href, { namedExports: { BotAvatar: () => null } })
mock.module(new URL('./message-reactions.tsx', import.meta.url).href, { namedExports: { MessageReactions: () => null, useMessageReactions: () => ({}) } })

const browser = new Window({ url: 'https://mikka.test/mikka' })
let root: Root, container: HTMLDivElement
let createRoot: typeof import('react-dom/client')['createRoot']
let GroupChatView: typeof import('./group-chat-view')['GroupChatView']
const issueId = '00000000-0000-4000-8000-000000000010'
const runId = '00000000-0000-4000-8000-000000000020'
const taskHref = '/mikka?issue=' + issueId
const threadHref = taskHref + '&thread=' + runId
const handoff = '任务已交给 Factory。\n[Task](' + taskHref + ')\n[Thread](' + threadHref + ') · [成果与验证证据](' + threadHref + ')'
const message = (authorType: GroupMessage['authorType'], position: number, body: string): GroupMessage => ({
  id: 'message-' + position, conversationId: 'group', position: String(position),
  authorType, authorId: authorType === 'user' ? 'owner' : authorType,
  body, mentions: [], replyToId: null, createdAt: '2026-11-04T18:00:00.000Z',
})

before(async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.document })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, IntersectionObserver: browser.IntersectionObserver, requestAnimationFrame: browser.requestAnimationFrame.bind(browser) })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ GroupChatView } = await import('./group-chat-view'))
})
beforeEach(() => { container = browser.document.createElement('div') as unknown as HTMLDivElement; document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
after(() => browser.close())

const render = async (messages: GroupMessage[]) => {
  pages = [{ messages, nextBefore: null, agentStatus: null }]
  await act(async () => root.render(<GroupChatView group={{ id: 'group', title: 'Fixture group', workspaceId: 'workspace' }} userId="owner" people={new Map()} />))
}

test('Factory task and thread references in bot and agent replies are real links; sent user text keeps its existing rendering', async () => {
  await render([message('user', 1, handoff), message('bot', 2, handoff), message('agent', 3, handoff)])
  const replies = [...container.querySelectorAll('ol[aria-label="messages"] > li')].slice(1)
  assert.equal(replies.length, 2)
  for (const reply of replies) {
    assert.deepEqual([...reply.querySelectorAll('a')].map(link => ({ text: link.textContent, href: link.getAttribute('href') })), [
      { text: 'Task', href: taskHref }, { text: 'Thread', href: threadHref }, { text: '成果与验证证据', href: threadHref },
    ])
    assert.equal(reply.textContent?.includes('[Task]('), false)
  }
  const ownText = container.querySelector('[data-slot="user-message-text"]')!
  assert.equal(ownText.textContent, handoff)
  assert.equal(ownText.querySelector('a'), null)
})

test('a committed named chat title revalidates only the group list supplying the current viewer and workspace', async () => {
  const { botKeys } = await import('@/lib/swr/keys')
  pages = [{ messages: [], nextBefore: null, readRevision: 0 }]
  for (const [owner, workspace] of [['owner-a', 'workspace-a'], ['owner-b', 'workspace-b']]) {
    await act(async () => root.render(<GroupChatView group={{ id: 'same-chat-id', title: 'Chat', workspaceId: workspace, creationPurpose: 'conversation' }} userId={owner} people={new Map()} />))
    refreshed.length = 0
    assert.ok(headerTitleChanged)
    await act(async () => headerTitleChanged?.())
    assert.deepEqual(refreshed, [botKeys.groups(owner, workspace)])
  }
})

test('group replies use the existing Markdown HTML and URL protections', async () => {
  await render([message('bot', 1, '<script>alert(1)</script>\n\n[bad](javascript:alert%281%29)\n\n' + handoff)])
  const reply = container.querySelector('ol[aria-label="messages"] > li')!
  assert.ok(reply)
  assert.equal(reply.querySelector('script'), null)
  assert.equal(reply.querySelector('a[href^="javascript:"]'), null)
  assert.deepEqual([...reply.querySelectorAll('a[href]')].filter(link => link.getAttribute('href')).map(link => link.getAttribute('href')), [taskHref, threadHref, threadHref])
})

test('the chat reads its newest page and members on the group key, never on a timer (#1212)', async () => {
  liveKeys.length = 0
  pages = [{ messages: [message('user', 1, 'hello')], nextBefore: null, agentStatus: { status: 'running' } }]
  await act(async () => root.render(<GroupChatView group={{ id: 'group', title: 'Fixture group', workspaceId: 'workspace' }} userId="owner" people={new Map()} />))
  assert.equal(infinite.config?.refreshInterval, undefined, 'a bot answering is no reason to poll')
  const [kind, id, keys, workspaceId] = liveKeys.at(-1)!
  assert.equal(kind, 'group_chat')
  assert.equal(id, 'group')
  assert.deepEqual(keys, ['$inf$' + JSON.stringify(['group-messages', 'group', null]), JSON.stringify(['group-members', 'group'])])
  assert.equal(workspaceId, 'workspace', 'the key arrives on the group workspace channel')
})

test('named conversations show canonical authored links and use their authorized picker while ordinary groups retain plain task markers', async () => {
  const body = 'See [[issue:' + issueId + ']] and [[chat:' + runId + ']]'
  pages = [{ messages: [message('user', 1, body)], nextBefore: null, readRevision: 0 }]
  const group = { id: 'group', title: 'Chat', workspaceId: 'workspace' }
  const draw = (purpose: 'group' | 'conversation') => root.render(<GroupChatView group={{ ...group, creationPurpose: purpose }} userId="owner" people={new Map()} />)
  await act(async () => draw('conversation'))
  const links = [...container.querySelectorAll('[data-slot="user-message-text"] a')]
  assert.equal(links.length, 2)
  assert.ok(links[0].getAttribute('href')?.includes(issueId))
  assert.ok(links[1].getAttribute('href')?.includes('group=' + runId))
  const input = container.querySelector('textarea')!
  const setValue = Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, 'value')!.set!
  setValue.call(input, '@task:authorized')
  await act(async () => input.dispatchEvent(new browser.Event('input', { bubbles: true }) as never))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 230)) })
  const candidate = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('Authorized task'))
  assert.ok(candidate)
  await act(async () => candidate.click())
  assert.equal(input.value, '[[issue:' + issueId + ']] ')
  await act(async () => draw('group'))
  assert.equal(container.querySelector('[data-slot="user-message-text"]')?.textContent, body)
  assert.equal(container.querySelector('[data-slot="user-message-text"] a'), null)
  await act(async () => draw('conversation'))
  membersError = Object.assign(new Error('membership removed'), { status: 403 })
  try {
    await act(async () => draw('conversation'))
    assert.equal(container.querySelector('[data-slot="user-message-text"] a'), null)
    assert.equal(container.querySelector('[role="group"][aria-label="references"]'), null)
    assert.ok(container.querySelector('[role="alert"]')?.textContent?.includes('notFound'))
    membersError = Object.assign(new Error('membership lookup unavailable'), { status: 503 })
    await act(async () => draw('conversation'))
    assert.equal(Boolean(container.querySelector('[data-slot="user-message-text"]')), false, 'a successful messages read cannot restore a refused membership read')
    assert.equal(container.querySelector('[role="group"][aria-label="references"]'), null)
    membersError = undefined
    hasMemberPage = false
    await act(async () => draw('conversation'))
    assert.equal(Boolean(container.querySelector('[data-slot="user-message-text"]')), false, 'a pending membership read cannot restore access')
    hasMemberPage = true
    await act(async () => draw('conversation'))
    assert.equal(container.querySelectorAll('[data-slot="user-message-text"] a').length, 2)
  } finally { membersError = undefined; hasMemberPage = true }
})

test('the named conversation mounts the existing picker for the sole or explicitly addressed owned Bot', async () => {
  const bot: GroupMember = { memberType: 'bot', id: 'owned', name: 'Owned Bot' }
  const actor: GroupMember = { memberType: 'agent', id: 'agent', name: 'Agent' }
  const person: GroupMember = { memberType: 'user', id: 'owner', name: 'Owner' }
  const group = { id: 'group', title: 'Chat', workspaceId: 'workspace' }
  const draw = (purpose: 'group' | 'conversation', roster: {id: string}[]) =>
    act(async () => root.render(<GroupChatView group={{ ...group, creationPurpose: purpose }} userId="owner" people={new Map()} ownedBots={roster} />))
  const chip = () => container.querySelector('[aria-label="Fixture Bot model"]')
  pages = [{ messages: [], nextBefore: null, readRevision: 0, agentStatus: { status: 'running' } }]
  try {
    groupMembers = [person, bot]
    await draw('conversation', [bot])
    assert.equal(chip()?.textContent, 'owned next message')
    await draw('group', [bot])
    assert.equal(chip(), null)
    await draw('conversation', [])
    assert.equal(chip(), null)
    for (const others of [[bot, actor], [bot, { ...bot, id: 'second' }], [actor]]) {
      groupMembers = [person, ...others]
      await draw('conversation', [bot])
      assert.equal(chip(), null)
    }
    const second: GroupMember = { memberType: 'bot', id: 'second', name: 'Second Bot' }
    groupMembers = [person, bot, actor, second]
    await draw('conversation', [bot, second])
    const input = container.querySelector('textarea')!
    const setValue = Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, 'value')!.set!
    const type = async (value: string) => {
      setValue.call(input, value)
      await act(async () => input.dispatchEvent(new browser.Event('input', { bubbles: true }) as never))
    }
    await type('@Owned Bot tell me what changed')
    assert.equal(chip()?.textContent, 'owned next message')
    await type('@sECOND Bot check this')
    assert.equal(chip()?.textContent, 'second next message')
    await draw('conversation', [bot])
    assert.equal(chip(), null, 'the second Bot belongs to another user')
    await draw('conversation', [bot, second])
    for (const draft of ['@Owned Bot and @Second Bot', '@Agent', 'hello', '[[chat:' + runId + ']]']) {
      await type(draft)
      assert.equal(chip(), null)
    }
    await type('@Owned Bot hello')
    await draw('group', [bot, second])
    assert.equal(chip(), null, 'the ordinary group keeps its existing composer')
    groupMembers = [person, bot]
    membersError = new (await import('@/lib/group-messages')).GroupMessagesRequestError('not_found', 403)
    await draw('conversation', [bot])
    assert.equal(chip(), null)
  } finally { groupMembers = []; membersError = undefined }
})
