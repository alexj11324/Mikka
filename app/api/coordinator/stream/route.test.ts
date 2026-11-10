import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'
import { createHash } from 'node:crypto'
import { drizzle } from 'drizzle-orm/pg-proxy'
import { ActionFailureError } from '@/lib/action-error'
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
  assert.match(sql, /from "coordinator_sessions"/)
  assert.match(sql, /where \("coordinator_sessions"\."userId" = \$1 and "coordinator_sessions"\."botId" = \$2\)/)
  return { rows: chats.filter(chat => chat.userId === params[0] && chat.botId === params[1]).map(chat => [chat.leaseHolder, chat.leaseUntil?.toISOString() ?? null]) }
})
let sharedPermission = false
let sourceVisible = true
const resolveChat = mock.fn(async (user: { id: string }, chosen?: string | null) => {
  const id = chosen ?? coordinatorOf[user.id]
  const bot = botRows.find(row => row.id === id) ?? Object.entries(coordinatorOf).map(([ownerId, id]) => ({ id, ownerId, workspaceId })).find(row => row.id === id)
  if (!bot || (bot.ownerId !== user.id && !sharedPermission) || session?.tokenWorkspaceId && session.tokenWorkspaceId !== bot.workspaceId) throw new ActionFailureError('botNotFound')
  return { ...bot, viewerId: user.id, reader: user }
})
const executionVisible = mock.fn(async () => sourceVisible)
const getSession = mock.fn(async (_options: unknown) => session)
const loadFingerprints = mock.fn(async (_userId: string) => fingerprints)
const start = (id = 'turn:0'): CoordinatorWorkflowStreamPart => ({ type: 'coordinator-turn-start', id, quietEligible: false })
const delta = (text: string): Extract<CoordinatorWorkflowStreamPart, { type: 'text-delta' }> => ({ type: 'text-delta', id: '0', text })
const committed = (): CoordinatorWorkflowStreamPart => ({ type: 'coordinator-turn-committed', id: 'turn:0', through: 3, quiet: false })
const partsStream = (parts: CoordinatorWorkflowStreamPart[]) => new ReadableStream<CoordinatorWorkflowStreamPart>({ start(controller) {
  for (const part of parts) controller.enqueue(part)
  controller.close()
} })
let source: () => ReadableStream<CoordinatorWorkflowStreamPart>
const readStream = mock.fn(() => source())
const getRun = mock.fn((_runId: string) => ({ getReadable: readStream }))
const logInfo = mock.method(console, 'info', () => {})
let GET: typeof import('./route')['GET']
before(async () => {
  mock.module(new URL('../../../../lib/auth.ts', import.meta.url).href, { namedExports: { auth: { api: { getSession } } } })
  mock.module(new URL('../../../../lib/db/index.ts', import.meta.url).href, { namedExports: { db, pool: {} } })
  mock.module(new URL('../../../../lib/credentials/chat-guard.ts', import.meta.url).href, { namedExports: { credentialChatFingerprints: loadFingerprints } })
  mock.module(new URL('../../../../lib/request-log.ts', import.meta.url).href, { namedExports: {
    noteLogRpcAction: () => {}, noteLogUser: () => {}, withRequestLog: (_path: string, handler: unknown) => handler,
  } })
  mock.module('workflow/api', { namedExports: { getRun } })
  mock.module(new URL('../../../../lib/coordinator/coordinator-bot.ts', import.meta.url).href, { namedExports: {
    chatBotId: async (owner: string, chosen: string | null | undefined) => chosen ?? coordinatorOf[owner],
    openChatBotId: async (user: { id: string }, chosen: string | null | undefined) => chosen ?? coordinatorOf[user.id],
  } })
  mock.module(new URL('../../../../lib/resource-access/request-chat.ts', import.meta.url).href, { namedExports: { requestBotChat: resolveChat } })
  mock.module(new URL('../../../../lib/collaboration/bot-chat-provenance.ts', import.meta.url).href, { namedExports: { botChatExecutionVisible: executionVisible } })
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
  fingerprints = []; queries.length = 0; sharedPermission = false; sourceVisible = true
  resolveChat.mock.resetCalls(); executionVisible.mock.resetCalls()
  getSession.mock.resetCalls(); loadFingerprints.mock.resetCalls(); getRun.mock.resetCalls(); readStream.mock.resetCalls()
  logInfo.mock.resetCalls()
  source = () => partsStream([start(), delta('visible reply'), committed()])
})
const call = (params: Record<string, string> = {}, headers: Record<string, string> = {}) => GET(new Request(`https://mikka.example/mikka/api/coordinator/stream?${new URLSearchParams(params)}`, { headers }))
const events = async (response: Response): Promise<CoordinatorStreamEvent[]> => (await response.text()).trim().split('\n').filter(Boolean).map(line => { const { sequence: _sequence, ...event } = JSON.parse(line); return event })
const noStream = () => { assert.equal(getRun.mock.callCount(), 0); assert.equal(loadFingerprints.mock.callCount(), 0) }

