import assert from 'node:assert/strict'
import { afterEach, before, beforeEach, mock, test } from 'node:test'
import { z } from 'zod'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { workspaceMembers } from '../lib/db/workspace-schema'
import { ActionFailureError } from '../lib/action-error'
import { FactoryError } from '../lib/factory/contract'
import { threadQuestionView } from '../lib/issue-threads'

// Exercise the normal server action, including its cookie/session/owner fence.
// Only persistence and provider boundaries are replaced; no database or VM runs.
const OWNER = 'fixture-owner', ISSUE = '41500000-0000-4000-8000-000000000001'
const ORIGIN = '41500000-0000-4000-8000-000000000002', CHILD = '41500000-0000-4000-8000-000000000003'
const GENERATION = '41500000-0000-4000-8000-000000000004'
const WORKSPACE = '41500000-0000-4000-8000-000000000005'
const dialect = new PgDialect()
const failure = { generation: GENERATION, error: 'Original task machine unavailable' }
let viewer = OWNER, requestHeaders = new Headers({ cookie: 'fixture-session' })
let currentStatus = 'queued', selectedRun = CHILD, hostError: Error | null = null
let memberIds: string[] = [], factoryEnabled = true
let questionState: 'resuming' | 'waiting' | null = 'resuming', wakeFailure: typeof failure | null = failure
const wakes: unknown[][] = [], reads: unknown[][] = [], ordinary: unknown[][] = []
const revisionFailures: unknown[] = []
afterEach(() => assert.deepEqual(revisionFailures.splice(0), [], 'Live revision SQL cannot fail silently in the wake fixture'))
const pool = { query: async () => ({ rows: [], rowCount: 0 }) }
const fixtureRun = () => ({ id: selectedRun, issueId: ISSUE, userId: OWNER, workspaceId: WORKSPACE,
  status: selectedRun === ORIGIN ? 'stopped' : currentStatus, prompt: 'Fixture task', sessionId: null,
  deviceRepoId: null, report: null, error: null, createdAt: new Date(0), finishedAt: null,
  agentName: 'Fixture Bot', harness: 'codex', ownerName: null, stopRequestedAt: null, outcome: null })
const fixtureChain = () => ({ rootRunId: ORIGIN, latestRunId: CHILD,
  attempts: [ORIGIN, CHILD].map((runId, i) => ({ runId, attempt: i + 1, status: i ? currentStatus : 'stopped', createdAt: new Date(i), finishedAt: null, stopRequestedAt: null })) })
