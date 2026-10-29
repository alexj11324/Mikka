import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { before, mock, test } from 'node:test'

let enabled = false
let reads = 0
let claims = 0
let syncs = 0
let finishClaimed = false
let finished = 0
let scheduled: Array<() => Promise<void>> = []
const unexpected = () => { reads++; throw new Error('Unexpected database, authentication or provider access') }
let worker: typeof import('./worker')
let dispatch: typeof import('./dispatch')
let actions: typeof import('../../app/actions/linear-sync')
let webhook: typeof import('../../app/api/webhooks/linear/route')
let cron: typeof import('../../app/api/cron/linear-sync/route')
let status: typeof import('../../app/api/integrations/linear/status/route')
let callback: typeof import('../../app/api/integrations/linear/callback/route')

before(async () => {
  mock.module('./flags', { namedExports: {
    linearSyncEnabled: async () => enabled,
    linearSyncDisabledResponse: () => Response.json({ disabled: true }, { status: 503, headers: { 'retry-after': '60' } }),
  } })
  mock.module('next/server', { namedExports: { after: (fn: () => Promise<void>) => { scheduled.push(fn) }, NextResponse: { redirect: unexpected } } })
  mock.module('next/headers', { namedExports: { cookies: unexpected } })
  mock.module('@/lib/db', { namedExports: {
    db: { select: unexpected, insert: unexpected, update: () => {
      if (!finishClaimed) return unexpected()
      return { set: (values: { status: string }) => ({ where: async () => {
        assert.equal(values.status, 'done'); finished++
      } }) }
    }, transaction: unexpected },
    pool: { connect: async () => {
      claims++
      return { query: async (query: string) => {
        if (query.startsWith('select') && finishClaimed) {
          enabled = false
          return { rows: [{ deliveryId: 'already-claimed', attempts: 1, payload: { type: 'unsupported-historical-event' } }] }
        }
        if (query.startsWith('select')) return { rows: [] }
        return { rows: [] }
      }, release() {} }
    } },
  } })
  mock.module('./issue-sync', { namedExports: {
    createAppIssueFromLinear: unexpected, applyLinearIssueToApp: unexpected,
    syncAppIssueToLinear: () => { syncs++ }, LinearSyncConflictError: class extends Error {},
  } })
  mock.module('./comment-sync', { namedExports: { applyLinearCommentToApp: unexpected } })
  mock.module('./tokens', { namedExports: { linearAccessToken: unexpected } })
  mock.module('@/lib/issue-access', { namedExports: { requireUser: unexpected, requireIssueAccess: unexpected } })
  mock.module('./oauth', { namedExports: {
    createLinearAuthorizationUrl: unexpected, disconnectLinear: unexpected, exchangeLinearCode: unexpected,
    LINEAR_OAUTH_CALLBACK_PATH: '/mikka/api/integrations/linear/callback', LINEAR_OAUTH_STATE_COOKIE: 'state',
    linearAccessToken: unexpected, linearOAuthConfigured: unexpected,
  } })
  mock.module('@/lib/suggestions/sources', { namedExports: { linearWebhookNotifications: unexpected, bootstrapSuggestions: unexpected } })
  mock.module('@/lib/suggestions/store', { namedExports: { ingestNotifications: unexpected } })
  worker = await import('./worker')
  dispatch = await import('./dispatch')
  actions = await import('../../app/actions/linear-sync')
  webhook = await import('../../app/api/webhooks/linear/route')
  cron = await import('../../app/api/cron/linear-sync/route')
  status = await import('../../app/api/integrations/linear/status/route')
  callback = await import('../../app/api/integrations/linear/callback/route')
})

test('disabled direct worker calls preserve jobs without claims, reads or API calls; re-enable resumes claims', async () => {
  enabled = false; claims = 0; reads = 0
  assert.deepEqual(await worker.processLinearSyncBatch(), { inbox: 0, outbox: 0, disabled: true })
  await worker.processLinearIssueOutbox('issue')
  await worker.processLinearInboxDelivery('delivery')
  assert.equal(claims, 0); assert.equal(reads, 0); assert.equal(syncs, 0)
  enabled = true
  assert.deepEqual(await worker.processLinearSyncBatch(), { inbox: 0, outbox: 0 })
  assert.equal(claims, 2)
  enabled = false
  await worker.processLinearSyncBatch()
  assert.equal(claims, 2)
})

test('dispatch rechecks at execution time and does not start a disabled batch or single delivery', async () => {
  enabled = true; scheduled = []; claims = 0
  dispatch.dispatchLinearWork(); dispatch.dispatchLinearIssueSync('issue'); dispatch.dispatchLinearWebhook('delivery')
  assert.equal(scheduled.length, 3)
  enabled = false
  await Promise.all(scheduled.map(fn => fn()))
  assert.equal(claims, 0)
})

test('disabling after a claim finishes that job and prevents subsequent inbox and outbox claims', async () => {
  enabled = true; finishClaimed = true; claims = 0; finished = 0
  try {
    const result = await worker.processLinearSyncBatch(3)
    assert.deepEqual(result, { inbox: 1, outbox: 0 })
    assert.equal(finished, 1)
    assert.equal(claims, 1)
  } finally { finishClaimed = false; enabled = false }
})

test('disabled actions and availability endpoint do not authenticate or query integration tables', async () => {
  enabled = false; reads = 0
  assert.equal((await actions.getLinearIntegrationState()).enabled, false)
  assert.deepEqual(await actions.listLinearTeamOptions(), [])
  assert.deepEqual(await actions.enableLinearTeam({ teamId: 'team' }), { error: 'linearSyncDisabled' })
  assert.deepEqual(await actions.retryLinearIssue('issue'), { error: 'linearSyncDisabled' })
  assert.deepEqual(await actions.retryLinearDelivery('delivery'), { error: 'linearSyncDisabled' })
  await assert.rejects(actions.startLinearOAuth(), /disabled/)
  const response = await status.GET()
  assert.deepEqual(await response.json(), { enabled: false })
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal((await callback.GET(new Request('https://app.invalid/mikka/api/integrations/linear/callback'))).status, 503)
  assert.equal(reads, 0)
})

test('Next routes authenticate before returning disabled without queuing, draining or suggestion ingestion', async () => {
  enabled = false; reads = 0; claims = 0; scheduled = []
  process.env.CRON_SECRET = 'test-cron'
  process.env.LINEAR_WEBHOOK_SECRET = 'test-webhook'
  const cronRequest = (token: string) => new Request('https://app.invalid/mikka/api/cron/linear-sync', { headers: { authorization: `Bearer ${token}` } })
  assert.equal((await cron.GET(cronRequest('wrong'))).status, 401)
  assert.deepEqual(await (await cron.GET(cronRequest('test-cron'))).json(), { inbox: 0, outbox: 0, disabled: true })
  const body = JSON.stringify({ action: 'update', type: 'Issue', organizationId: 'org', webhookTimestamp: Date.now(), data: { id: 'issue' } })
  const request = (signature: string) => new Request('https://app.invalid/mikka/api/webhooks/linear', { method: 'POST', headers: { 'linear-event': 'Issue', 'linear-delivery': 'delivery', 'linear-signature': signature }, body })
  assert.equal((await webhook.POST(request('0'.repeat(64)))).status, 401)
  const signature = createHmac('sha256', 'test-webhook').update(body).digest('hex')
  const response = await webhook.POST(request(signature))
  assert.equal(response.status, 503)
  assert.equal(response.headers.get('retry-after'), '60')
  assert.equal(reads, 0); assert.equal(claims, 0); assert.equal(scheduled.length, 0)
})
