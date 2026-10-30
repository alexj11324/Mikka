import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import type { Pool } from 'pg'
import { ciFollowUp, reconcileCi } from './reconcile'
import { summarize } from './snapshot'
import { CiReadError } from './read'
import { publicationPrNumber } from './register'
import { CiContinuationUnsupported } from '@/lib/ci-continuation-contract'

const snapshot = { checks: [{ id: '1', name: 'build', status: 'completed', conclusion: 'success' }], statuses: [] }
const fingerprint = (() => { const r = summarize(snapshot); if (r.kind !== 'complete') throw Error('fixture'); return r.fingerprint })()
const base = { userId: 'owner', issueId: 'issue', remoteKey: 'v2/github.com/acme/repo', prNumber: 3, originRunId: 'run', scopeVersion: 1, head: 'a'.repeat(40), fingerprint, firstSeenAt: new Date(1), deliveredFingerprint: null as string | null, installationId: 4, repositoryId: 5, branch: 'mikka/test-1', pullRequest: { url: 'https://github.com/acme/repo/pull/3', state: 'open' }, content: {}, currentScopeVersion: 1, chainDepth: 0, botId: null, agentId: 'agent', generation: 0, watchId: 'watch', issueOwner: 'owner', issueScope: 'personal', pendingReason: null as string | null, pendingReasonSince: null as Date | null }
function harness(rows: typeof base[], notices = new Set<string>(), offline = false) {
  const events: string[] = []
  const pool = { async query(sql: string, args: unknown[] = []) {
    if (sql.startsWith('SELECT "userId" FROM issues')) { const row = rows[0]; return { rows: row ? [{ userId: row.issueOwner }] : [], rowCount: row ? 1 : 0 } }
    if (sql.includes('SELECT o.*,gi.')) { const row = rows[0]; return { rows: row ? [row] : [], rowCount: row ? 1 : 0 } }
    if (sql.includes('INSERT INTO coordinator_events')) { const key = String(args[8]); events.push(`read-notice:${String(args[9])}`); const fresh = !notices.has(key); notices.add(key); return { rows: fresh ? [{ id: 'notice' }] : [], rowCount: fresh ? 1 : 0 } }
    if (sql.includes('UPDATE github_ci_observations')) { events.push(args[4] === 'delivery_unavailable' ? 'backoff' : 'postpone'); return { rows: [], rowCount: 1 } }
    throw Error(`unexpected pool SQL: ${sql}`)
  }, async connect() { return { async query(sql: string, args: unknown[] = []) {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.startsWith('SET LOCAL') || sql.startsWith('SAVEPOINT') || sql.startsWith('RELEASE SAVEPOINT') || sql.startsWith('ROLLBACK TO SAVEPOINT')) { events.push(sql); return { rows: [], rowCount: 0 } }
    if (sql.includes('SELECT o."userId",o."issueId"')) { const row = rows[0]; return { rows: row ? [row] : [], rowCount: row ? 1 : 0 } }
    if (sql.includes('FROM issues WHERE id=$1 FOR UPDATE')) return { rows: [{ id: args[0], userId: rows[0]?.issueOwner ?? 'owner', scope: rows[0]?.issueScope ?? 'personal', scopeVersion: 1, content: {} }], rowCount: 1 }
    if (sql.includes('FOR UPDATE OF o SKIP LOCKED')) { const row = rows.shift(); return { rows: row ? [row] : [], rowCount: row ? 1 : 0 } }
    if (sql.includes('INSERT INTO coordinator_events')) { const provider = sql.includes('SELECT $8'); const key = String(args[provider ? 8 : 3]); events.push(`${provider ? 'read-notice' : 'notice'}:${String(args[provider ? 9 : 6])}`); if (!provider) events.push(`ids:${String(args[4])}:${String(args[5])}`); const fresh = !notices.has(key); notices.add(key); return { rows: fresh ? [{ id: 'notice' }] : [], rowCount: fresh ? 1 : 0 } }
    if (sql.startsWith('SELECT 1 FROM agent_runs')) return { rows: offline ? [{ offline: true }] : [], rowCount: offline ? 1 : 0 }
    if (sql.startsWith('SELECT "runId" FROM github_ci_commit_claims')) return { rows: [], rowCount: 0 }
    if (sql.includes('UPDATE github_ci_observations')) { events.push(sql.includes("'delivery_unavailable'") ? 'backoff' : `observation:${String(args[7])}`); return { rows: [], rowCount: 1 } }
    throw Error(`unexpected SQL: ${sql}`)
  }, release() {} } } } as unknown as Pool
  return { pool, events }
}

