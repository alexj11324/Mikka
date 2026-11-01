import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'
import { drizzle } from 'drizzle-orm/pg-proxy'
import { fingerprint, type SecretFingerprint } from '@/lib/credentials/fingerprint'
import type { CoordinatorStreamEvent, CoordinatorWorkflowStreamPart } from '@/lib/coordinator/stream'

const botId = '10000000-0000-4000-8000-000000000001'
const peerBotId = '10000000-0000-4000-8000-000000000002'
const workspaceId = '10000000-0000-4000-8000-000000000003'
// Each person's Coordinator is an ordinary bot row (lib/coordinator/coordinator-bot.ts).
const coordinatorOf: Record<string, string> = { owner: '10000000-0000-4000-8000-0000000c0de1', peer: '10000000-0000-4000-8000-0000000c0de2' }
type Session = { user: { id: string }; session: { id: string }; tokenWorkspaceId?: string }
type Chat = { userId: string; botId: string; leaseHolder: string | null; leaseUntil: Date | null }
let session: Session | null
let chats: Chat[] = []
let fingerprints: SecretFingerprint[] = []
const queries: { sql: string; params: unknown[] }[] = []
const botRows = [{ id: botId, ownerId: 'owner', workspaceId }, { id: peerBotId, ownerId: 'peer', workspaceId }]
const db = drizzle(async (sql, params) => {
  queries.push({ sql, params })
  if (sql.includes('from "bots"')) {
    // Use Drizzle's real SQL builder so an omitted owner predicate fails this test.
    assert.match(sql, /where \("bots"\."id" = \$1 and "bots"\."ownerId" = \$2\)/)
    return { rows: botRows.filter(bot => bot.id === params[0] && bot.ownerId === params[1]).map(bot => [bot.workspaceId]) }
  }
  assert.match(sql, /from "coordinator_sessions"/)
  assert.match(sql, /where \("coordinator_sessions"\."userId" = \$1 and "coordinator_sessions"\."botId" = \$2\)/)
  return { rows: chats.filter(chat => chat.userId === params[0] && chat.botId === params[1]).map(chat => [chat.leaseHolder, chat.leaseUntil?.toISOString() ?? null]) }
})
const getSession = mock.fn(async (_options: unknown) => session)
const loadFingerprints = mock.fn(async (_userId: string) => fingerprints)
const start = (id = 'turn:0'): CoordinatorWorkflowStreamPart => ({ type: 'coordinator-turn-start', id, quietEligible: false })
const delta = (text: string): CoordinatorWorkflowStreamPart => ({ type: 'text-delta', id: '0', text })
const committed = (): CoordinatorWorkflowStreamPart => ({ type: 'coordinator-turn-committed', id: 'turn:0', through: 3, quiet: false })
const partsStream = (parts: CoordinatorWorkflowStreamPart[]) => new ReadableStream<CoordinatorWorkflowStreamPart>({ start(controller) {
  for (const part of parts) controller.enqueue(part)
  controller.close()
} })
let source: () => ReadableStream<CoordinatorWorkflowStreamPart>
const readStream = mock.fn(() => source())
const getRun = mock.fn((_runId: string) => ({ getReadable: readStream }))
let GET: typeof import('./route')['GET']
before(async () => {
  mock.module(new URL('../../../../lib/auth.ts', import.meta.url).href, { namedExports: { auth: { api: { getSession } } } })
  mock.module(new URL('../../../../lib/db/index.ts', import.meta.url).href, { namedExports: { db } })
  mock.module(new URL('../../../../lib/credentials/chat-guard.ts', import.meta.url).href, { namedExports: { credentialChatFingerprints: loadFingerprints } })
  mock.module(new URL('../../../../lib/request-log.ts', import.meta.url).href, { namedExports: {
    noteLogUser: () => {}, withRequestLog: (_path: string, handler: unknown) => handler,
  } })
  mock.module('workflow/api', { namedExports: { getRun } })
  mock.module(new URL('../../../../lib/coordinator/coordinator-bot.ts', import.meta.url).href, { namedExports: {
    chatBotId: async (owner: string, chosen: string | null | undefined) => chosen ?? coordinatorOf[owner],
    openChatBotId: async (user: { id: string }, chosen: string | null | undefined) => chosen ?? coordinatorOf[user.id],
  } })
  GET = (await import('./route')).GET
})
beforeEach(() => {
  session = { user: { id: 'owner' }, session: { id: 'browser-session' } }
  const leaseUntil = new Date(Date.now() + 60_000)
  chats = [
    { userId: 'peer', botId: coordinatorOf.peer, leaseHolder: 'wrun_peer', leaseUntil },
    { userId: 'owner', botId, leaseHolder: 'wrun_owner_bot', leaseUntil },
    { userId: 'peer', botId: peerBotId, leaseHolder: 'wrun_peer_bot', leaseUntil },
    { userId: 'owner', botId: coordinatorOf.owner, leaseHolder: 'wrun_owner', leaseUntil },
  ]
  fingerprints = []; queries.length = 0
  getSession.mock.resetCalls(); loadFingerprints.mock.resetCalls(); getRun.mock.resetCalls(); readStream.mock.resetCalls()
  source = () => partsStream([start(), delta('visible reply'), committed()])
})
const call = (params: Record<string, string> = {}) => GET(new Request(`https://mikka.example/mikka/api/coordinator/stream?${new URLSearchParams(params)}`))
const events = async (response: Response): Promise<CoordinatorStreamEvent[]> => (await response.text()).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
const noStream = () => { assert.equal(getRun.mock.callCount(), 0); assert.equal(loadFingerprints.mock.callCount(), 0) }

