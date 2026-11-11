import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { registerHooks } from 'node:module'
import { after, before, beforeEach, mock, test } from 'node:test'

const secret = 'source-only-github-webhook-secret'
const originalSecret = process.env.GITHUB_WEBHOOK_SECRET
const originalEdition = process.env.MIKKA_EDITION, originalBackend = process.env.MIKKA_CLOUD_BACKEND_URL
mock.module(new URL('../../../../lib/github/app-config.ts', import.meta.url).href, { namedExports: { readGitHubAppConfig: async () => ({ webhookSecret: process.env.GITHUB_WEBHOOK_SECRET ?? null }) } })
const callbacks: Array<() => Promise<void>> = []
const refresh = mock.fn(async (_event: string, _payload: unknown) => {})
const wakeSuite = mock.fn(async (_suite: unknown) => 1)
const notifications = [{ userId: 'owner', source: 'github', externalId: 'comment:7' }]
const readNotifications = mock.fn(async (_event: string, _payload: unknown) => notifications)
const ingest = mock.fn(async (_notifications: unknown[]) => {})
mock.module('next/server', { namedExports: { after: (callback: () => Promise<void>) => callbacks.push(callback) } })
const heavyModules = ['lib/github/publication-webhook.ts', 'lib/github/ci-suite-wake.ts', 'lib/suggestions/sources.ts', 'lib/suggestions/store.ts']
mock.module(new URL('../../../../lib/github/publication-webhook.ts', import.meta.url).href, { namedExports: { refreshPublishedPullRequest: refresh } })
mock.module(new URL('../../../../lib/github/ci-suite-wake.ts', import.meta.url).href, { namedExports: { wakeLinkedCiSuite: wakeSuite } })
mock.module(new URL('../../../../lib/suggestions/sources.ts', import.meta.url).href, { namedExports: { githubWebhookNotifications: readNotifications } })
mock.module(new URL('../../../../lib/suggestions/store.ts', import.meta.url).href, { namedExports: { ingestNotifications: ingest } })
const loaded: string[] = []
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context)
    if (heavyModules.some(path => result.url.includes(path))) loaded.push(result.url)
    return result
  },
})
let POST: typeof import('./route')['POST']
before(async () => { ({ POST } = await import('./route')) })
beforeEach(() => {
  process.env.GITHUB_WEBHOOK_SECRET = secret
  process.env.MIKKA_EDITION = 'community'
  delete process.env.MIKKA_CLOUD_BACKEND_URL
  callbacks.length = 0
  refresh.mock.resetCalls()
  refresh.mock.mockImplementation(async () => {})
  wakeSuite.mock.resetCalls()
  wakeSuite.mock.mockImplementation(async () => 1)
  readNotifications.mock.resetCalls()
  readNotifications.mock.mockImplementation(async () => notifications)
  ingest.mock.resetCalls()
})
after(() => {
  hooks.deregister()
  if (originalSecret === undefined) delete process.env.GITHUB_WEBHOOK_SECRET
  else process.env.GITHUB_WEBHOOK_SECRET = originalSecret
  if (originalEdition === undefined) delete process.env.MIKKA_EDITION
  else process.env.MIKKA_EDITION = originalEdition
  if (originalBackend === undefined) delete process.env.MIKKA_CLOUD_BACKEND_URL
  else process.env.MIKKA_CLOUD_BACKEND_URL = originalBackend
})

function request(event: string, payload: unknown, signature?: string) {
  return rawRequest(event, JSON.stringify(payload), signature)
}

function rawRequest(event: string, body: string, signature?: string) {
  return new Request('https://preview.example.test/mikka/api/webhooks/github', {
    method: 'POST', body,
    headers: { 'x-github-event': event, 'x-hub-signature-256': signature ?? `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` },
  })
}

test('route import and signed no-op actions never load heavy modules or schedule background work', async () => {
  for (const [event, payload] of [
    ['ping', {}], ['check_run', { action: 'completed' }], ['deployment_protection_rule', {}],
    ['issues', { action: 'opened', assignee: { id: 42 } }],
    ['issues', { action: 'closed', assignee: { id: 42 } }],
    ['issues', { action: 'edited', assignee: { id: 42 } }],
    ['issue_comment', { action: 'edited', issue: { user: { id: 42 } } }],
  ] as const) {
    const response = await POST(request(event, payload))
    assert.equal(response.status, 204, event)
    assert.equal(response.headers.get('cache-control'), 'no-store')
  }
  assert.deepEqual(callbacks, [])
  assert.deepEqual(loaded, [])
})

test('configuration, raw-body signature, size and JSON errors remain ahead of event admission', async () => {
  delete process.env.GITHUB_WEBHOOK_SECRET
  assert.equal((await POST(request('issues', {}))).status, 503)
  process.env.GITHUB_WEBHOOK_SECRET = secret
  assert.equal((await POST(request('issues', {}, 'sha256=invalid'))).status, 401)
  assert.equal((await POST(rawRequest('issues', 'x'.repeat(1_000_001)))).status, 413)
  assert.equal((await POST(rawRequest('issues', '{'))).status, 400)
  assert.equal((await POST(request('issues', null))).status, 400)
  assert.equal((await POST(request('issues', []))).status, 400)
  assert.deepEqual(callbacks, [])
  assert.deepEqual(loaded, [])
})

