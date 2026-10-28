import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'

let caller: { userId: string; scopeDeviceId?: string } | null = { userId: 'owner', scopeDeviceId: 'device' }
let persisted: { userId: string; issueId: string | null; publicationPending: boolean } | null = { userId: 'owner', issueId: 'issue', publicationPending: true }
let enqueueFails = false
const effects: string[] = []
const persist = mock.fn(async () => persisted)
const enqueue = mock.fn(async () => { if (enqueueFails) throw new Error('synthetic queue failure'); effects.push('enqueued') })
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports })
stub('../lib/device-link.ts', { authenticateDevice: async () => caller })
stub('../lib/run-publications.ts', { persistRunCompletion: persist })
stub('../lib/run-publication-workflow.ts', { startRunPublication: enqueue })
stub('../lib/coordinator/wake.ts', { wakeCoordinator: async () => { effects.push('wake') } })
stub('../lib/linear-sync/dispatch.ts', { dispatchLinearIssueSync: () => { effects.push('sync') } })
mock.module('next/server', { namedExports: { NextResponse: Response, after: (callback: () => Promise<void>) => callback() } })
let route: typeof import('../app/v1/runs/[runId]/complete/route')
before(async () => { route = await import('../app/v1/runs/[runId]/complete/route') })
beforeEach(() => { caller = { userId: 'owner', scopeDeviceId: 'device' }; persisted = { userId: 'owner', issueId: 'issue', publicationPending: true }; enqueueFails = false; effects.length = 0; persist.mock.resetCalls(); enqueue.mock.resetCalls() })
const runId = '10000000-0000-4000-8000-000000000001'
const completion = { stopReason: 'submitted', report: { summary: 'Done', filesChanged: ['a.ts'], verify: { status: 'passed' }, openQuestions: [], nextStep: null } }
const post = (body: unknown = completion) => route.POST(new Request(`https://example.test/mikka/v1/runs/${runId}/complete`, { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ runId }) })

test('completion route authenticates and validates before persisting', async () => {
  caller = null
  assert.equal((await post()).status, 401)
  assert.equal(persist.mock.callCount(), 0)
  caller = { userId: 'owner' }
  assert.equal((await post({ stopReason: 'submitted' })).status, 400)
  assert.equal(persist.mock.callCount(), 0)
  persisted = null
  assert.equal((await post()).status, 404)
  assert.equal(enqueue.mock.callCount(), 0)
})

test('completion acknowledges only after durable Workflow launch, forwarding the device scope', async () => {
  assert.equal((await post()).status, 204)
  assert.deepEqual(persist.mock.calls[0]?.arguments, ['owner', runId, completion, 'device'])
  assert.deepEqual(enqueue.mock.calls[0]?.arguments, [runId])
  assert.deepEqual(effects, ['enqueued'])
})

test('enqueue failure returns retryable 503; replay resumes the same stored completion', async () => {
  enqueueFails = true
  const failed = await post()
  assert.equal(failed.status, 503)
  assert.equal(failed.headers.get('Retry-After'), '15')
  enqueueFails = false
  assert.equal((await post()).status, 204)
  assert.equal(persist.mock.callCount(), 2)
  assert.deepEqual(effects, ['enqueued'])
})

test('non-publication completion wakes its existing chat and syncs the task', async () => {
  persisted = { userId: 'owner', issueId: 'issue', publicationPending: false }
  assert.equal((await post({ stopReason: 'cancelled' })).status, 204)
  assert.equal(enqueue.mock.callCount(), 0)
  assert.deepEqual(effects, ['sync', 'wake'])
})
