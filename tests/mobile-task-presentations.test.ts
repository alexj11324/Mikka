import assert from 'node:assert/strict'
import { after, beforeEach, mock, test } from 'node:test'
import { ActionFailureError } from '../lib/action-error'
import { actingContext } from '../lib/activity-actor'
import { enterprisePrincipal, type EnterprisePrincipal } from '../lib/enterprise/principal'
import { tokenWorkspace } from '../lib/tokens/principal'
import type { TaskPresentationsInput } from '../lib/task-presentation-input'
import { WorkspaceError } from '../lib/workspace-error'

// Adapter-only: mobileUser/writeAllowed/json, actAs and the shared schema are
// real. Authentication and the already DB-tested batch action are boundaries.
const ORIGIN = 'https://mobile.fixture.test'
const CONFIGURED_ORIGIN = 'https://app.fixture.test'
const REQUEST_URL = `${ORIGIN}/api/mobile/task-presentations`
const COOKIE = 'native-session=adapter-fixture'
const WORKSPACE = '11111111-1111-4111-8111-111111111111'
const issueId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const INPUT = { workspaceId: WORKSPACE, issueIds: [issueId(1)] }
const RESULT = { version: 1, workspaceId: WORKSPACE, items: {
  [issueId(1)]: { version: 1, primaryStatus: 'todo', factoryStage: null, runStatus: null, needsAction: null, blockedReason: null, completion: null,
    state: 'todo', reason: null, blockedBy: null, group: 'todo' },
} }
type User = { id: string; [enterprisePrincipal]?: EnterprisePrincipal; [tokenWorkspace]?: string }
const proof: EnterprisePrincipal = { kind: 'session', sessionId: 'native-session-fixture' }
const nativeUser = () => Object.defineProperty({ id: 'native-user' }, enterprisePrincipal, { value: proof }) as User
let user: User | null = nativeUser()
const authHeaders: Headers[] = []
const calls: { input: TaskPresentationsInput; actor: ReturnType<typeof actingContext.getStore> }[] = []
let batch: (input: TaskPresentationsInput) => Promise<unknown> = async () => RESULT

mock.module(new URL('../lib/auth.ts', import.meta.url).href, { namedExports: {
  MOBILE_APP_ORIGIN: 'mikka://',
  auth: { api: { getSession: async () => { throw new Error('Unexpected ambient session read') } } },
} })
mock.module(new URL('../lib/api-auth.ts', import.meta.url).href, { namedExports: {
  auth: { api: { getSession: async ({ headers }: { headers: Headers }) => {
    authHeaders.push(new Headers(headers))
    const authenticated = headers.get('cookie') === COOKIE || headers.get('authorization') === 'Bearer unit-verified-pat'
    return authenticated && user ? { user, session: { id: 'adapter-session' } } : null
  } } },
} })
mock.module(new URL('../lib/mcp/resource.ts', import.meta.url).href, { namedExports: { appOrigin: CONFIGURED_ORIGIN } })
mock.module(new URL('../lib/request-log.ts', import.meta.url).href, { namedExports: {
  noteLogUser: () => {},
  withRequestLog: (route: string, handler: unknown) => { assert.equal(route, '/api/mobile/task-presentations'); return handler },
} })
mock.module(new URL('../app/actions/task-domain.ts', import.meta.url).href, { namedExports: {
  getTaskPresentations: async (input: TaskPresentationsInput) => {
    calls.push({ input, actor: actingContext.getStore() })
    return batch(input)
  },
} })

const { POST } = await import('../app/api/mobile/task-presentations/route')
const { pool } = await import('../lib/db')
after(async () => { assert.equal(pool.totalCount, 0, 'the adapter never opens a database connection'); await pool.end() })
beforeEach(() => {
  user = nativeUser()
  authHeaders.length = 0
  calls.length = 0
  batch = async () => RESULT
})

function request(body: BodyInit | null = JSON.stringify(INPUT), headers: HeadersInit = {}) {
  const values = new Headers({ cookie: COOKIE, 'content-type': 'application/json' })
  new Headers(headers).forEach((value, key) => values.set(key, value))
  return new Request(REQUEST_URL, { method: 'POST', headers: values, body, duplex: 'half' } as RequestInit)
}

