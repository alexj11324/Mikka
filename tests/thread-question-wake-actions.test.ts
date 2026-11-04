import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'
import { z } from 'zod'
import { ActionFailureError } from '../lib/action-error'
import { FactoryError } from '../lib/factory/contract'

// Exercise the normal server action, including its cookie/session/owner fence.
// Only persistence and provider boundaries are replaced; no database or VM runs.
const OWNER = 'fixture-owner', ISSUE = '41500000-0000-4000-8000-000000000001'
const ORIGIN = '41500000-0000-4000-8000-000000000002', CHILD = '41500000-0000-4000-8000-000000000003'
const GENERATION = '41500000-0000-4000-8000-000000000004'
const failure = { generation: GENERATION, error: 'Original task machine unavailable' }
let viewer = OWNER, requestHeaders = new Headers({ cookie: 'fixture-session' })
let currentStatus = 'queued', selectedRun = CHILD, hostError: Error | null = null
const wakes: unknown[][] = [], reads: unknown[][] = [], ordinary: unknown[][] = []
const pool = { query: async () => ({ rows: [], rowCount: 0 }) }
const fixtureRun = () => ({ id: selectedRun, issueId: ISSUE, userId: OWNER,
  status: selectedRun === ORIGIN ? 'stopped' : currentStatus, prompt: 'Fixture task', sessionId: null,
  deviceRepoId: null, report: null, error: null, createdAt: new Date(0), finishedAt: null,
  agentName: 'Fixture Bot', harness: 'codex', ownerName: null, stopRequestedAt: null, outcome: null })
function selection(rows: unknown[]) {
  const query = { from: () => query, innerJoin: () => query, leftJoin: () => query, where: () => query,
    orderBy: () => query, limit: () => query, then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject) }
  return query
}
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports })
let actions: typeof import('../app/actions/agents')
before(async () => {
  mock.module('next/headers', { namedExports: { headers: async () => requestHeaders } })
  stub('../lib/auth.ts', { auth: { api: { getSession: async () => ({ user: { id: viewer }, session: { id: 'fixture-human-session' } }) } } })
  stub('../lib/db/index.ts', { pool, db: { select: (fields: Record<string, unknown>) => selection('prompt' in fields ? [fixtureRun()] : []) } })
  stub('../lib/workspace-db.ts', { workspaceDb: { select: () => selection([]) }, workspacePool: pool })
  stub('../lib/deployment-switches.ts', { deploymentSwitch: () => true })
  stub('../lib/issue-access.ts', { requireIssueAccess: async () => ({ issue: { id: ISSUE, userId: OWNER }, user: { id: viewer } }) })
  stub('../lib/device-link.ts', { issueDeviceToken: () => assert.fail('no device token') })
  stub('../lib/device-presence.ts', { deviceOnlineStates: () => assert.fail('no device selection') })
  stub('../lib/device-removal.ts', { removeOwnedDevice: () => assert.fail('no device removal'), renameOwnedDevice: () => assert.fail('no rename') })
  stub('../lib/device-management.ts', { enqueueDeviceCommand: () => assert.fail('no device command') })
  stub('../lib/ssh.ts', { listSshHosts: () => [] })
  stub('../lib/coordinator/store.ts', { citationSources: () => ({}) })
  stub('../lib/agent-runs.ts', { requestRunStop: () => assert.fail('no run stop') })
  stub('../lib/thread-continue.ts', { sendThreadMessage: async (...args: unknown[]) => { ordinary.push(args); return { runId: CHILD, continued: false } } })
  stub('../lib/thread-chunks.ts', { readThreadChunks: async () => ({ chunks: [], cursor: null, append: false }), threadChunkCursor: z.unknown() })
  stub('../lib/issue-thread-questions.ts', { threadQuestionStates: async () => new Map([[ORIGIN, 'resuming']]) })
  stub('../lib/run-chain.ts', { listIssueRunChains: async () => [], readRunChain: async () => ({ rootRunId: ORIGIN, latestRunId: CHILD,
    attempts: [ORIGIN, CHILD].map((runId, i) => ({ runId, attempt: i + 1, status: i ? currentStatus : 'stopped', createdAt: new Date(i), finishedAt: null, stopRequestedAt: null })) }) })
  stub('../lib/run-quota-view.ts', { threadQuotaView: async () => null, threadModelFallbackState: async () => null })
  stub('../lib/factory/questions/wake.ts', {
    questionWakeFailure: async (...args: unknown[]) => { reads.push(args); return failure },
    retryQueuedQuestionWake: async (...args: unknown[]) => { wakes.push(args); if (hostError) throw hostError; return { runId: CHILD, continued: false } },
  })
  actions = await import('../app/actions/agents')
})
beforeEach(() => {
  viewer = OWNER; requestHeaders = new Headers({ cookie: 'fixture-session' }); currentStatus = 'queued'; selectedRun = CHILD; hostError = null
  wakes.length = reads.length = ordinary.length = 0
})
const retry = (extra: Record<string, unknown> = {}) => actions.sendIssueThreadMessage({ issueId: ISSUE, runId: CHILD,
  text: 'Retry', retryOriginalSession: true, questionWakeGeneration: GENERATION, ...extra } as Parameters<typeof actions.sendIssueThreadMessage>[0])