test('complete stable snapshot queues within transaction once; failure is backed off and does not starve another row', async () => {
  const { pool, events } = harness([{ ...base }, { ...base, issueId: 'other' }])
  const deliveries: string[] = []
  const result = await reconcileCi({ pool, deadline: Date.now() + 30_000, lockPolicy: (async () => ({})) as never, listAttempts: async () => [], retire: async () => 0, retireRevoked: async () => 0, retireRevokedSkill: async () => 0, now: () => 200_000, read: async () => ({ head: base.head, open: true, snapshot }), deliver: async (_tx, _userId, input) => { deliveries.push(input.issueId); if (input.issueId === 'issue') throw Error('failure') } })
  assert.deepEqual(deliveries, ['issue', 'other'])
  assert.equal(result.failed, 1)
  assert.equal(result.queued, 1)
  assert.ok(events.indexOf('ROLLBACK') < events.indexOf('backoff'))
  assert.ok(events.includes(`observation:${fingerprint}`))
})

test('pending never queues and changed head requires a new stability observation', async () => {
  const { pool, events } = harness([{ ...base }, { ...base, issueId: 'other' }])
  let calls = 0
  const result = await reconcileCi({ pool, deadline: Date.now() + 30_000, lockPolicy: (async () => ({})) as never, listAttempts: async () => [], retire: async () => 0, retireRevoked: async () => 0, retireRevokedSkill: async () => 0, now: () => 200_000, read: async () => ++calls === 1 ? { head: base.head, open: true, snapshot: { checks: [{ ...snapshot.checks[0], status: 'in_progress', conclusion: null }], statuses: [] } } : { head: 'b'.repeat(40), open: true, snapshot }, deliver: async () => { throw Error('must not queue') } })
  assert.equal(result.pending, 2)
  assert.equal(result.queued, 0)
  assert.equal(events.includes('ROLLBACK'), false)
})

test('bounded result contains parseable JSON despite hostile check names', () => {
  const message = ciFollowUp('a'.repeat(40), 'failure', Array(100).fill('\u0000"\\'.repeat(300)))
  assert.ok(message.length <= 4000)
  const data = JSON.parse(message.split('\n')[1])
  assert.ok(data.omittedChecks > 0)
  assert.ok(data.failedChecks.length > 0)
})

test('publication receipts cannot watch another repository or noncanonical URL', () => {
  assert.equal(publicationPrNumber(base.remoteKey, base.pullRequest.url), 3)
  for (const url of ['https://github.com/acme/other/pull/3', 'https://github.com/acme/repo/pull/3?x=1', 'https://evil.example/acme/repo/pull/3']) assert.equal(publicationPrNumber(base.remoteKey, url), null)
})


