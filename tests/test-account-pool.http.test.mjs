import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, stat, lstat, readFile, writeFile, chmod } from 'node:fs/promises'
import { before, after, test } from 'node:test'
import { Pool } from 'pg'
import { loadEnvironment, assertDeploymentIdentity } from '../scripts/test-accounts/environment.mjs'
import { TestAccountPool } from '../scripts/test-accounts/pool.mjs'
import { acquireTestAccounts } from '../scripts/test-accounts/session.mjs'
// Direct node --test invocation must not bypass the shared runner's hold.
const RETAIN_SAFE_HTTP_TESTS_AVAILABLE = false
if (!RETAIN_SAFE_HTTP_TESTS_AVAILABLE) throw new Error('HTTP_ACCEPTANCE_RETENTION_BLOCKED')

// Real Next HTTP routes, Better Auth sessions and PostgreSQL. There is no auth
// mock, cookie minting, provider API, model invocation or manually inserted user.
let environment
let database
let pool
const active = new Set()
const suiteId = `http-accounts-${randomUUID()}`
const startedAt = new Date().toISOString()
const acquisitions = []
const scenarios = []
const options = workerId => ({ environment, database, runId: `${suiteId}-${workerId}`, workerId, requestId: randomUUID() })
const acceptance = (name, run) => { scenarios.push(name); test(name, run) }

before(async () => {
  environment = await loadEnvironment()
  await assertDeploymentIdentity(environment)
  database = new Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 4, connectionTimeoutMillis: 5000 })
  pool = new TestAccountPool(database, environment)
  // The process suite intentionally quarantines five pairs. This is explicit
  // new capacity; it never recycles an account with an unproved prior executor.
  // One additional pair covers an independent state-file cleanup failure;
  // both failed executors stay quarantined without consuming browser capacity.
  await pool.prepare({ pairs: 8 })
})

after(async () => {
  try {
    for (const scope of active) await scope.release({ outcome: 'dirty' }).catch(() => {})
    const inspection = pool ? await pool.inspect() : null
    const ids = new Set(acquisitions.map(item => item.leaseId))
    const pairIds = new Set(acquisitions.map(item => item.pairId))
    await mkdir('.cache/e2e', { recursive: true, mode: 0o700 })
    await writeFile('.cache/e2e/account-http-evidence.json', `${JSON.stringify({
      version: 1, suiteId, startedAt, finishedAt: new Date().toISOString(),
      environment: environment ? { id: environment.id, kind: environment.kind, origin: environment.origin, deploymentSha: environment.deploymentSha } : null,
      scenarios, acquisitions,
      leases: inspection?.leases.filter(item => ids.has(item.id)) ?? [],
      pairs: inspection?.pairs.filter(item => pairIds.has(item.id)) ?? [],
      resultSource: 'Separate HTTP runner TAP totals; this file records identity and lifecycle evidence only',
    }, null, 2)}\n`, { mode: 0o600 })
  } finally { await database?.end() }
})

async function acquire(workerId, configuration = options(workerId)) {
  const scope = await acquireTestAccounts(configuration)
  active.add(scope)
  acquisitions.push({
    runId: scope.lease.runId, workerId: scope.lease.workerId, leaseId: scope.lease.id,
    generation: scope.lease.generation, pairId: scope.lease.pairId,
    owner: { userId: scope.owner.userId, slotId: scope.owner.slotId, namespace: scope.owner.namespace },
    peer: { userId: scope.peer.userId, slotId: scope.peer.slotId, namespace: scope.peer.namespace },
  })
  return scope
}
async function release(scope, outcome = 'clean') {
  const result = await scope.release({ outcome })
  active.delete(scope)
  for (const account of [scope.owner, scope.peer]) {
    const info = await lstat(account.storageStatePath)
    assert.ok(info.isFile() && !info.isSymbolicLink())
    assert.equal(info.mode & 0o777, 0o600)
    if (process.getuid) assert.equal(info.uid, process.getuid())
    let retained
    try { retained = JSON.parse(await readFile(account.storageStatePath, 'utf8')) }
    catch { throw new Error('RETAINED_STATE_UNREADABLE') }
    assert.ok(Array.isArray(retained.cookies) && Array.isArray(retained.origins))
  }
  await assert.rejects(scope.owner.request('/api/auth/get-session'), { code: 'LEASE_CLOSED' })
  return result
}
async function noSession(path, init = {}) {
  return fetch(`${environment.origin}${environment.basePath}${path}`, {
    ...init, redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { origin: environment.origin, ...init.headers },
  })
}
const post = messageId => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messageId }) })

