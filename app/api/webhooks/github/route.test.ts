import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { after, before, beforeEach, mock, test } from 'node:test'

const secret = 'synthetic-github-webhook-secret'
const originalSecret = process.env.GITHUB_WEBHOOK_SECRET
const originalFlag = process.env.MIKKA_CI_RESUME_ENABLED
const callbacks: Array<() => Promise<void>> = []
const query = mock.fn(async (_sql: string, _params: unknown[]) => ({ rows: [{ scheduled: true }] }))
const reconcile = mock.fn(async (_options: unknown) => ({}))
const notification = mock.fn(async () => [])
const ingest = mock.fn(async () => {})
mock.module('next/server', { namedExports: { after: (callback: () => Promise<void>) => callbacks.push(callback) } })
mock.module(new URL('../../../../lib/db/index.ts', import.meta.url).href, { namedExports: { pool: { connect: async () => ({ query, release: () => {} }) } } })
mock.module(new URL('../../../../lib/github/ci/reconcile.ts', import.meta.url).href, { namedExports: { reconcileCi: reconcile } })
mock.module(new URL('../../../../lib/suggestions/sources.ts', import.meta.url).href, { namedExports: { githubWebhookNotifications: notification } })
mock.module(new URL('../../../../lib/suggestions/store.ts', import.meta.url).href, { namedExports: { ingestNotifications: ingest } })
let POST: typeof import('./route')['POST']
before(async () => { ({ POST } = await import('./route')) })
beforeEach(() => { process.env.GITHUB_WEBHOOK_SECRET = secret; process.env.MIKKA_CI_RESUME_ENABLED = '1'; callbacks.length = 0; query.mock.resetCalls(); query.mock.mockImplementation(async () => ({ rows: [{ scheduled: true }] })); reconcile.mock.resetCalls(); notification.mock.resetCalls(); ingest.mock.resetCalls() })
after(() => {
  if (originalSecret === undefined) delete process.env.GITHUB_WEBHOOK_SECRET; else process.env.GITHUB_WEBHOOK_SECRET = originalSecret
  if (originalFlag === undefined) delete process.env.MIKKA_CI_RESUME_ENABLED; else process.env.MIKKA_CI_RESUME_ENABLED = originalFlag
})
function request(signature = true) {
  const body = JSON.stringify({ action: 'completed', repository: { id: 1 }, installation: { id: 2 }, workflow_run: { head_branch: 'mikka/issue-1', id: 42, run_attempt: 2, head_sha: 'a'.repeat(40) } })
  const hash = createHmac('sha256', secret).update(body).digest('hex')
  return new Request('https://example.test/api/webhooks/github', { method: 'POST', body, headers: { 'x-github-event': 'workflow_run', 'x-hub-signature-256': signature ? `sha256=${hash}` : 'sha256=invalid' } })
}
test('rejects unsigned requests before scheduling', async () => {
  assert.equal((await POST(request(false))).status, 401)
  assert.equal(query.mock.callCount(), 0)
})
test('acknowledges only after scheduling; deferred worker performs reconciliation', async () => {
  assert.equal((await POST(request())).status, 202)
  assert.equal(query.mock.callCount(), 4)
  assert.equal(reconcile.mock.callCount(), 0)
  await callbacks[0]()
  assert.equal(reconcile.mock.callCount(), 1)
})
test('CI table failure is logged and isolated: 202, suggestion ingest still runs, no CI reconcile', async () => {
  query.mock.mockImplementation(async (sql: string) => { if (sql === 'ROLLBACK') return { rows: [] }; throw new Error('fixture outage') })
  const errors = mock.method(console, 'error', () => {})
  try {
    assert.equal((await POST(request())).status, 202)
    assert.equal(callbacks.length, 1)
    await callbacks[0]()
    assert.equal(notification.mock.callCount(), 1)
    assert.equal(ingest.mock.callCount(), 1)
    assert.equal(reconcile.mock.callCount(), 0)
    assert.ok(errors.mock.calls.some(call => call.arguments[0] === 'GitHub CI result could not be recorded'))
    // Logged by name only: the error message never reaches the log.
    assert.ok(!errors.mock.calls.some(call => call.arguments.some(arg => String(arg).includes('fixture outage'))))
  } finally { errors.mock.restore() }
})
test('flag off (default): no CI table access or reconcile; suggestion ingest is unchanged', async () => {
  for (const value of [undefined, '0', 'true', '']) {
    if (value === undefined) delete process.env.MIKKA_CI_RESUME_ENABLED; else process.env.MIKKA_CI_RESUME_ENABLED = value
    callbacks.length = 0; notification.mock.resetCalls()
    assert.equal((await POST(request())).status, 202)
    await callbacks[0]()
    assert.equal(query.mock.callCount(), 0)
    assert.equal(reconcile.mock.callCount(), 0)
    assert.equal(notification.mock.callCount(), 1)
  }
})