async function response(request: Request) {
  const result = await POST(request)
  assert.equal(result.headers.get('cache-control'), 'private, no-store')
  assert.match(result.headers.get('content-type') ?? '', /^application\/json/)
  return { status: result.status, body: await result.json() }
}

function streamed(chunks: Uint8Array[], options: { cancelError?: Error; close?: boolean; headers?: HeadersInit } = {}) {
  let reads = 0, canceled = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[reads++]
      if (chunk) controller.enqueue(chunk)
      else if (options.close !== false) controller.close()
    },
    cancel() { canceled++; if (options.cancelError) throw options.cancelError },
  }, { highWaterMark: 0 })
  const req = request(stream, options.headers)
  return { request: req, stats: () => ({ reads, canceled, locked: req.body!.locked }) }
}

test('a native Cookie request without Origin reaches the batch through real actAs and retains its non-enumerable session proof', async () => {
  const req = request()
  assert.equal(req.headers.has('origin'), false)
  assert.equal(req.headers.has('expo-origin'), false)
  assert.deepEqual(Object.keys(user!), ['id'])
  assert.deepEqual(await response(req), { status: 200, body: RESULT })
  assert.equal(authHeaders[0].get('cookie'), COOKIE)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].input, INPUT)
  assert.equal(calls[0].actor?.userId, 'native-user')
  assert.equal(calls[0].actor?.enterprisePrincipal, proof)
  assert.equal(calls[0].actor?.tokenWorkspaceId, undefined)
  assert.equal(actingContext.getStore(), undefined, 'the acting identity does not escape the request')
})

test('a verified PAT keeps both non-enumerable token scope and principal at the batch boundary', async () => {
  const principal: EnterprisePrincipal = { kind: 'pat', tokenId: 'verified-token', workspaceId: WORKSPACE }
  user = Object.defineProperties({ id: 'pat-owner' }, {
    [enterprisePrincipal]: { value: principal }, [tokenWorkspace]: { value: WORKSPACE },
  })
  assert.deepEqual(Object.keys(user), ['id'])
  assert.equal((await response(request(undefined, { cookie: '', authorization: 'Bearer unit-verified-pat' }))).status, 200)
  assert.equal(calls[0].actor?.userId, 'pat-owner')
  assert.equal(calls[0].actor?.tokenWorkspaceId, WORKSPACE)
  assert.equal(calls[0].actor?.enterprisePrincipal, principal)
  assert.equal(actingContext.getStore(), undefined)
})

test('the existing same-site and Expo source policy stays available without impersonating a browser', async () => {
  const allowed: HeadersInit[] = [{ origin: ORIGIN }, { origin: CONFIGURED_ORIGIN }, { origin: 'mikka://app' }, { 'expo-origin': 'mikka://app' }]
  for (const headers of allowed)
    assert.equal((await response(request(undefined, headers))).status, 200)
  assert.equal(calls.length, 4)
})

test('missing or expired authentication returns the mobile 401 before invoking the batch', async () => {
  assert.deepEqual(await response(request(undefined, { cookie: '' })), { status: 401, body: { error: 'authRequired' } })
  user = null
  assert.deepEqual(await response(request()), { status: 401, body: { error: 'authRequired' } })
  assert.equal(calls.length, 0)
})

test('cross-site Origin and Expo-Origin are rejected even with a valid Cookie', async () => {
  const denied: HeadersInit[] = [{ origin: 'https://foreign.test' }, { origin: 'null' }, { 'expo-origin': 'https://foreign.test' }]
  for (const headers of denied)
    assert.deepEqual(await response(request(undefined, headers)), { status: 403, body: { error: 'originNotAllowed' } })
  assert.equal(calls.length, 0)
})

test('200 UUIDs and an empty batch reach the existing reader unchanged', async () => {
  for (const issueIds of [Array.from({ length: 200 }, (_, n) => issueId(n + 1)), []]) {
    const input = { workspaceId: WORKSPACE, issueIds }
    assert.equal((await response(request(JSON.stringify(input)))).status, 200)
    assert.deepEqual(calls.at(-1)?.input, input)
  }
  assert.equal(calls.length, 2, 'the empty batch is not answered before the authorized reader')
})