async function authenticationSnapshot() {
  const result = {}
  for (const name of ['user', 'account', 'session']) {
    const rows = await database.query(`select row_to_json(t)::text as value from public."${name}" t`)
    result[name] = rows.rows.map(row => createHash('sha256').update(row.value).digest('hex')).sort()
  }
  return result
}

acceptance('actual deployment inspection and dry-run leave auth rows unchanged and reject mismatched bindings', async () => {
  const before = await authenticationSnapshot()
  await assertDeploymentIdentity(environment)
  await pool.inspect()
  await pool.cleanupPlan({ runId: `${suiteId}-readonly` })
  for (const mismatch of [
    { ...environment, deploymentSha: '0'.repeat(40) },
    { ...environment, origin: 'https://production.example.test' },
    { ...environment, database: { ...environment.database, name: 'different_e2e' } },
  ]) await assert.rejects(acquireTestAccounts({ ...options('mismatch'), environment: mismatch }))
  assert.deepEqual(await authenticationSnapshot(), before)
})

acceptance('repeated and concurrent authenticated acquire retries cannot disrupt the attached executor', async () => {
  const configuration = options('attached-executor')
  const scope = await acquire('attached-executor', configuration)
  try {
    const before = await authenticationSnapshot()
    await assert.rejects(acquireTestAccounts(configuration), { code: 'LEASE_ALREADY_ATTACHED' })
    const independent = { ...configuration }
    delete independent.database
    await Promise.all([
      assert.rejects(acquireTestAccounts(configuration), { code: 'LEASE_ALREADY_ATTACHED' }),
      assert.rejects(acquireTestAccounts(independent), { code: 'LEASE_ALREADY_ATTACHED' }),
    ])
    assert.deepEqual(await authenticationSnapshot(), before, 'Retries must not create users, log in, revoke sessions or alter credentials')
    for (const account of [scope.owner, scope.peer]) {
      const response = await account.request('/api/auth/get-session')
      assert.equal(response.status, 200)
      assert.equal((await response.json()).user.id, account.userId)
    }
    assert.equal((await release(scope)).state, 'released')
    const completed = await authenticationSnapshot()
    await assert.rejects(acquireTestAccounts(configuration), { code: 'LEASE_ALREADY_COMPLETED' })
    assert.deepEqual(await authenticationSnapshot(), completed)
  } finally { if (active.has(scope)) await release(scope, 'dirty') }
})