test('unsupported session durably alerts once while leaving the Agent result eligible for retry', async () => {
  const notices = new Set<string>()
  for (const reason of ['subscription', 'skill', 'session_missing', 'definition_missing'] as const) {
    const first = harness([{ ...base }], notices)
    const result = await reconcileCi({ pool: first.pool, deadline: Date.now() + 30_000, limit: 1, lockPolicy: (async () => ({})) as never, listAttempts: async () => [], retire: async () => 0, retireRevoked: async () => 0, retireRevokedSkill: async () => 0, now: () => 200_000, read: async () => ({ head: base.head, open: true, snapshot }), deliver: async () => { throw new CiContinuationUnsupported(reason) }, wake: async () => {} })
    assert.equal(result.queued, 0)
    assert.ok(first.events.includes('ROLLBACK TO SAVEPOINT ci_delivery'))
    assert.equal(result.escalated, reason === 'subscription' ? 1 : 0)
    assert.equal(result.failed, 0)
    assert.ok(first.events.includes('observation:null'))
    assert.ok(first.events.some(event => event.startsWith('notice:') && event.includes('success')))
  }
  const retry = harness([{ ...base }], notices)
  const outcome = await reconcileCi({ pool: retry.pool, deadline: Date.now() + 30_000, limit: 1, lockPolicy: (async () => ({})) as never, listAttempts: async () => [], retire: async () => 0, retireRevoked: async () => 0, retireRevokedSkill: async () => 0, now: () => 200_000, read: async () => ({ head: base.head, open: true, snapshot }), deliver: async () => {}, wake: async () => {} })
  assert.equal(outcome.queued, 1)
  assert.ok(retry.events.includes(`observation:${fingerprint}`))
})


test('unsupported session notice includes failed check names without marking automatic delivery', async () => {
  const failedSnapshot = { checks: [{ id: '9', name: 'integration', status: 'completed', conclusion: 'failure' }], statuses: [] }
  const summary = summarize(failedSnapshot)
  assert.equal(summary.kind, 'complete')
  if (summary.kind !== 'complete') return
  const h = harness([{ ...base, fingerprint: summary.fingerprint }])
  const result = await reconcileCi({ pool: h.pool, deadline: Date.now() + 30_000, limit: 1, lockPolicy: (async () => ({})) as never, listAttempts: async () => [], retire: async () => 0, retireRevoked: async () => 0, retireRevokedSkill: async () => 0, now: () => 200_000, read: async () => ({ head: base.head, open: true, snapshot: failedSnapshot }), deliver: async () => { throw new CiContinuationUnsupported('subscription') }, wake: async () => {} })
  assert.equal(result.queued, 0)
  assert.equal(result.escalated, 1)
  assert.ok(h.events.some(event => event.startsWith('notice:') && event.includes('failure') && event.includes('integration')))
  assert.ok(h.events.includes('observation:null'))
})


test('unverifiable provider state sends one durable notice and never claims a result', async () => {
  const notices = new Set<string>()
  let wakes = 0
  for (let i = 0; i < 2; i++) {
    const h = harness([{ ...base }], notices)
    const result = await reconcileCi({ pool: h.pool, deadline: Date.now() + 30_000, limit: 1, now: () => 200_000, read: async () => { throw new CiReadError('unsupported_required_workflow') }, wake: async () => { wakes++ } })
    assert.equal(result.queued, 0)
    assert.equal(result.failed, 1)
    assert.ok(h.events.includes('postpone'))
    assert.ok(h.events.some(event => event.startsWith('read-notice:') && event.includes('could not be verified')))
  }
  assert.equal(wakes, 1)
  assert.equal(notices.size, 1)
})


test('missing required check and ordinary pending do not wake', async () => {
  const notices = new Set<string>()
  const data = { ...base, pendingReason: 'required_check_missing', pendingReasonSince: new Date(1) }
  const missing = { ...snapshot, requiredChecks: [{ context: 'not-yet-registered', appId: null }] }
  const first = harness([data], notices)
  const options = { deadline: Date.now() + 30000, limit: 1, lockPolicy: (async () => ({})) as never, listAttempts: async () => [], retire: async () => 0, retireRevoked: async () => 0, retireRevokedSkill: async () => 0, now: () => 1_000_000, read: async () => ({ head: base.head, open: true, snapshot: missing }), wake: async () => {} }
  const result = await reconcileCi({ ...options, pool: first.pool })
  assert.equal(result.escalated, 0)
  assert.equal(first.events.some(event => event.startsWith('notice:')), false)
  const again = harness([data], notices)
  assert.equal((await reconcileCi({ ...options, pool: again.pool })).escalated, 0)
  const normal = harness([{ ...base }], notices)
  const noResult = { ...snapshot, checks: [{ ...snapshot.checks[0], status: 'in_progress', conclusion: null }] }
  assert.equal((await reconcileCi({ ...options, pool: normal.pool, read: async () => ({ head: base.head, open: true, snapshot: noResult }) })).escalated, 0)
})

