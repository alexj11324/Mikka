import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'
import { ImprovementError } from '../lib/self-improvement/contract'
import { APP_BUILD } from '../lib/app-build'
import { createSecretMasker } from '../lib/secrets/mask'
import type { RunFailure } from '@mikka/protocol/run-failure'

let caller: { userId: string; scopeDeviceId?: string; scopeWorkspaceId?: string } | null = { userId: 'owner', scopeDeviceId: 'device' }
let persisted: { userId: string; issueId: string | null; publicationPending: boolean; review: { id: string; scopeVersion: number } | null } | null = { userId: 'owner', issueId: 'issue', publicationPending: true, review: null }
let enqueueFails = false
let replayStatus: string | null = null
let dispatchAllowed = true
let persistError: Error | null = null
const effects: string[] = []
const persist = mock.fn(async (..._arguments: unknown[]) => { if (persistError) throw persistError; return persisted })
const enqueue = mock.fn(async () => { if (enqueueFails) throw new Error('synthetic queue failure'); effects.push('enqueued') })
const dispatch = mock.fn(async (result: NonNullable<typeof persisted>, schedule: (id: string) => void) => {
  if (!dispatchAllowed || !result.review) return false
  schedule(result.review.id)
  return true
})
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports })
// Completion scheduling is tested here with a substituted caller; the real
// credential/transaction boundary is exercised by device-revocation.db.test.ts.
const maskScope = mock.fn(async (_scope: { ownerId: string; workspaceId?: string }) => createSecretMasker([{ name: 'OWNER', value: 'owner-secret-value' }, { name: 'WORKSPACE', value: 'workspace-secret-value' }]))
stub('../lib/secrets/runtime.ts', { secretMaskerFor: maskScope })
stub('../lib/device-route.ts', { withDeviceRoute: <T>(handler: T) => handler })
stub('../lib/device-link.ts', { authenticateDevice: async () => caller })
stub('../lib/run-publications.ts', { persistRunCompletion: persist })
stub('../lib/run-publication-workflow.ts', { startRunPublication: enqueue })
stub('../lib/run-completion.ts', { dispatchCompletedIssue: dispatch })
stub('../lib/captures/run-end.ts', { stopRecordingsAfter: () => { effects.push('captures') } })
const select = { from: () => select, innerJoin: () => select, where: () => select, limit: async () => replayStatus ? [{ status: replayStatus }] : [] }
stub('../lib/db/index.ts', { db: { select: () => select } })
stub('../lib/coordinator/wake.ts', { wakeCoordinator: async () => { effects.push('wake') } })
stub('../lib/run-outcome-judge.ts', { judgeRunOutcome: async () => { effects.push('outcome'); return null } })
stub('../lib/linear-sync/dispatch.ts', { dispatchLinearIssueSync: () => { effects.push('sync') } })
mock.module('next/server', { namedExports: { NextResponse: Response, after: (callback: () => Promise<void>) => callback() } })
let route: typeof import('../app/v1/runs/[runId]/complete/route')
before(async () => { route = await import('../app/v1/runs/[runId]/complete/route') })
beforeEach(() => { caller = { userId: 'owner', scopeDeviceId: 'device' }; persisted = { userId: 'owner', issueId: 'issue', publicationPending: true, review: null }; enqueueFails = false; replayStatus = null; dispatchAllowed = true; persistError = null; effects.length = 0; persist.mock.resetCalls(); enqueue.mock.resetCalls(); dispatch.mock.resetCalls() })
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
  assert.deepEqual(effects, ['captures', 'enqueued'])
})

test('enqueue failure returns retryable 503; replay resumes the same stored completion', async () => {
  enqueueFails = true
  const failed = await post()
  assert.equal(failed.status, 503)
  assert.equal(failed.headers.get('Retry-After'), '15')
  enqueueFails = false
  assert.equal((await post()).status, 204)
  assert.equal(persist.mock.callCount(), 2)
  assert.deepEqual(effects, ['captures', 'captures', 'enqueued'])
})