const refused = (code: string) => (error: unknown) => error instanceof ActionFailureError && error.code === code

test('Owner Retry sends the observed generation to the same-child wake service without replaying a message', async () => {
  assert.deepEqual(await retry(), { runId: CHILD, continued: false })
  assert.deepEqual(wakes, [[pool, { userId: OWNER, sessionId: 'fixture-human-session' }, CHILD, GENERATION]])
  assert.deepEqual(ordinary, [])
})

test('a wake generation cannot grant an ordinary Send or carry an unvalidated identifier', async () => {
  for (const extra of [{ retryOriginalSession: undefined }, { questionWakeGeneration: 'invalid' },
    { questionWakeGeneration: null }, { requestId: GENERATION }]) {
    await assert.rejects(retry(extra), refused('validationGeneric'))
  }
  assert.deepEqual(wakes, []); assert.deepEqual(ordinary, [])
})

test('foreign readers and bearer-only callers cannot request the original-machine wake', async () => {
  viewer = 'someone-else'
  await assert.rejects(retry(), refused('runNotFound'))
  viewer = OWNER; requestHeaders = new Headers({ authorization: 'Bearer fixture', cookie: 'fixture-session' })
  await assert.rejects(retry(), refused('authRequired'))
  requestHeaders = new Headers()
  await assert.rejects(retry(), refused('authRequired'))
  assert.deepEqual(wakes, []); assert.deepEqual(ordinary, [])
})

test('a stale generation refused by the host never falls through to ordinary dispatch or answer recovery', async () => {
  hostError = new FactoryError('factoryQuestionStale')
  await assert.rejects(retry(), refused('threadRecoveryUnavailable'))
  assert.equal(wakes.length, 1); assert.deepEqual(ordinary, [])
})

test('the owner detail reads only the current queued question child failure, preserving its queued state', async () => {
  selectedRun = ORIGIN
  const detail = await actions.getIssueThread(ISSUE, ORIGIN)
  assert.deepEqual(reads, [[pool, OWNER, CHILD]])
  assert.deepEqual(detail.thread.questionWake, failure)
  assert.equal(detail.thread.error, failure.error)
  assert.equal(detail.thread.continuation?.status, 'queued')
  assert.equal(detail.thread.question, 'resuming')
  assert.deepEqual(wakes, [])
})

test('claimed children and a foreign thread do not read or expose wake recovery receipts', async () => {
  selectedRun = ORIGIN; currentStatus = 'running'
  const detail = await actions.getIssueThread(ISSUE, ORIGIN)
  assert.equal(detail.thread.questionWake ?? null, null)
  assert.deepEqual(reads, [])
  viewer = 'someone-else'
  await assert.rejects(actions.getIssueThread(ISSUE, ORIGIN), refused('runNotFound'))
  assert.deepEqual(reads, [])
})
