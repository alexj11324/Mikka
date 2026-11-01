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

test('(mock fetch) members come from the basePath route; a 404 is not_found', async () => {
  assert.equal(new URL(group.groupMembersUrl(ID), 'https://app.test').pathname, `/mikka/api/conversations/${ID}/members`)
  const members = [{ id: 'u1', name: '林晓', memberType: 'user' }, { id: 'b1', name: 'QA 巡检', memberType: 'bot', color: 'violet', shape: 'cercle' }]
  assert.deepEqual(await group.fetchGroupMembers(ID, (async () => Response.json({ members })) as typeof fetch), members)
  await assert.rejects(group.fetchGroupMembers(ID, (async () => Response.json({}, { status: 404 })) as typeof fetch), (error: unknown) => error instanceof group.GroupMessagesRequestError && error.code === 'not_found')
})

test('consecutive messages from one author form one run', () => {
  const runs = group.authorRuns([message('1', 'u1'), message('2', 'u1'), message('3', 'a1', 'agent'), message('4', 'u1')])
  assert.deepEqual(runs.map(run => [run.authorType, run.authorId, run.messages.length]), [['user', 'u1', 2], ['agent', 'a1', 1], ['user', 'u1', 1]])
})