test('201 UUIDs, malformed IDs and extra authority fields never reach the batch', async () => {
  const invalid = [
    { ...INPUT, issueIds: Array.from({ length: 201 }, (_, n) => issueId(n + 1)) },
    { ...INPUT, workspaceId: 'not-a-uuid' }, { ...INPUT, issueIds: ['not-a-uuid'] },
    { ...INPUT, userId: 'foreign-user' }, { ...INPUT, tokenWorkspaceId: WORKSPACE },
    { ...INPUT, principal: { kind: 'admission', runId: issueId(2), workspaceId: WORKSPACE } },
  ]
  for (const input of invalid)
    assert.deepEqual(await response(request(JSON.stringify(input))), { status: 400, body: { error: 'invalidRequest' } })
  assert.equal(calls.length, 0)
})

test('absent, malformed JSON and invalid UTF-8 bodies return only invalidRequest', async () => {
  for (const body of [null, '{', Buffer.from([0x7b, 0xff, 0x7d])])
    assert.deepEqual(await response(request(body)), { status: 400, body: { error: 'invalidRequest' } })
  assert.equal(calls.length, 0)
})

test('exactly 16 KiB of streamed valid JSON is accepted and the reader lock is released', async () => {
  const json = JSON.stringify(INPUT)
  const bytes = Buffer.from(json + ' '.repeat(16_384 - Buffer.byteLength(json)))
  assert.equal(bytes.byteLength, 16_384)
  const stream = streamed([bytes.subarray(0, 8192), bytes.subarray(8192)])
  assert.equal((await response(stream.request)).status, 200)
  assert.deepEqual(calls[0].input, INPUT)
  assert.equal(stream.stats().locked, false)
})

test('the streamed byte limit rejects without trusting Content-Length and cancels unread data', async () => {
  // 8,193 UTF-8 characters occupy 16,386 bytes: character counts are not the bound.
  const bytes = Buffer.from('é'.repeat(8193))
  const stream = streamed([bytes.subarray(0, 8192), bytes.subarray(8192), Buffer.from('unread')], {
    close: false, headers: { 'content-length': '1' },
  })
  assert.deepEqual(await response(stream.request), { status: 413, body: { error: 'bodyTooLarge' } })
  assert.deepEqual(stream.stats(), { reads: 2, canceled: 1, locked: false })
  assert.equal(calls.length, 0)
})

test('a cancel rejection cannot replace the determined 413 and still releases the reader lock', async () => {
  const stream = streamed([new Uint8Array(16_385)], { close: false, cancelError: new Error('fixture cancel failed') })
  assert.deepEqual(await response(stream.request), { status: 413, body: { error: 'bodyTooLarge' } })
  assert.deepEqual(stream.stats(), { reads: 1, canceled: 1, locked: false })
  assert.equal(calls.length, 0)
})

test('a stream read failure preserves the original error and releases the reader lock', async () => {
  const original = new Error('fixture stream failed')
  const req = request(new ReadableStream({ pull() { throw original } }, { highWaterMark: 0 }))
  await assert.rejects(POST(req), error => error === original)
  assert.equal(req.body!.locked, false)
  assert.equal(calls.length, 0)
})

test('known Workspace failures map to 403 and a late missing user maps to 401', async () => {
  for (const failure of [new WorkspaceError('workspaceMembershipSuspended'), new ActionFailureError('workspaceAccessDenied')]) {
    batch = async () => { throw failure }
    assert.deepEqual(await response(request()), { status: 403, body: { error: 'workspaceAccessDenied' } })
  }
  batch = async () => { throw new ActionFailureError('authRequired') }
  assert.deepEqual(await response(request()), { status: 401, body: { error: 'authRequired' } })
})

test('unknown action failures escape unchanged instead of becoming an input or permission response', async () => {
  const original = new Error('fixture internal failure', { cause: new Error('fixture cause') })
  batch = async () => { throw original }
  await assert.rejects(POST(request()), error => error === original)
  assert.equal(calls.length, 1)
  assert.equal(actingContext.getStore(), undefined)
})