acceptance('prepare/acquire/real owner-peer HTTP/clean release safely reuses the same two identities', async () => {
  const first = await acquire('lifecycle-first')
  const other = await acquire('unrelated-active')
  const botId = randomUUID()
  const messageId = randomUUID()
  const agentId = randomUUID()
  const runRecordId = randomUUID()
  const chunkId = randomUUID()
  const conversationId = `bot:${botId}`
  const path = `/api/conversations/${encodeURIComponent(conversationId)}/read`
  const resources = [
    { type: 'bots', id: botId, ownerId: first.owner.userId },
    { type: 'coordinator_messages', id: messageId, ownerId: first.owner.userId },
    { type: 'conversation_reads', id: conversationId, ownerId: first.owner.userId },
    { type: 'agents', id: agentId, ownerId: first.owner.userId },
    { type: 'agent_runs', id: runRecordId, ownerId: first.owner.userId },
    { type: 'run_chunks', id: chunkId, ownerId: first.owner.userId },
  ]
  let fixturesClean = false
  try {
    assert.notEqual(first.owner.userId, first.peer.userId)
    assert.notEqual(first.owner.namespace, first.peer.namespace)
    assert.equal(new Set([first.owner.userId, first.peer.userId, other.owner.userId, other.peer.userId]).size, 4)
    for (const account of [first.owner, first.peer]) {
      const response = await account.request('/api/auth/get-session')
      assert.equal(response.status, 200)
      const session = await response.json()
      assert.equal(session.user.id, account.userId)
      assert.equal((await stat(account.storageStatePath)).mode & 0o077, 0)
    }
    const workspaceResponse = await first.owner.request('/api/workspace')
    assert.equal(workspaceResponse.status, 200)
    const { workspace } = await workspaceResponse.json()
    assert.ok(workspace?.id)
    for (const resource of resources) await first.recordResource(resource)
    await first.assertActive()
    await database.query('insert into bots(id,"ownerId","workspaceId",name) values($1,$2,$3,$4)', [botId, first.owner.userId, workspace.id, first.owner.namespace])
    await database.query('insert into coordinator_messages(id,"userId","botId",position,message) values($1,$2,$3,1,$4)', [messageId, first.owner.userId, botId, JSON.stringify({ role: 'assistant', content: `Synthetic ${first.owner.namespace}` })])
    await assert.rejects(other.recordResource({ type: 'bots', id: botId, ownerId: other.owner.userId }))

    // A run chunk has no userId. The clean-account fingerprint must follow its
    // run's ownership instead of missing indirect fixture mutations.
    await database.query('insert into agents(id,"userId",harness,name) values($1,$2,\'codex\',$3)', [agentId, first.owner.userId, first.owner.namespace])
    await database.query('insert into agent_runs(id,"userId","agentId",status) values($1,$2,$3,\'succeeded\')', [runRecordId, first.owner.userId, agentId])
    const fingerprint = () => pool.transaction(client => pool.fingerprint(client, first.owner.userId), { readOnly: true })
    const beforeChunk = await fingerprint()
    await database.query('insert into run_chunks(id,"runId",seq,chunk) values($1,$2,1,$3)', [chunkId, runRecordId, JSON.stringify({ type: 'text-delta', delta: 'synthetic fixture' })])
    assert.notEqual(await fingerprint(), beforeChunk)
    await database.query('delete from run_chunks where id=$1 and "runId"=$2 and exists(select 1 from agent_runs where id=$2 and "userId"=$3)', [chunkId, runRecordId, first.owner.userId])
    assert.equal(await fingerprint(), beforeChunk)
    await first.markResourceCleaned({ type: 'run_chunks', id: chunkId })

    assert.equal((await noSession(path)).status, 401)
    assert.equal((await noSession(path, post(messageId))).status, 401)
    assert.equal((await first.peer.request(path)).status, 404)
    assert.equal((await first.peer.request(path, post(messageId))).status, 404)
    const own = await first.owner.request(path)
    assert.equal(own.status, 200)
    assert.equal((await own.json()).unreadCount, 1)
    assert.equal((await first.owner.request(path, post(messageId))).status, 200)
    const saved = await database.query('select "lastReadMessageId" from conversation_reads where "userId"=$1 and "conversationId"=$2', [first.owner.userId, conversationId])
    assert.equal(saved.rows[0].lastReadMessageId, messageId)
    assert.equal((await database.query('select 1 from conversation_reads where "userId"=$1 and "conversationId"=$2', [first.peer.userId, conversationId])).rowCount, 0)

    const cleanup = await pool.cleanupPlan({ runId: first.lease.runId })
    assert.equal(cleanup.dryRun, true)
    assert.equal(cleanup.deletesExecuted, 0)
    assert.ok(cleanup.resources.some(item => item.id === botId && item.reason === 'ACTIVE_LEASE_PROTECTED'))
    assert.ok(cleanup.resources.every(item => item.runId === first.lease.runId))
    assert.equal(cleanup.resources.some(item => item.ownerId === other.owner.userId || item.ownerId === other.peer.userId), false)
    await assert.rejects(first.markResourceCleaned({ type: 'bots', id: botId }), { code: 'RESOURCE_STILL_PRESENT' })

    // Exact owned fixture identifiers, with owner predicates on every DELETE.
    // No users, old fixtures, shared data or another run's resources are removed.
    await first.assertActive()
    await database.query('delete from conversation_reads where "userId"=$1 and "conversationId"=$2', [first.owner.userId, conversationId])
    await database.query('delete from coordinator_messages where id=$1 and "userId"=$2 and "botId"=$3', [messageId, first.owner.userId, botId])
    await database.query('delete from bots where id=$1 and "ownerId"=$2', [botId, first.owner.userId])
    await database.query('delete from agent_runs where id=$1 and "userId"=$2 and "agentId"=$3', [runRecordId, first.owner.userId, agentId])
    await database.query('delete from agents where id=$1 and "userId"=$2', [agentId, first.owner.userId])
    for (const resource of resources) await first.markResourceCleaned(resource)
    fixturesClean = true

    const ids = [first.owner.userId, first.peer.userId]
    const before = (await database.query('select count(*)::int as n from public."user"')).rows[0].n
    assert.equal((await release(first)).state, 'released')
    assert.equal((await database.query('select count(*)::int as n from public.session where "userId"=any($1::text[]) and "expiresAt">clock_timestamp()', [ids])).rows[0].n, 0)
    assert.ok((await database.query('select count(*)::int as n from public.session where "userId"=any($1::text[])', [ids])).rows[0].n >= ids.length, 'released session evidence is retained')
    assert.equal((await other.owner.request('/api/auth/get-session')).status, 200)

    const next = await acquire('lifecycle-next')
    try {
      assert.deepEqual([next.owner.userId, next.peer.userId], ids)
      assert.notEqual(next.lease.id, first.lease.id)
      assert.ok(next.lease.generation > first.lease.generation)
      assert.notEqual(next.owner.namespace, first.owner.namespace)
      assert.equal((await database.query('select count(*)::int as n from public."user"')).rows[0].n, before)
      assert.equal((await next.owner.request('/api/conversations/coordinator/read')).status, 200)
      const previousPlan = await pool.cleanupPlan({ runId: first.lease.runId })
      // A reused identity keeps its original provisioning provenance. The
      // preceding attached-executor case may already have created this user.
      const provenance = await database.query(`select l.run_id as "runId"
        from mikka_test_accounts.accounts a join mikka_test_accounts.leases l on l.id=a.provision_lease_id
        where a.slot_id=$1 and a.user_id=$2 and l.environment_id=$3`, [next.owner.slotId, next.owner.userId, environment.id])
      assert.equal(provenance.rowCount, 1)
      const provisioningRunId = provenance.rows[0].runId
      assert.equal(previousPlan.resources.some(item => item.type === 'user' && item.id === next.owner.userId), provisioningRunId === first.lease.runId)
      const provisioningPlan = await pool.cleanupPlan({ runId: provisioningRunId })
      assert.ok(provisioningPlan.resources.some(item => item.type === 'user' && item.id === next.owner.userId && item.reason === 'ACTIVE_LEASE_PROTECTED'))
      await assert.rejects(first.owner.request('/api/conversations/coordinator/read'))
      await assert.rejects(pool.revokeSessions(first.lease))
      assert.equal((await next.owner.request('/api/auth/get-session')).status, 200)
      assert.equal((await release(next)).state, 'released')
    } finally { if (active.has(next)) await release(next, 'dirty') }
  } finally {
    if (active.has(first)) await release(first, fixturesClean ? 'clean' : 'dirty')
    if (active.has(other)) await release(other)
  }
})