test('request logs mark only authenticated admission outcomes without payload or header data', async () => {
  const lines: string[] = []
  const log = mock.method(console, 'log', (line: string) => { lines.push(line) })
  const warn = mock.method(console, 'warn', (line: string) => { lines.push(line) })
  try {
    await POST(request('check_run', { privateBody: 'SECRET_BODY' }))
    await POST(request('check_run', { privateBody: 'SECRET_BODY' }, 'sha256=SECRET_SIGNATURE'))
    await POST(request('pull_request', { action: 'synchronize', number: 'SECRET_NUMBER' }))
    const completed = lines.map(line => JSON.parse(line)).filter(entry => entry.msg === 'api_request')
    assert.deepEqual(completed.map(entry => [entry.status, entry.outcome]), [[204, 'ignored'], [401, undefined], [202, 'work']])
    assert.ok(completed.every(entry => entry.route === '/api/webhooks/github'))
    assert.ok(!lines.some(line => line.includes('SECRET_')))
    assert.equal(callbacks.length, 1)
  } finally { log.mock.restore(); warn.mock.restore() }
})

test('pull-request actions that can change a delivery refresh it without loading notification processing', async () => {
  const actions = ['opened', 'reopened', 'closed', 'edited', 'synchronize', 'ready_for_review', 'converted_to_draft']
  for (const action of actions) {
    const payload = { action, pull_request: { number: 7 } }
    assert.equal((await POST(request('pull_request', payload))).status, 202)
    await callbacks.shift()!()
    assert.deepEqual(refresh.mock.calls.at(-1)!.arguments, ['pull_request', payload])
  }
  assert.equal(refresh.mock.callCount(), actions.length)
  assert.equal(readNotifications.mock.callCount(), 0)
  assert.equal(ingest.mock.callCount(), 0)
  assert.ok(loaded.some(url => url.includes('lib/github/publication-webhook.ts')))
  assert.equal(loaded.some(url => url.includes('lib/suggestions/sources.ts') || url.includes('lib/suggestions/store.ts')), false)
})

test('pull-request actions that change nothing stored stop before any background work (#1212)', async () => {
  for (const action of ['labeled', 'unlabeled', 'review_request_removed', 'unassigned', 'auto_merge_enabled', 'locked', 'milestoned']) {
    assert.equal((await POST(request('pull_request', { action, pull_request: { number: 7 } }))).status, 204, action)
  }
  assert.deepEqual(callbacks, [])
  assert.equal(refresh.mock.callCount(), 0)
})

test('verified repository-bound check and status events use publication ingestion without notification work', async () => {
  const repository = { full_name: 'o/r' }, sha = 'a'.repeat(40), at = '2026-11-09T14:00:00Z'
  for (const [event, payload] of [
    ['check_run', { action: 'completed', repository, check_run: { id: 1, name: 'CI', head_sha: sha, app: { id: 1 }, check_suite: { id: 100 }, status: 'completed', conclusion: 'success', started_at: at, completed_at: at } }],
    ['status', { repository, id: 2, context: 'deploy', state: 'pending', sha, updated_at: at }],
  ] as const) {
    assert.equal((await POST(request(event, payload, 'sha256=invalid'))).status, 401)
    assert.equal((await POST(request(event, payload))).status, 202)
    await callbacks.shift()!()
    assert.deepEqual(refresh.mock.calls.at(-1)!.arguments, [event, payload])
  }
  assert.equal(readNotifications.mock.callCount(), 0)
  assert.equal(ingest.mock.callCount(), 0)
})


test('signed completed suite is durably enqueued before webhook ACK, without per-job wakeups', async () => {
  const hint = {
    installation: { id: 7 }, repository: { id: 8, full_name: 'acme/app' },
    action: 'completed',
    check_suite: {
      id: 9, status: 'completed', conclusion: 'failure',
      head_sha: 'a'.repeat(40), pull_requests: [{ number: 10 }],
    },
  }
  assert.equal((await POST(request('check_suite', hint, 'sha256=invalid'))).status, 401)
  assert.equal(wakeSuite.mock.callCount(), 0)
  assert.equal((await POST(request('check_suite', hint))).status, 202)
  assert.equal(wakeSuite.mock.callCount(), 1, 'persist before response, not in afterJob')
  assert.equal(callbacks.length, 0, 'suite-only webhook does not schedule empty afterJob')
  assert.deepEqual(wakeSuite.mock.calls[0].arguments[0], {
    installationId: 7, repositoryId: 8, repository: 'acme/app', suiteId: 9,
    headSha: 'a'.repeat(40), conclusion: 'failure', numbers: [10], heads: {},
  })
  assert.equal(refresh.mock.callCount(), 0)
  assert.equal(readNotifications.mock.callCount(), 0)
  assert.equal(wakeSuite.mock.callCount(), 1)
})

