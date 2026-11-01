import assert from 'node:assert/strict'
import test, { before } from 'node:test'
import { basePath } from './base-path-config.mjs'

// Runs with next.config's real basePath. fetch is mocked in the request tests:
// they cover the client's reading of the group API contract, not the route.
process.env.MIKKA_BASE_PATH = basePath
let group: typeof import('./group-messages')
before(async () => { group = await import('./group-messages') })

const ID = '9b2f4c1e-3d5a-4e6f-8a7b-1c2d3e4f5a6b'
const message = (position: string, authorId: string, authorType: 'user' | 'agent' = 'user') => ({
  id: `m${position}`, conversationId: ID, position, authorType, authorId, body: `body ${position}`, mentions: [], replyToId: null, createdAt: '2026-10-26T00:00:00.000Z',
})

test('message pages are read from the basePath route with the page size and cursor', () => {
  const url = new URL(group.groupMessagesUrl(ID, '41'), 'https://app.test')
  assert.equal(url.pathname, `/mikka/api/conversations/${ID}/messages`)
  assert.deepEqual([...url.searchParams], [['limit', '50'], ['before', '41']])
  assert.equal(new URL(group.groupMessagesUrl(ID), 'https://app.test').searchParams.has('before'), false)
})

test('(mock fetch) statuses map to unauthorized, not_found and unavailable', async () => {
  const cases: Array<[Response | Error, string]> = [
    [Response.json({ error: 'unauthorized' }, { status: 401 }), 'unauthorized'],
    [Response.json({ error: 'not_found' }, { status: 404 }), 'not_found'],
    [Response.json({ error: 'invalid_input' }, { status: 422 }), 'unavailable'],
    [new TypeError('offline'), 'unavailable'],
  ]
  for (const [response, code] of cases) {
    const fetcher = (async () => { if (response instanceof Error) throw response; return response }) as typeof fetch
    await assert.rejects(group.fetchGroupMessages(ID, null, fetcher), (error: unknown) => error instanceof group.GroupMessagesRequestError && error.code === code)
  }
  const page = { messages: [message('2', 'u1')], nextBefore: null }
  let init: RequestInit | undefined
  const fetcher = (async (_input: Parameters<typeof fetch>[0], options?: RequestInit) => { init = options; return Response.json(page) }) as typeof fetch
  assert.deepEqual(await group.fetchGroupMessages(ID, null, fetcher), page)
  assert.equal(init?.cache, 'no-store')
  assert.equal(init?.credentials, 'same-origin')
})

test('newest-first pages read oldest first, by bigint position, without duplicates', () => {
  const pages = [{ messages: [message('10', 'u1'), message('9', 'u1')], nextBefore: '9' }, { messages: [message('9', 'u1'), message('8', 'u2')], nextBefore: null }]
  assert.deepEqual(group.chronological(pages).map(item => item.position), ['8', '9', '10'])
  const huge = [{ messages: [message('9007199254740993', 'u1'), message('9007199254740992', 'u1')], nextBefore: null }]
  assert.deepEqual(group.chronological(huge).map(item => item.position), ['9007199254740992', '9007199254740993'])
})

test('consecutive messages from one author form one run', () => {
  const runs = group.authorRuns([message('1', 'u1'), message('2', 'u1'), message('3', 'a1', 'agent'), message('4', 'u1')])
  assert.deepEqual(runs.map(run => [run.authorType, run.authorId, run.messages.length]), [['user', 'u1', 2], ['agent', 'a1', 1], ['user', 'u1', 1]])
})

test('(mock fetch) the bot list reads group chats and a chat reads its members through the basePath API', async () => {
  const urls: string[] = []
  const reply = (body: unknown, status = 200) => (async (input: Parameters<typeof fetch>[0]) => { urls.push(String(input)); return Response.json(body, { status }) }) as typeof fetch
  const summary = { id: ID, workspaceId: 'w1', title: '0.9.5 发版群', createdAt: '2026-10-26T00:00:00.000Z', lastMessage: message('3', 'b1') }
  assert.deepEqual(await group.fetchGroups('w1', reply({ conversations: [summary] })), [summary])
  const bot = { id: 'b1', name: '发布经理', memberType: 'bot', color: 'rouge', shape: 'etoile' }
  assert.deepEqual(await group.fetchGroupMembers(ID, reply({ members: [bot] })), [bot])
  assert.deepEqual(urls, ['/mikka/api/conversations?workspaceId=w1', `/mikka/api/conversations/${ID}/members`])
  await assert.rejects(group.fetchGroups('w1', reply({ error: 'not_found' }, 404)), (error: unknown) => error instanceof group.GroupMessagesRequestError && error.code === 'not_found')
  await assert.rejects(group.fetchGroupMembers(ID, reply({ members: 'nope' })), (error: unknown) => error instanceof group.GroupMessagesRequestError && error.code === 'unavailable')
  await assert.rejects(group.fetchGroups('w1', (async () => { throw new TypeError('offline') }) as typeof fetch), (error: unknown) => error instanceof group.GroupMessagesRequestError && error.code === 'unavailable')
})

test('(mock fetch) a sent message posts its body and mentions to the basePath route', async () => {
  const calls: Array<[string, RequestInit | undefined]> = []
  const stored = { ...message('3', 'u1'), body: '@值班 看下' }
  const sent = await group.postGroupMessage(ID, '@值班 看下', [{ memberType: 'bot', memberId: 'b1' }], (async (url: string, init?: RequestInit) => { calls.push([url, init]); return Response.json(stored, { status: 201 }) }) as typeof fetch)
  assert.equal(sent.id, stored.id)
  assert.equal(calls[0][0], `/mikka/api/conversations/${ID}/messages`)
  assert.equal(calls[0][1]?.method, 'POST')
  assert.deepEqual(JSON.parse(String(calls[0][1]?.body)), { body: '@值班 看下', mentions: [{ memberType: 'bot', memberId: 'b1' }] })
  for (const [response, code] of [[Response.json({ error: 'unprocessable' }, { status: 422 }), 'unavailable'], [Response.json({}, { status: 404 }), 'not_found'], [new TypeError('offline'), 'unavailable']] as const) {
    await assert.rejects(group.postGroupMessage(ID, 'x', [], (async () => { if (response instanceof Error) throw response; return response }) as typeof fetch), (error: unknown) => error instanceof group.GroupMessagesRequestError && error.code === code)
  }
})