function selection(rows: unknown[]) {
  const query = Promise.resolve(rows)
  Object.assign(query, { from: () => query, innerJoin: () => query, leftJoin: () => query, where: () => query,
    orderBy: () => query, limit: () => query })
  return query
}
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports })
let actions: typeof import('../app/actions/agents')
before(async () => {
  mock.module('next/headers', { namedExports: { headers: async () => requestHeaders } })
  stub('../lib/auth.ts', { auth: { api: { getSession: async () => ({ user: { id: viewer }, session: { id: 'fixture-human-session' } }) } } })
  stub('../lib/db/index.ts', { pool, db: { select: (fields: Record<string, unknown>) => {
    if ('prompt' in fields) return selection([fixtureRun()])
    if ('summary' in fields) {
      const { prompt, report: _report, error: _error, ...row } = fixtureRun()
      return selection([{ ...row, name: prompt, summary: null }])
    }
    return selection('id' in fields ? memberIds.map(id => ({ id })) : [])
  } } })
  stub('../lib/db/request-scope.ts', {
    inDatabaseTransaction: () => false,
    withoutDatabaseClient: (work: () => unknown) => work(),
    pool: { async query(sql: string, params: [string[], string[]]) {
      try {
        assert.equal(sql.replace(/\s+/g, ' ').trim(), 'SELECT r.kind, r.id::text AS id, r.revision FROM live_revisions r JOIN unnest($1::text[], $2::uuid[]) AS t(k, i) ON r.kind = t.k AND r.id = t.i')
        assert.deepEqual(params[0], ['run', 'thread'])
        assert.equal(params[1].length, 2); assert.equal(params[1][0], params[1][1])
        return { rows: params[0].flatMap((kind, index) => [ORIGIN, CHILD].includes(params[1][index])
          ? [{ kind, id: params[1][index], revision: '7' }] : []) }
      } catch (error) { revisionFailures.push(error); throw error }
    } },
  })
  stub('../lib/workspace-db.ts', { workspaceDb: { select: () => ({ from: (table: unknown) => {
    assert.equal(table, workspaceMembers)
    return { where: (condition: SQL) => {
      const query = dialect.sqlToQuery(condition)
      assert.ok(query.params.includes(WORKSPACE)); assert.ok(query.params.includes('active'))
      return selection([OWNER, ...memberIds].map(id => ({ id })))
    } }
  } }) }, workspacePool: pool })
  stub('../lib/workspace-access.ts', { loadWorkspaceContext: () => assert.fail('workspace selection outside task-bound wake fixture') })
  stub('../lib/deployment-switches.ts', { deploymentSwitch: () => factoryEnabled })
  stub('../lib/issue-access.ts', { requireIssueAccess: async () => ({ issue: { id: ISSUE, userId: OWNER, workspaceId: WORKSPACE }, user: { id: viewer } }) })
  stub('../lib/device-link.ts', { issueDeviceToken: () => assert.fail('no device token') })
  stub('../lib/device-presence.ts', { deviceOnlineStates: () => assert.fail('no device selection') })
  stub('../lib/device-removal.ts', {
    removeOwnedDevice: () => assert.fail('no device removal'),
    renameOwnedDevice: () => assert.fail('no rename'),
    setOwnedDeviceEnabled: () => assert.fail('no device scheduling change'),
  })
  stub('../lib/device-management.ts', { enqueueDeviceCommand: () => assert.fail('no device command') })
  stub('../lib/ssh.ts', { listSshHosts: () => [] })
  stub('../lib/coordinator/store.ts', { citationSources: () => ({}) })
  stub('../lib/agent-runs.ts', { requestRunStop: () => assert.fail('no run stop') })
  stub('../lib/thread-continue.ts', { sendThreadMessage: async (...args: unknown[]) => { ordinary.push(args); return { runId: CHILD, continued: false } } })
  stub('../lib/thread-chunks.ts', { readThreadChunks: async () => ({ chunks: [], cursor: null, append: false }), threadChunkCursor: z.unknown() })
  const questionStates = () => questionState ? new Map([[ORIGIN, questionState]]) : new Map()
  stub('../lib/issue-thread-questions.ts', {
    threadQuestionStates: async () => questionStates(),
    // #1236: the thread actions read the state together with its next answer deadline.
    readThreadQuestionState: async () => ({ states: questionStates(), deadline: null }),
  })
  stub('../lib/run-chain.ts', { listIssueRunChains: async () => [fixtureChain()], readRunChain: async () => fixtureChain(), readRunChainCheckpoint: () => assert.fail('checkpoint reads outside wake fixture') })
  stub('../lib/run-quota-view.ts', { threadQuotaView: async () => null, threadModelFallbackState: async () => null })
  stub('../lib/factory/questions/wake.ts', {
    questionWakeFailure: async (...args: unknown[]) => { reads.push(args); return wakeFailure },
    retryQueuedQuestionWake: async (...args: unknown[]) => { wakes.push(args); if (hostError) throw hostError; return { runId: CHILD, continued: false } },
  })
  actions = await import('../app/actions/agents')
})
beforeEach(() => {
  viewer = OWNER; requestHeaders = new Headers({ cookie: 'fixture-session' }); currentStatus = 'queued'; selectedRun = CHILD; hostError = null
  memberIds = []; factoryEnabled = true; questionState = 'resuming'; wakeFailure = failure
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
  assert.deepEqual(detail.live?.revisions, { [`run:${ORIGIN}`]: 7, [`thread:${ORIGIN}`]: 7 })
  assert.deepEqual(reads, [[pool, OWNER, CHILD]])
  assert.deepEqual(detail.thread.questionWake, failure)
  assert.equal(detail.thread.retryAvailable, true, 'the host-confirmed queued wake keeps its explicit Retry')
  assert.equal(detail.thread.replyAvailable, true, 'the existing resuming state, not ordinary continuation, controls Send')
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

test('the task list and open detail show the same failed wake for the same queued child', async () => {
  selectedRun = ORIGIN
  const [listed] = await actions.listIssueThreads(ISSUE)
  assert.equal(threadQuestionView(listed).status, 'failed', 'the list must not say Running beside a blocked detail')
  const detail = await actions.getIssueThread(ISSUE, ORIGIN)
  assert.deepEqual(threadQuestionView(listed), threadQuestionView(detail.thread))
  assert.deepEqual(listed.questionWake, failure)
  assert.equal(listed.question, 'resuming')
  assert.equal(listed.latestRunId, CHILD)
  assert.equal(listed.continuation?.status, 'queued')
  assert.equal(listed.attempts.at(-1)?.status, 'queued', 'the view does not rewrite the run')
  assert.deepEqual(reads, [[pool, OWNER, CHILD], [pool, OWNER, CHILD]])
  assert.deepEqual(wakes, []); assert.deepEqual(ordinary, [])
})

test('an owner list keeps a queued question running when the host has no failed wake', async () => {
  selectedRun = ORIGIN; wakeFailure = null
  const [listed] = await actions.listIssueThreads(ISSUE)
  assert.equal(threadQuestionView(listed).status, 'running')
  assert.equal(listed.questionWake ?? null, null)
  assert.deepEqual(reads, [[pool, OWNER, CHILD]])
})

test('the list never reads a wake receipt for waiting, ordinary, claimed or disabled question flows', async () => {
  selectedRun = ORIGIN
  for (const state of ['waiting', null] as const) {
    questionState = state
    const [listed] = await actions.listIssueThreads(ISSUE)
    assert.equal(listed.questionWake ?? null, null)
    assert.deepEqual(reads, [])
  }
  questionState = 'resuming'; currentStatus = 'running'
  assert.equal((await actions.listIssueThreads(ISSUE))[0].questionWake ?? null, null)
  assert.deepEqual(reads, [])
  currentStatus = 'queued'; factoryEnabled = false
  assert.equal((await actions.listIssueThreads(ISSUE))[0].questionWake ?? null, null)
  assert.deepEqual(reads, [])
})

test('a collaborator may see the list row without receiving the owner wake receipt', async () => {
  selectedRun = ORIGIN; viewer = 'collaborator'; memberIds = [viewer]
  const [listed] = await actions.listIssueThreads(ISSUE)
  assert.equal(listed.ownedByCurrentUser, false)
  assert.equal(listed.detail, null)
  assert.equal(listed.question, null)
  assert.equal(listed.questionWake ?? null, null)
  assert.deepEqual(reads, []); assert.deepEqual(wakes, [])
})