// Unrun: the shared runner and acquisition remain blocked pending retention review.
acceptance('retained session revocation preserves rows and denies old bearer credentials', async () => {
  const scope = await acquire('retained-auth-lifecycle')
  try {
    const path = '/api/conversations/coordinator/read'
    assert.equal((await scope.owner.request(path)).status, 200)
    assert.equal((await scope.peer.request(path)).status, 200)
    const tracked = (await database.query("select id,owner_id from mikka_test_accounts.resources where lease_id=$1 and type='session' and state='created' order by id", [scope.lease.id])).rows
    assert.equal(tracked.length, 2)
    const ids = tracked.map(row => row.id)
    const before = (await database.query('select id,token,"userId" from public.session where id=any($1::text[]) order by id', [ids])).rows
    assert.equal(before.length, 2)
    assert.equal((await scope.pool.revokeSessions(scope.lease)).revoked, 2)
    const after = (await database.query('select id,token,"userId",("expiresAt"<clock_timestamp()) as expired from public.session where id=any($1::text[]) order by id', [ids])).rows
    assert.equal(after.length, before.length, 'revocation retains every tracked session row')
    assert.deepEqual(after.map(row => [row.id, row.userId]), before.map(row => [row.id, row.userId]))
    assert.ok(after.every((row, index) => row.expired && row.token !== before[index].token), 'tokens rotate and expire without exposing values')
    assert.equal((await scope.owner.request(path)).status, 401)
    assert.equal((await scope.peer.request(path)).status, 401)
    assert.equal((await database.query('select count(*)::int as count from public.session where id=any($1::text[])', [ids])).rows[0].count, 2, 'rejected old cookies must not delete retained rows')
    assert.equal((await release(scope)).state, 'released')
  } finally { if (active.has(scope)) await release(scope, 'dirty') }
})