test('non-publication completion dispatches through its scope-generation guard', async () => {
  persisted = { userId: 'owner', issueId: 'issue', publicationPending: false, review: { id: 'issue', scopeVersion: 3 } }
  assert.equal((await post({ stopReason: 'cancelled' })).status, 204)
  assert.equal(enqueue.mock.callCount(), 0)
  assert.equal(dispatch.mock.calls[0]?.arguments[0], persisted)
  assert.deepEqual(effects, ['captures', 'sync', 'wake', 'outcome'])
})

test('retirement or a non-review completion wakes its chat without task dispatch', async () => {
  for (const review of [null, { id: 'issue', scopeVersion: 1 }]) {
    effects.length = 0
    persisted = { userId: 'owner', issueId: 'issue', publicationPending: false, review }
    dispatchAllowed = false
    assert.equal((await post({ stopReason: 'cancelled' })).status, 204)
    assert.deepEqual(effects, ['captures', 'wake', 'outcome'])
  }
})

test('malformed terminal replay acknowledges without another mutation or callback', async () => {
  replayStatus = 'succeeded'
  assert.equal((await post({ stopReason: 'submitted' })).status, 204)
  assert.equal(persist.mock.callCount(), 0)
  assert.equal(dispatch.mock.callCount(), 0)
  assert.deepEqual(effects, [])
  replayStatus = 'running'
  assert.equal((await post({ stopReason: 'submitted' })).status, 400)
})

test('invalid skill evidence returns a conflict before capture, publication or dispatch', async () => {
  persistError = new ImprovementError('sourceMismatch')
  const rejected = await post()
  assert.equal(rejected.status, 409)
  assert.deepEqual(await rejected.json(), { error: 'sourceMismatch' })
  assert.deepEqual(effects, [])
  assert.equal(enqueue.mock.callCount(), 0)
  assert.equal(dispatch.mock.callCount(), 0)
})


test('completion diagnostics are rebound and masked with the authenticated owner and workspace', async () => {
  caller = { userId: 'owner', scopeDeviceId: 'device', scopeWorkspaceId: 'workspace' }
  const failureDetails: RunFailure = { schemaVersion: 1, code: 'run_api_key_invalid', category: 'api_key', provider: 'openai', status: 401,
    providerMessage: 'Provider rejected owner-secret-value and workspace-secret-value', causes: [{ name: 'APIError' }],
    runId: 'injected-run', appVersion: 'injected-version', occurredAt: '2026-11-07T12:00:00.000Z' }
  assert.equal((await post({ stopReason: 'error', failureDetails })).status, 204)
  const stored = persist.mock.calls[0].arguments[2] as { failureDetails: RunFailure }
  assert.equal(stored.failureDetails.runId, runId)
  assert.equal(stored.failureDetails.appVersion, APP_BUILD || 'unknown')
  assert.match(stored.failureDetails.providerMessage!, /\[secret:OWNER\]/)
  assert.match(stored.failureDetails.providerMessage!, /\[secret:WORKSPACE\]/)
  assert.doesNotMatch(JSON.stringify(stored), /owner-secret-value|workspace-secret-value|injected-run|injected-version/)
  assert.deepEqual(maskScope.mock.calls.at(-1)?.arguments, [{ workspaceId: 'workspace', ownerId: 'owner' }])
})

test('successful and cancelled requests cannot store injected provider diagnostics', async () => {
  const failureDetails: RunFailure = { schemaVersion: 1, code: 'run_quota_exceeded', category: 'quota', causes: [],
    providerMessage: 'Conflicting failure', runId, appVersion: 'worker', occurredAt: '2026-11-07T12:00:00.000Z' }
  for (const stopReason of ['cancelled', 'submitted'] as const) {
    assert.equal((await post({ ...completion, stopReason, failureDetails })).status, 204)
    assert.equal(Object.hasOwn(persist.mock.calls.at(-1)!.arguments[2] as object, 'failureDetails'), false)
  }
})