test('suite persistence failure fails the webhook and can be retried by GitHub', async () => {
  let attempts = 0
  wakeSuite.mock.mockImplementation(async () => { if (++attempts === 1) throw Error('queue unavailable'); return 1 })
  const hint = {
    installation: { id: 7 }, repository: { id: 8, full_name: 'acme/app' },
    action: 'completed',
    check_suite: { id: 9, status: 'completed', conclusion: 'failure', head_sha: 'a'.repeat(40), pull_requests: [{ number: 10 }] },
  }
  await assert.rejects(POST(request('check_suite', hint)), /queue unavailable/)
  assert.equal(callbacks.length, 0, 'never acknowledge before queue persistence')
  assert.equal((await POST(request('check_suite', hint))).status, 202)
  assert.equal(wakeSuite.mock.callCount(), 2)
})

test('created comments retain notification ingestion and do not refresh publications', async () => {
  const payload = { action: 'created', issue: { user: { id: 42 } } }
  assert.equal((await POST(request('issue_comment', payload))).status, 202)
  assert.equal(readNotifications.mock.callCount(), 0)
  await callbacks.shift()!()
  assert.equal(refresh.mock.callCount(), 0)
  assert.deepEqual(readNotifications.mock.calls[0].arguments, ['issue_comment', payload])
  assert.deepEqual(ingest.mock.calls[0].arguments, [notifications])
  assert.ok(loaded.some(url => url.includes('lib/suggestions/sources.ts')))
  assert.ok(loaded.some(url => url.includes('lib/suggestions/store.ts')))
})

test('notification candidates that match no Mikka account do not call ingestion', async () => {
  readNotifications.mock.mockImplementation(async () => [])
  assert.equal((await POST(request('issues', { action: 'assigned', assignee: { id: 42 } }))).status, 202)
  await callbacks.shift()!()
  assert.equal(readNotifications.mock.callCount(), 1)
  assert.equal(ingest.mock.callCount(), 0)
})

test('a review request is a notification only: it changes nothing a delivery stores', async () => {
  assert.equal((await POST(request('pull_request', { action: 'review_requested', requested_reviewer: { id: 42 } }))).status, 202)
  await callbacks.shift()!()
  assert.equal(refresh.mock.callCount(), 0)
  assert.equal(readNotifications.mock.callCount(), 1)
  assert.equal(ingest.mock.callCount(), 1)
})

test('a publication refresh failure is logged and does not fail the delivery', async () => {
  refresh.mock.mockImplementation(async () => { throw Error('test publication failure') })
  const error = mock.method(console, 'error', () => {})
  try {
    assert.equal((await POST(request('pull_request', { action: 'closed', pull_request: { number: 7 } }))).status, 202)
    await callbacks.shift()!()
    assert.equal(refresh.mock.callCount(), 1)
    assert.equal(error.mock.callCount(), 1)
  } finally { error.mock.restore() }
})

test('the official route keeps business handling in its own runtime and does not acknowledge a failed cloud bridge', async () => {
  process.env.MIKKA_EDITION = 'cloud'; process.env.MIKKA_CLOUD_BACKEND_URL = 'https://private.example.com'
  const body = JSON.stringify({ installation: { id: 99 }, action: 'synchronize', pull_request: { number: 7 }, privateBody: 'PRIVATE_WEBHOOK_FIXTURE' })
  let status = 503, sends = 0
  const send = mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    sends++; assert.equal(String(url), 'https://private.example.com/mikka/cloud/v1/github/webhook'); assert.equal(init?.body, body)
    assert.equal(new Headers(init?.headers).get('x-github-delivery'), 'fixture-delivery')
    return new Response('PRIVATE_PROVIDER_FIXTURE', { status })
  })
  const logs: unknown[] = [], error = mock.method(console, 'error', (...values: unknown[]) => { logs.push(values) })
  try {
    const invalid = rawRequest('pull_request', body, 'sha256=invalid'); invalid.headers.set('x-github-delivery', 'fixture-delivery')
    assert.equal((await POST(invalid)).status, 401); assert.equal(sends, 0)
    const input = rawRequest('pull_request', body); input.headers.set('x-github-delivery', 'fixture-delivery')
    const failed = await POST(input)
    assert.equal(failed.status, 503); assert.equal(sends, 1); assert.equal(callbacks.length, 1)
    assert.equal((await failed.text()).includes('PRIVATE_'), false)
    await callbacks.shift()!(); assert.equal(refresh.mock.callCount(), 1)
    status = 202
    const retry = rawRequest('pull_request', body); retry.headers.set('x-github-delivery', 'fixture-delivery')
    assert.equal((await POST(retry)).status, 202); assert.equal(sends, 2); assert.equal(callbacks.length, 1)
    assert.equal(JSON.stringify(logs).includes('PRIVATE_'), false)
  } finally { send.mock.restore(); error.mock.restore() }
})