test('authentication and malformed bot IDs fail before any chat or stream lookup', async () => {
  session = null
  assert.equal((await call()).status, 401)
  session = { user: { id: 'owner' }, session: { id: 'session' } }
  for (const invalid of ['', 'not-a-uuid', '10000000-0000-4000-8000']) assert.equal((await call({ botId: invalid })).status, 400)
  assert.equal(queries.length, 0); noStream()
  const options = getSession.mock.calls[0].arguments[0] as { query: { disableCookieCache: boolean } }
  assert.equal(options.query.disableCookieCache, true)
})

test('the authenticated owner and no bot select the Coordinator run, ignoring supplied user identity', async () => {
  const response = await call({ userId: 'peer', runId: 'wrun_owner' })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal(response.headers.get('content-type'), 'application/x-ndjson; charset=utf-8')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.deepEqual(getRun.mock.calls[0].arguments, ['wrun_owner'])
  assert.deepEqual(loadFingerprints.mock.calls[0].arguments, ['owner'])
  assert.equal(queries.length, 1)
  assert.deepEqual(queries[0].params.slice(0, 2), ['owner', coordinatorOf.owner])
  assert.deepEqual(await events(response), [{ type: 'start', id: 'turn:0' }, { type: 'text', id: 'turn:0', delta: 'visible reply' }, { type: 'committed', id: 'turn:0', through: 3, quiet: false }])
})

test('a peer cannot use a known owner run ID and sees only their own Coordinator lease', async () => {
  session!.user.id = 'peer'
  assert.equal((await call({ runId: 'wrun_owner' })).status, 204)
  noStream()
  const response = await call({ runId: 'wrun_peer' })
  assert.equal(response.status, 200)
  assert.deepEqual(getRun.mock.calls[0].arguments, ['wrun_peer'])
  assert.deepEqual(loadFingerprints.mock.calls[0].arguments, ['peer'])
  await response.text()
})