test('reconnect sends only events after the acknowledged cursor and resets for a changed stream key', async () => {
  const first = await call()
  const key = first.headers.get('x-mikka-stream-key')!
  const all = (await first.text()).trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(all.map(event => event.sequence), [1, 2, 3])
  const resumed = await call({ after: '2' }, { 'x-mikka-stream-key': key })
  assert.equal(resumed.headers.get('x-mikka-stream-reset'), '0')
  assert.deepEqual((await events(resumed)).map(event => event.type), ['committed'])
  const reset = await call({ after: '2' }, { 'x-mikka-stream-key': 'stale-policy' })
  assert.equal(reset.headers.get('x-mikka-stream-reset'), '1')
  assert.deepEqual((await events(reset)).map(event => event.type), ['start', 'text', 'committed'])
  assert.equal((await call({ after: '-1' })).status, 400)
})

test('a cursor from the earlier unscoped projection replays instead of skipping new chunk boundaries', async () => {
  const oldKey = createHash('sha256').update(JSON.stringify(['wrun_owner', fingerprints])).digest('hex')
  const response = await call({ after: '2' }, { 'x-mikka-stream-key': oldKey })
  assert.equal(response.headers.get('x-mikka-stream-reset'), '1')
  assert.deepEqual((await events(response)).map(event => event.type), ['start', 'text', 'committed'])
  assert.equal(loadFingerprints.mock.callCount(), 1)
  assert.equal(queries.length, 1)
})

test('HTTP projection diagnostics use the already loaded fingerprints and never log their values or reply text', async () => {
  const old = process.env.BETTER_AUTH_SECRET
  process.env.BETTER_AUTH_SECRET = 'offline-stream-guard-fixture-secret'
  try {
    const secret = 'synthetic-fingerprint-source-'.repeat(4)
    fingerprints = [fingerprint('owner', secret)]
    source = () => partsStream([{ type: 'coordinator-turn-start', id: 'turn:0', quietEligible: false, modelStream: 'scoped-v1' },
      { type: 'coordinator-model-part', id: 'turn:0', part: delta('synthetic short reply') },
      { type: 'coordinator-turn-stopped', id: 'turn:0' },
      { type: 'coordinator-model-part', id: 'turn:0', part: delta('must stay hidden') }, committed()])
    const result = await events(await call())
    assert.equal(result.filter(event => event.type === 'text').map(event => event.delta).join(''), 'synthetic short reply')
    assert.equal(loadFingerprints.mock.callCount(), 1)
    assert.equal(queries.length, 1)
    assert.equal(logInfo.mock.callCount(), 1)
    const serialized = logInfo.mock.calls[0].arguments[0] as string
    const sample = JSON.parse(serialized)
    assert.deepEqual(Object.keys(sample).sort(), ['msg', 'streamId', 'fingerprintCount', 'maxHoldback', 'firstRawTextMs', 'firstEmittedTextMs',
      'committedMs', 'firstEmittedAtCommitted', 'firstBlockedByHoldback', 'quietEligible', 'stopped', 'terminal'].sort())
    assert.equal(sample.msg, 'coordinator_stream_projection_timing')
    assert.equal(sample.streamId, 'turn:0')
    for (const [key, value] of Object.entries(sample)) {
      if (key !== 'msg' && key !== 'streamId') assert.ok(value === null || typeof value === 'number' && Number.isFinite(value))
    }
    assert.equal(sample.fingerprintCount, 1)
    assert.equal(sample.maxHoldback, secret.length - 1)
    assert.equal(sample.firstBlockedByHoldback, 1)
    assert.equal(sample.firstEmittedAtCommitted, 1)
    assert.equal(sample.stopped, 1)
    assert.equal(sample.terminal, 0)
    for (const forbidden of [secret, fingerprints[0].digest, process.env.BETTER_AUTH_SECRET, 'synthetic short reply', 'must stay hidden']) {
      assert.equal(serialized.includes(forbidden), false)
    }
  } finally { if (old === undefined) delete process.env.BETTER_AUTH_SECRET; else process.env.BETTER_AUTH_SECRET = old }
})

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