test('shared issue notices cannot leak task, run or check details after membership revocation', async () => {
  const shared = { ...base, userId: 'member', issueOwner: 'owner', issueScope: 'workspace', chainDepth: 2 }
  const context = harness([shared])
  const result = await reconcileCi({ pool: context.pool, deadline: Date.now()+30000, limit: 1, lockPolicy: (async () => ({})) as never, listAttempts: async () => [], retire: async () => 0, retireRevoked: async () => 0, retireRevokedSkill: async () => 0, now: () => 200_000, read: async () => ({ head: base.head, open: true, snapshot }), acquireMembership: async () => ({ held: true, signal: undefined, check: async () => {}, close: async () => {} }), wake: async () => {} })
  assert.equal(result.escalated, 1)
  assert.ok(context.events.includes('ids:null:null'))
  assert.ok(context.events.some(event => event.includes('CI needs attention')))
  assert.equal(context.events.some(event => event.includes('build')), false)
})


test('transient provider failure only alerts after a bounded interval', async () => {
  const options = { deadline: Date.now()+30000, limit: 1, lockPolicy: (async () => ({})) as never, listAttempts: async () => [], retire: async () => 0, retireRevoked: async () => 0, retireRevokedSkill: async () => 0, now: () => 1_000_000, read: async () => { throw new CiReadError('unavailable') }, wake: async () => {} }
  const initial = harness([{ ...base }])
  await reconcileCi({ ...options, pool: initial.pool })
  assert.equal(initial.events.some(event => event.startsWith('read-notice:')), false)
  const prolonged = harness([{ ...base, pendingReason: 'unavailable', pendingReasonSince: new Date(1) }])
  await reconcileCi({ ...options, pool: prolonged.pool })
  assert.equal(prolonged.events.some(event => event.startsWith('read-notice:')), true)
})


test('an offline original BYOS device alerts once and keeps its queued result', async () => {
  const notices = new Set<string>()
  const alreadyDelivered = { ...base, deliveredFingerprint: fingerprint }
  const first = harness([alreadyDelivered], notices, true)
  const options = { deadline: Date.now()+30000, limit: 1, lockPolicy: (async () => ({})) as never, listAttempts: async () => [], retire: async () => 0, retireRevoked: async () => 0, retireRevokedSkill: async () => 0, now: () => 200_000, read: async () => ({ head: base.head, open: true, snapshot }), wake: async () => {} }
  const result = await reconcileCi({ ...options, pool: first.pool })
  assert.equal(result.escalated, 1)
  assert.equal(result.queued, 0)
  assert.ok(first.events.some(event => event.startsWith('notice:') && event.includes('offline')))
  const again = harness([alreadyDelivered], notices, true)
  assert.equal((await reconcileCi({ ...options, pool: again.pool })).escalated, 0)
})

test('revoked skill releases the delivered fingerprint for a later visible retry', async () => {
  const context = harness([{ ...base, deliveredFingerprint: fingerprint }])
  const result = await reconcileCi({ pool: context.pool, deadline: Date.now()+30000, limit: 1, lockPolicy: (async () => ({})) as never, listAttempts: async () => [], retire: async () => 0, retireRevoked: async () => 0, retireRevokedSkill: async () => 1, now: () => 200_000, read: async () => ({ head: base.head, open: true, snapshot }) })
  assert.equal(result.queued, 0)
  assert.ok(context.events.includes('observation:null'))
})