acceptance('actual expired session, sign-out and revocation deny subsequent HTTP reads', async () => {
  const scope = await acquire('auth-lifecycle')
  try {
    const path = '/api/conversations/coordinator/read'
    assert.equal((await scope.owner.request(path)).status, 200)
    assert.equal((await scope.peer.request(path)).status, 200)
    await scope.assertActive()
    await database.query('update public.session set "expiresAt"=clock_timestamp()-interval \'1 second\' where "userId"=$1', [scope.owner.userId])
    assert.equal((await scope.owner.request(path)).status, 401)
    assert.equal((await scope.peer.request(path)).status, 200)
    assert.equal((await scope.peer.request('/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 200)
    assert.equal((await scope.peer.request(path)).status, 401)
    assert.equal((await release(scope)).state, 'released')
  } finally { if (active.has(scope)) await release(scope, 'dirty') }

  const next = await acquire('auth-relogin')
  try {
    assert.equal((await next.owner.request('/api/conversations/coordinator/read')).status, 200)
    await next.pool.revokeSessions(next.lease)
    assert.equal((await next.owner.request('/api/conversations/coordinator/read')).status, 401)
    assert.equal((await next.peer.request('/api/conversations/coordinator/read')).status, 401)
    assert.equal((await release(next)).state, 'released')
  } finally { if (active.has(next)) await release(next, 'dirty') }
})

acceptance('origin-bound clients reject a different actual server before sending cookies or writes', async () => {
  let requests = 0
  const foreign = createServer((_request, response) => { requests++; response.end('unexpected') })
  foreign.listen(0, '127.0.0.1')
  await once(foreign, 'listening')
  let scope
  try {
    scope = await acquire('origin-bound')
    const target = `http://127.0.0.1:${foreign.address().port}/mikka/api/auth/get-session`
    await assert.rejects(scope.owner.request(target))
    assert.equal(requests, 0)
    assert.equal((await scope.owner.request('/api/conversations/coordinator/read')).status, 200)
    assert.equal((await release(scope)).state, 'released')
  } finally {
    if (scope && active.has(scope)) await release(scope, 'dirty')
    await new Promise(resolve => foreign.close(resolve))
  }
})

acceptance('cancelling an outstanding request closes the client immediately and quarantines its pair', async () => {
  const scope = await acquire('cancel-inflight')
  try {
    // request() registers its pending operation before its first database await.
    // The immediate release must close the gate even before that await settles.
    const pending = scope.owner.request('/api/conversations/coordinator/read')
    const releasing = scope.release({ outcome: 'clean' })
    const outcomes = Promise.allSettled([pending, releasing])
    await assert.rejects(scope.peer.request('/api/conversations/coordinator/read'), { code: 'LEASE_CLOSED' })
    const results = await outcomes
    assert.equal(results[0].status, 'rejected')
    assert.equal(results[1].status, 'rejected')
    assert.equal(results[1].reason.code, 'ACCOUNT_DIRTY')
    active.delete(scope)
    const inspected = await pool.inspect()
    assert.equal(inspected.pairs.find(item => item.id === scope.lease.pairId).state, 'quarantined')
    assert.equal((await database.query('select count(*)::int as n from public.session where "userId"=any($1::text[]) and "expiresAt">clock_timestamp()', [[scope.owner.userId, scope.peer.userId]])).rows[0].n, 0)
    const replacement = await acquire('after-cancel')
    try {
      assert.notEqual(replacement.lease.pairId, scope.lease.pairId)
      assert.notEqual(replacement.owner.userId, scope.owner.userId)
      assert.equal((await replacement.owner.request('/api/conversations/coordinator/read')).status, 200)
      await release(replacement)
    } finally { if (active.has(replacement)) await release(replacement, 'dirty') }
  } finally { if (active.has(scope)) { await release(scope, 'dirty').catch(() => {}); active.delete(scope) } }
})

acceptance('unsafe retained state revokes sessions and quarantines instead of reporting clean reuse', async () => {
  const scope = await acquire('state-cleanup-failure')
  const ownedPath = scope.owner.storageStatePath
  try {
    // Retain the state file but make its permissions unsafe, including for uid0.
    await chmod(ownedPath, 0o644)
    await assert.rejects(scope.release({ outcome: 'clean' }), { code: 'SESSION_STATE_RETENTION_FAILED' })
    active.delete(scope)
    const inspection = await pool.inspect()
    assert.equal(inspection.pairs.find(pair => pair.id === scope.lease.pairId).state, 'quarantined')
    assert.equal((await database.query('select count(*)::int as n from public.session where "userId"=any($1::text[]) and "expiresAt">clock_timestamp()', [[scope.owner.userId, scope.peer.userId]])).rows[0].n, 0)
    assert.ok((await stat(scope.peer.storageStatePath)).isFile())
    assert.ok((await stat(ownedPath)).isFile())
    await assert.rejects(scope.owner.request('/api/auth/get-session'), { code: 'LEASE_CLOSED' })
  } finally {
    if (active.has(scope)) await scope.release({ outcome: 'dirty' }).catch(() => {})
    active.delete(scope)
    // Preserve the unsafe file as failure evidence; do not repair or remove it.
  }
})
