import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { registerHooks } from 'node:module'
import { after, before, beforeEach, mock, test } from 'node:test'

const secret = 'source-only-github-webhook-secret'
const originalSecret = process.env.GITHUB_WEBHOOK_SECRET
const callbacks: Array<() => Promise<void>> = []
const refresh = mock.fn(async (_event: string, _payload: unknown) => {})
const notifications = [{ userId: 'owner', source: 'github', externalId: 'comment:7' }]
const readNotifications = mock.fn(async (_event: string, _payload: unknown) => notifications)
const ingest = mock.fn(async (_notifications: unknown[]) => {})
mock.module('next/server', { namedExports: { after: (callback: () => Promise<void>) => callbacks.push(callback) } })
const heavyModules = ['lib/github/publication-webhook.ts', 'lib/suggestions/sources.ts', 'lib/suggestions/store.ts']
mock.module(new URL('../../../../lib/github/publication-webhook.ts', import.meta.url).href, { namedExports: { refreshPublishedPullRequest: refresh } })
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
  callbacks.length = 0
  refresh.mock.resetCalls()
  refresh.mock.mockImplementation(async () => {})
  readNotifications.mock.resetCalls()
  readNotifications.mock.mockImplementation(async () => notifications)
  ingest.mock.resetCalls()
})
after(() => {
  hooks.deregister()
  if (originalSecret === undefined) delete process.env.GITHUB_WEBHOOK_SECRET
  else process.env.GITHUB_WEBHOOK_SECRET = originalSecret
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
    ['issue_comment', { action: 'edited', issue: { user: { id: 42 } } }], ['issues', null],
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

test('every pull-request action still refreshes publication without loading notification processing', async () => {
  for (const action of ['opened', 'closed', 'edited', 'synchronize']) {
    const payload = { action, pull_request: { number: 7 } }
    assert.equal((await POST(request('pull_request', payload))).status, 202)
    await callbacks.shift()!()
    assert.deepEqual(refresh.mock.calls.at(-1)!.arguments, ['pull_request', payload])
  }
  assert.equal(refresh.mock.callCount(), 4)
  assert.equal(readNotifications.mock.callCount(), 0)
  assert.equal(ingest.mock.callCount(), 0)
  assert.ok(loaded.some(url => url.includes('lib/github/publication-webhook.ts')))
  assert.equal(loaded.some(url => url.includes('lib/suggestions/sources.ts') || url.includes('lib/suggestions/store.ts')), false)
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

test('publication failure cannot suppress an accepted PR notification', async () => {
  refresh.mock.mockImplementation(async () => { throw Error('test publication failure') })
  const error = mock.method(console, 'error', () => {})
  try {
    assert.equal((await POST(request('pull_request', { action: 'review_requested', requested_reviewer: { id: 42 } }))).status, 202)
    await callbacks.shift()!()
    assert.equal(refresh.mock.callCount(), 1)
    assert.equal(readNotifications.mock.callCount(), 1)
    assert.equal(ingest.mock.callCount(), 1)
    assert.equal(error.mock.callCount(), 1)
  } finally { error.mock.restore() }
})