test('a bot stream requires ownership and selects that bot rather than the Coordinator', async () => {
  assert.equal((await call({ botId: peerBotId, runId: 'wrun_peer_bot' })).status, 404)
  assert.equal(queries.length, 1); noStream()
  const response = await call({ botId, runId: 'wrun_owner_bot' })
  assert.equal(response.status, 200)
  assert.deepEqual(getRun.mock.calls[0].arguments, ['wrun_owner_bot'])
  assert.deepEqual(queries.at(-1)?.params.slice(0, 2), ['owner', botId])
  await response.text()
})

test('workspace-scoped API sessions cannot stream an owned bot outside their workspace', async () => {
  session!.tokenWorkspaceId = '10000000-0000-4000-8000-000000000099'
  assert.equal((await call({ botId })).status, 404)
  assert.equal(queries.length, 1); noStream()
  session!.tokenWorkspaceId = workspaceId
  const response = await call({ botId })
  assert.equal(response.status, 200)
  await response.text()
})

test('missing, expired, non-workflow and mismatched leases never open a supplied run ID', async () => {
  const own = chats.find(chat => chat.userId === 'owner' && chat.botId === coordinatorOf.owner)!
  const initial = { ...own }
  for (const state of [
    { leaseHolder: null }, { leaseUntil: null }, { leaseUntil: new Date(Date.now() - 1000) }, { leaseHolder: 'native_turn' },
  ]) {
    Object.assign(own, initial, state)
    assert.equal((await call({ runId: 'wrun_owner' })).status, 204)
  }
  Object.assign(own, initial)
  assert.equal((await call({ runId: 'wrun_arbitrary_other_chat' })).status, 204)
  chats = chats.filter(chat => chat !== own)
  assert.equal((await call({ runId: 'wrun_owner' })).status, 204)
  noStream()
})

test('the HTTP stream exposes assistant text and lifecycle without reasoning, tools or provider details', async () => {
  source = () => partsStream([start(),
    { type: 'reasoning-delta', id: 'r', text: 'private-reasoning' },
    { type: 'tool-input-delta', id: 't', delta: 'private-tool-input' },
    { type: 'model-call-response-metadata', id: 'private-provider-id', modelId: 'private-model' },
    delta('public text'), committed(),
  ])
  const output = await events(await call())
  assert.equal(output.filter(event => event.type === 'text').map(event => event.delta).join(''), 'public text')
  assert.doesNotMatch(JSON.stringify(output), /private-|reasoning|tool-input|provider/)
})

test('a split saved secret ends with a generic error before secret content reaches HTTP', async t => {
  const previous = process.env.BETTER_AUTH_SECRET
  process.env.BETTER_AUTH_SECRET = 'isolated-route-stream-fingerprint-key'
  t.after(() => { if (previous === undefined) delete process.env.BETTER_AUTH_SECRET; else process.env.BETTER_AUTH_SECRET = previous })
  const secret = 'synthetic-private-password'
  fingerprints = [fingerprint('owner', secret)]
  source = () => partsStream([start(), delta('safe '.repeat(20) + secret.slice(0, 8)), delta(secret.slice(8)), committed()])
  const output = await events(await call())
  const text = output.filter(event => event.type === 'text').map(event => event.delta).join('')
  assert.ok(text.length > 0)
  assert.equal(text, 'safe '.repeat(20).slice(0, text.length))
  assert.deepEqual(output.at(-1), { type: 'error' })
  assert.doesNotMatch(JSON.stringify(output), /synthetic|credential_secret_detected|digest|password/)
})

test('cancelling the HTTP reader cancels its durable stream reader', { timeout: 2000 }, async () => {
  let cancelled!: (reason: unknown) => void
  const cancellation = new Promise<unknown>(resolve => { cancelled = resolve })
  source = () => new ReadableStream<CoordinatorWorkflowStreamPart>({
    start(controller) { controller.enqueue(start()) },
    cancel(reason) { cancelled(reason) },
  })
  const response = await call()
  const reader = response.body!.getReader()
  assert.equal((await reader.read()).done, false)
  await reader.cancel('page closed')
  assert.equal(await cancellation, 'page closed')
})
