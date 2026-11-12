import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, useRef, useState } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import * as live from '@/hooks/use-live-key'
import type { GroupMessage, GroupMessagePage } from '@/lib/group-messages'

let pages: GroupMessagePage[] = []
mock.module('next-intl', { namedExports: {
  useTranslations: () => (key: string) => key,
  useMessages: () => ({ AgentCopy: {} }),
  useFormatter: () => ({}),
} })
const infinite: { config?: Record<string, unknown> } = {}
const liveKeys: unknown[][] = []
mock.module('swr', { defaultExport: () => ({ data: undefined }), namedExports: { unstable_serialize: (key: unknown) => JSON.stringify(key) } })
mock.module('swr/infinite', {
  defaultExport: (_key: unknown, _fetcher: unknown, config: Record<string, unknown>) => { infinite.config = config; return { data: pages, size: 1, setSize: async () => {}, mutate: async () => {}, isValidating: false } },
  namedExports: { unstable_serialize: (getKey: (index: number, previous: null) => unknown) => '$inf$' + JSON.stringify(getKey(0, null)) },
})
mock.module(new URL('../../hooks/use-live-key.tsx', import.meta.url).href, { namedExports: {
  ...live,
  useLiveKey: (...args: unknown[]) => { liveKeys.push(args) },
} })
mock.module(new URL('../../app/actions/agents.ts', import.meta.url).href, { namedExports: { listAgents: async () => [] } })
mock.module(new URL('../../app/actions/link-preview.ts', import.meta.url).href, { namedExports: { getLinkPreview: async () => null } })
mock.module(new URL('../../lib/hooks/view-state.tsx', import.meta.url).href, { namedExports: {
  useViewState: <T,>(_key: string, initial: T) => useState(initial),
  useViewScroll: () => useRef(null),
} })
mock.module(new URL('../coordinator/chat-composer.tsx', import.meta.url).href, { namedExports: { ChatComposer: () => null } })
mock.module(new URL('../nav/conversation-pill.tsx', import.meta.url).href, { namedExports: { ConversationPill: () => null } })
mock.module(new URL('../nav/group-avatar.tsx', import.meta.url).href, { namedExports: { GroupAvatar: () => null, groupMembersKey: (id: string) => ['group-members', id], memberAvatar: (member: { id: string }) => ({ id: member.id }), useGroupMembers: () => ({ data: [] }) } })
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
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
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