test('a private bot stream requires explicit access and selects that bot rather than the Coordinator', async () => {
  assert.equal((await call({ botId: peerBotId, runId: 'wrun_peer_bot' })).status, 404)
  assert.equal(queries.length, 0); noStream()
  const response = await call({ botId, runId: 'wrun_owner_bot' })
  assert.equal(response.status, 200)
  assert.deepEqual(getRun.mock.calls[0].arguments, ['wrun_owner_bot'])
  assert.deepEqual(queries.at(-1)?.params.slice(0, 2), ['owner', botId])
  await response.text()
})

test('workspace-scoped API sessions cannot stream an owned bot outside their workspace', async () => {
  session!.tokenWorkspaceId = '10000000-0000-4000-8000-000000000099'
  assert.equal((await call({ botId })).status, 404)
  assert.equal(queries.length, 0); noStream()
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

test('a stream opened at send with no turn yet answers 204 without a stream when nothing waits in the inbox', async () => {
  chats = chats.filter(chat => !(chat.userId === 'owner' && chat.botId === coordinatorOf.owner))
  mock.module(new URL('../../../../lib/coordinator/store.ts', import.meta.url).href, { namedExports: { hasPendingEvents: async () => false } })
  const response = await call({ wait: '1' })
  assert.equal(response.status, 204)
  noStream()
})

test('a stream opened at send joins a turn that already holds the chat and names its run', async () => {
  const response = await call({ wait: '1' })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-mikka-stream-run'), 'wrun_owner')
  assert.deepEqual(getRun.mock.calls.map(c => c.arguments[0]), ['wrun_owner'])
})

test('a version 2 cursor replays after stopped-text projection boundaries change', async () => {
  const oldKey = createHash('sha256').update(JSON.stringify(['wrun_owner', fingerprints, 2])).digest('hex')
  const response = await call({ after: '2' }, { 'x-mikka-stream-key': oldKey })
  assert.equal(response.headers.get('x-mikka-stream-reset'), '1')
  assert.deepEqual((await events(response)).map(event => event.type), ['start', 'text', 'committed'])
})


test('an authorized shared viewer reads only a proven clean execution, with the structural Owner masking policy', async () => {
  session!.user.id = 'peer'
  sharedPermission = true
  const response = await call({ botId, runId: 'wrun_owner_bot' })
  assert.equal(response.status, 200)
  assert.deepEqual(loadFingerprints.mock.calls[0].arguments, ['owner'])
  assert.equal((await events(response)).filter(event => event.type === 'text').map(event => event.delta).join(''), 'visible reply')
  assert.ok(executionVisible.mock.callCount() > 1, 'provenance is checked before opening and before emitting')
  sourceVisible = false
  getRun.mock.resetCalls(); loadFingerprints.mock.resetCalls()
  assert.equal((await call({ botId, runId: 'wrun_owner_bot' })).status, 404)
  noStream()
})

for (const revoked of ['permission', 'session', 'source'] as const) test(`a live stream stops before the next bytes after ${revoked} revocation`, async () => {
  session!.user.id = 'peer'; sharedPermission = true
  let upstream!: ReadableStreamDefaultController<CoordinatorWorkflowStreamPart>
  source = () => new ReadableStream<CoordinatorWorkflowStreamPart>({ start(controller) { upstream = controller; controller.enqueue(start()) } })
  const response = await call({ botId })
  const reader = response.body!.getReader()
  assert.match(new TextDecoder().decode((await reader.read()).value), /"type":"start"/)
  if (revoked === 'permission') sharedPermission = false
  else if (revoked === 'session') session = null
  else sourceVisible = false
  upstream.enqueue(delta('revoked-private-bytes')); upstream.close()
  let rest = ''
  for (;;) { const next = await reader.read(); if (next.done) break; rest += new TextDecoder().decode(next.value) }
  assert.doesNotMatch(rest, /revoked-private-bytes/)
  assert.match(rest, /"type":"error"/)
})
