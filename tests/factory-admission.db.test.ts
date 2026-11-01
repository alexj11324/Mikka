import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import type { PoolClient } from 'pg'
import { remoteKey } from '@mikka/protocol/repository'
import type { FactoryTask } from '../lib/factory/store'
import { disposableDatabase } from './helpers/e2e-target.mjs'

const connection = process.env.E2E_DATABASE_URL
const enabled = disposableDatabase()
if (connection) {
  if (!enabled) throw new Error('Factory admission DB tests require a loopback *_e2e database')
  if (process.env.MIKKA_DATABASE_URL !== connection || process.env.DATABASE_URL !== connection || (process.env.ORVILO_DATABASE_URL && process.env.ORVILO_DATABASE_URL !== connection)) throw new Error('All admission database paths must use the ephemeral E2E_DATABASE_URL')
}
if (process.env.REQUIRE_DB === '1' && !enabled) throw new Error('Factory admission DB tests cannot skip in required CI')

type Fixture = {
  userId: string; issueId: string; deviceId: string; agentId: string; repoId: string
  remoteUrl: string; remoteKey: string; eventId: string; task: FactoryTask
}

test('real Factory admission preserves host scope, policy and transaction ownership', { skip: !enabled, timeout: 120_000 }, async t => {
  const { pool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const { queueRun, queueFactoryRun } = await import('../lib/agent-runs')
  const { acceptedEventStillMatches } = await import('../lib/run-admission-store')
  const { lockCliAgentPolicy, readCliAgentPolicy } = await import('../lib/agent-tool-approval/policy-store')
  const { setCliAgentPolicy } = await import('../lib/agent-tool-approval/policy-settings')
  const { factoryStore, dispatchFactoryRun, factoryQuestions } = await import('../lib/factory/server')
  const { factoryBinding } = await import('../lib/factory/dispatch')
  const { questionReference } = await import('../lib/factory/questions/store')
  const { recordPushGrant } = await import('./support/github-app-stub')
  const clearPushGrant = (userId: string, key: string) => pool.query('UPDATE github_repository_installations SET "pushGrantedAt"=null WHERE "userId"=$1 AND "remoteKey"=$2', [userId, key])
  const { promoteExistingIssueForUser } = await import('../lib/team-issue-promotion')
  const { previewPersonalScope, changeIssueScopeLocally } = await import('../lib/issue-scope-store')
  const fixtures: Fixture[] = []

  async function transaction<T>(work: (tx: PoolClient) => Promise<T>) {
    const tx = await pool.connect()
    try { await tx.query('BEGIN'); const value = await work(tx); await tx.query('COMMIT'); return value }
    catch (error) { await tx.query('ROLLBACK'); throw error }
    finally { tx.release() }
  }
  async function policy(f: Fixture, permission: 'allow' | 'ask' | 'deny') {
    const current = await readCliAgentPolicy(pool, f.userId, f.agentId, null)
    await setCliAgentPolicy(pool, f.userId, f.agentId, null, 'agent', current.revision, { permissions: { git_push: permission } })
  }
  async function addEvent(f: Pick<Fixture, 'userId' | 'issueId' | 'deviceId'>, options: { destination?: unknown; bound?: boolean; delivered?: boolean; botId?: string } = {}) {
    const id = randomUUID()
    await pool.query(`INSERT INTO coordinator_events (id,"userId","botId",kind,"dedupeKey","issueId",payload,"deliveredAt")
      VALUES ($1::uuid,$2,$3,'user_message','admission:'||$1::text,$4,$5,$6)`, [id, f.userId, options.botId ?? null, options.bound ? f.issueId : null,
      JSON.stringify({ text: 'Synthetic owner request; no provider invocation', ...(options.destination === undefined ? {} : { taskDestination: options.destination }) }),
      options.delivered === false ? null : new Date()])
    return id
  }
  // Factory's repositories are authorized: by default the fixture records the
  // GitHub App grant a live check would have found (contents: write, the
  // owner's own write access). `approved: false` leaves it unrecorded.
  async function fixture(options: { permission?: 'allow' | 'ask' | 'deny'; destination?: unknown | 'selected'; delivered?: boolean; approved?: boolean } = {}): Promise<Fixture> {
    const id = randomUUID(), userId = `factory-admission-${id}`
    const remoteUrl = `https://github.com/mikka-ci/admission-${id}.git`
    const identity = { userId, issueId: randomUUID(), deviceId: randomUUID(), agentId: randomUUID(), repoId: randomUUID(), remoteUrl, remoteKey: remoteKey(remoteUrl) }
    await pool.query('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$2,true,now(),now())', [userId, `${userId}@example.invalid`])
    await pool.query('INSERT INTO issue_prefixes ("userId",prefix) VALUES ($1,\'FADM\')', [userId])
    await pool.query('INSERT INTO devices (id,"ownerId",name,kind,harnesses,"protocolVersion") VALUES ($1,$2,\'Admission CI computer\',\'local\',$3,3)', [identity.deviceId, userId, JSON.stringify([{ harness: 'codex', installed: true }])])
    await pool.query('INSERT INTO agents (id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,\'codex\',\'Admission CI worker\')', [identity.agentId, userId, identity.deviceId])
    await pool.query('INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl","baseBranch") VALUES ($1,$2,$3,$4,$5,null)', [identity.repoId, identity.deviceId, userId, identity.remoteKey, remoteUrl])
    await pool.query('INSERT INTO issues (id,"userId",title,content,status,priority,scope) VALUES ($1,$2,\'Synthetic admission task\',$3,\'todo\',\'normal\',\'personal\')', [identity.issueId, userId, JSON.stringify({ type: 'doc', attrs: { mikka: { number: 1 } }, content: [] })])
    const eventId = await addEvent(identity, { destination: options.destination === 'selected' ? { kind: 'device', deviceId: identity.deviceId } : options.destination, delivered: options.delivered })
    const routed = await factoryStore.route(userId, { issueId: identity.issueId, eventId: randomUUID(), sourceEventId: eventId, rationale: 'Synthetic requested implementation' })
    const f = { ...identity, eventId, task: routed.task }
    fixtures.push(f)
    await policy(f, options.permission ?? 'allow')
    if (options.approved !== false) await recordPushGrant(pool, userId, identity.remoteKey)
    return f
  }
  const dispatch = (f: Fixture, tx?: PoolClient) => dispatchFactoryRun(f.userId, { binding: factoryBinding(f.task), agentId: f.agentId, deviceRepoId: f.repoId }, tx)
  const publicInput = (f: Fixture, requestKey: string) => ({ issueId: f.issueId, agentId: f.agentId, repo: f.remoteUrl, requestKey })
  const internalInput = (f: Fixture, requestKey?: string) => ({ issueId: f.issueId, agentId: f.agentId, deviceRepoId: f.repoId, ...(requestKey ? { requestKey } : {}) })
  const rowsFor = async (f: Fixture) => (await pool.query(`SELECT
    (SELECT count(*)::int FROM agent_runs WHERE "userId"=$1 AND "issueId"=$2) AS runs,
    (SELECT count(*)::int FROM run_publications WHERE "userId"=$1 AND "issueId"=$2) AS publications,
    (SELECT count(*)::int FROM factory_events WHERE "taskId"=$3) AS events`, [f.userId, f.issueId, f.task.id])).rows[0]
  async function waitBlockedBy(pid: number) {
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((await pool.query('SELECT exists(SELECT 1 FROM pg_stat_activity WHERE $1::int=any(pg_blocking_pids(pid))) AS blocked', [pid])).rows[0].blocked) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.fail('the real competing transaction must wait on the held policy lock')
  }
  async function scopeRoundTrip(f: Fixture) {
    const workspaceId = randomUUID(), teamId = randomUUID()
    await pool.query('INSERT INTO mikka_workspaces (id,"userId",name) VALUES ($1,$2,\'Synthetic admission workspace\')', [workspaceId, f.userId])
    await pool.query('INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,\'Synthetic owner\',$3,\'member\',\'active\')', [workspaceId, f.userId, `${f.userId}@example.invalid`])
    await pool.query('INSERT INTO mikka_teams (id,"workspaceId","userId",name,identifier) VALUES ($1,$2,$3,\'Admission team\',\'FADM\')', [teamId, workspaceId, f.userId])
    const current = (await pool.query('SELECT revision FROM issues WHERE id=$1', [f.issueId])).rows[0]
    const promoted = await promoteExistingIssueForUser(f.userId, { requestId: randomUUID(), issueId: f.issueId, revision: current.revision, teamId, expectedTeamId: null })
    assert.ok('issue' in promoted && promoted.issue?.scope === 'workspace', JSON.stringify(promoted))
    const preview = await previewPersonalScope(f.userId, f.issueId)
    assert.ok('preview' in preview && preview.preview)
    assert.equal(preview.preview.externalCopyPossible, false, 'the explicit team promotion does not infer an external publication')
    // Use the exact store contract behind confirmIssuePersonalScope, including
    // its preview digest and linked-publication rejection. No trigger override.
    const retired = await changeIssueScopeLocally(f.userId, { id: f.issueId, revision: preview.preview.revision, scope: 'personal' }, { allowLinkedPersonal: false, confirmation: preview.preview.confirmation })
    assert.ok('issue' in retired && retired.issue?.scope === 'personal', JSON.stringify(retired))
  }

  try {
    assert.equal(String((await pool.query('SHOW server_version_num')).rows[0].server_version_num).slice(0, 2), '17')

    await t.test('configured allow with the GitHub App grant queues a NULL-issue Factory source through the real public admission store', async () => {
      const f = await fixture()
      assert.equal((await pool.query('SELECT "issueId" FROM coordinator_events WHERE id=$1', [f.eventId])).rows[0].issueId, null)
      const admitted = await dispatch(f)
      const run = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [admitted.runId])).rows[0]
      const publication = (await pool.query('SELECT * FROM run_publications WHERE "runId"=$1', [admitted.runId])).rows[0]
      assert.equal(run.agentDefinition.repositoryAdmission.authority, 'github_app')
      assert.equal(run.agentDefinition.repositoryAdmission.approvedAt, (await pool.query('SELECT "pushGrantedAt" FROM github_repository_installations WHERE "userId"=$1 AND "remoteKey"=$2', [f.userId, f.remoteKey])).rows[0].pushGrantedAt.toISOString())
      assert.equal(run.agentDefinition.repositoryAdmission.remoteKey, f.remoteKey)
      assert.equal(run.dispatchKey, `factory:${f.task.attemptId}`)
      assert.equal(publication.scopeVersion, 1)
      assert.equal(publication.branch, 'mikka/fadm-1')
      assert.equal((await pool.query('SELECT "runId" FROM factory_attempts WHERE id=$1', [f.task.attemptId])).rows[0].runId, admitted.runId)
      const before = await rowsFor(f)
      assert.equal((await dispatch(f)).runId, admitted.runId)
      assert.deepEqual(await rowsFor(f), before)
      await assert.rejects(queueRun(f.userId, publicInput(f, `another:${randomUUID()}`)), /runAlreadyActive/, 'an internal Factory run still participates in the ordinary active-task gate')
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM github_repository_installations WHERE "userId"=$1 AND "pushGrantedAt" IS NOT NULL', [f.userId])).rows[0].n, 1, 'the admission rests on the one recorded GitHub App grant')
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM pending_actions WHERE "userId"=$1', [f.userId])).rows[0].n, 0, 'no approval card')
    })

    await t.test('configured allow without a GitHub App grant admits nothing', async () => {
      const f = await fixture({ approved: false })
      const before = await rowsFor(f)
      await assert.rejects(dispatch(f), /runInvalid/)
      await assert.rejects(queueRun(f.userId, publicInput(f, `allow:${randomUUID()}`)), /runInvalid/)
      assert.deepEqual(await rowsFor(f), before)
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM github_repository_installations WHERE "userId"=$1', [f.userId])).rows[0].n, 0, 'nothing recorded a grant on the owner\'s behalf')
    })

    await t.test('caller-owned rollback removes queue, publication, binding and dispatch receipt together', async () => {
      const f = await fixture({ destination: 'selected' })
      const before = await rowsFor(f)
      const tx = await pool.connect()
      let runId: string | undefined
      try {
        await tx.query('BEGIN')
        const admitted = await dispatch(f, tx)
        runId = admitted.runId
        assert.equal((await tx.query('SELECT count(*)::int AS n FROM agent_runs WHERE id=$1', [runId])).rows[0].n, 1)
        assert.deepEqual(await rowsFor(f), before, 'the host adapter must not commit the caller transaction')
        await tx.query('ROLLBACK')
      } finally { await tx.query('ROLLBACK'); tx.release() }
      assert.deepEqual(await rowsFor(f), before)
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_runs WHERE id=$1', [runId])).rows[0].n, 0)
      const committed = await dispatch(f)
      const admission = (await pool.query('SELECT "agentDefinition" FROM agent_runs WHERE id=$1', [committed.runId])).rows[0].agentDefinition.repositoryAdmission
      assert.equal(admission.requestEventId, f.eventId)
      assert.equal(await acceptedEventStillMatches(admission, null), true, 'the claim path retains the NULL-issue Factory host binding')
    })

    await t.test('destination, delivery and source identity cannot be discarded by an internal dispatch', async () => {
      for (const options of [
        { destination: { kind: 'device', deviceId: randomUUID() } },
        { destination: { kind: 'cloud' } },
        { destination: { kind: 'device' } },
        { destination: 'selected', delivered: false },
      ]) {
        const f = await fixture(options)
        const before = await rowsFor(f)
        await assert.rejects(dispatch(f), /runInvalid/)
        assert.deepEqual(await rowsFor(f), before)
      }
      const f = await fixture()
      await assert.rejects(transaction(tx => queueFactoryRun(tx, f.userId, internalInput(f), null, { sourceEventId: f.eventId, attemptId: randomUUID() })), /runInvalid/)
      await assert.rejects(transaction(tx => queueFactoryRun(tx, f.userId, internalInput(f))), /runInvalid/, 'the host must supply exactly one existing Factory or Skill origin')
      assert.equal((await rowsFor(f)).runs, 0)
    })

    await t.test('a persistent deny wins over the GitHub App grant; ask needs only the grant, never a card', async () => {
      const denied = await fixture({ permission: 'deny' })
      await assert.rejects(dispatch(denied), /runInvalid/)
      assert.equal((await rowsFor(denied)).runs, 0)
      const ask = await fixture({ permission: 'ask', approved: false })
      await assert.rejects(dispatch(ask), /runInvalid/)
      await recordPushGrant(pool, ask.userId, ask.remoteKey)
      const allowed = await dispatch(ask)
      assert.equal((await pool.query('SELECT "agentDefinition" FROM agent_runs WHERE id=$1', [allowed.runId])).rows[0].agentDefinition.repositoryAdmission.authority, 'github_app')
    })

    await t.test('policy contention precedes Factory task and worker locks, and the committed deny governs admission', async () => {
      const f = await fixture()
      const locker = await pool.connect()
      let pending: Promise<{ accepted: boolean; error?: unknown }> | undefined
      try {
        await locker.query('BEGIN')
        const pid = (await locker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
        await lockCliAgentPolicy(locker, f.userId, f.agentId, null)
        pending = dispatch(f).then(() => ({ accepted: true }), error => ({ accepted: false, error }))
        await waitBlockedBy(pid)
        await locker.query('SELECT id FROM factory_tasks WHERE id=$1 FOR UPDATE NOWAIT', [f.task.id])
        // The ordinary worker-policy setter holds the same policy locks before
        // it updates this row. No source run/worker lock may precede them.
        await locker.query('UPDATE agents SET cli_run_policy=$2 WHERE id=$1', [f.agentId, { permissions: { git_push: 'deny' } }])
        await locker.query('COMMIT')
        const result = await pending
        assert.equal(result.accepted, false)
        assert.match(String(result.error), /runInvalid/)
      } finally { await locker.query('ROLLBACK'); locker.release(); await pending }
      assert.equal((await rowsFor(f)).runs, 0)
      assert.equal((await pool.query('SELECT status FROM factory_tasks WHERE id=$1', [f.task.id])).rows[0].status, 'pending')
    })

    await t.test('real question continuations acquire policy and repository locks before their origin run', async () => {
      for (const held of ['policy', 'repository'] as const) {
        const f = await fixture({ destination: 'selected' })
        const origin = await dispatch(f)
        const questionId = randomUUID(), originSessionId = `synthetic-question:${origin.runId}`
        await pool.query(`UPDATE agent_runs SET status='stopped',"stopReason"='asked_human',"sessionId"=$2,"startedAt"=now(),"finishedAt"=now(),report=$3 WHERE id=$1`,
          [origin.runId, originSessionId, JSON.stringify({ summary: 'Synthetic stopped execution', openQuestions: ['Which task?'], question: { questionId, kind: 'context', question: 'Which task?', options: [] } })])
        const question = await factoryQuestions.record(f.userId, origin.runId)
        const input = { reference: questionReference(question), answerId: randomUUID(), facts: [{ kind: 'issue' as const, quote: 'Synthetic admission task' }] }
        const locker = await pool.connect()
        let pending: Promise<Awaited<ReturnType<typeof factoryQuestions.answer>>> | undefined
        let settled: Promise<{ accepted: boolean; error?: unknown }> | undefined
        try {
          await locker.query('BEGIN')
          const pid = (await locker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
          if (held === 'policy') await lockCliAgentPolicy(locker, f.userId, f.agentId, null)
          else await locker.query('SELECT 1 FROM github_repository_installations WHERE "userId"=$1 AND "remoteKey"=$2 FOR UPDATE', [f.userId, f.remoteKey])
          pending = factoryQuestions.answer({ source: 'orchestrator', userId: f.userId }, input)
          settled = pending.then(() => ({ accepted: true }), error => ({ accepted: false, error }))
          await waitBlockedBy(pid)
          if (held === 'policy') await locker.query('SELECT id FROM factory_tasks WHERE id=$1 FOR UPDATE NOWAIT', [f.task.id])
          else assert.equal((await locker.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS available', [JSON.stringify(['dispatch-issue', f.userId, f.issueId])])).rows[0].available, true, 'question continuation must wait for the GitHub App grant before holding dispatch-issue')
          await locker.query('SELECT id FROM agent_runs WHERE id=$1 FOR UPDATE NOWAIT', [origin.runId])
          await locker.query('COMMIT')
          const outcome = await settled
          assert.equal(outcome.accepted, true, String(outcome.error))
          const resumed = await pending
          const continuation = (await pool.query('SELECT "questionContinuation","agentDefinition" FROM agent_runs WHERE id=$1', [resumed.continuationRunId])).rows[0]
          assert.equal(continuation.questionContinuation.originRunId, origin.runId)
          assert.equal(continuation.questionContinuation.originSessionId, originSessionId)
          assert.equal(continuation.questionContinuation.requireSessionResume, true)
          assert.equal(continuation.agentDefinition.repositoryAdmission.requestEventId, f.eventId)
          assert.equal((await rowsFor(f)).runs, 2)
        } finally { await locker.query('ROLLBACK'); locker.release(); await settled }
      }
    })

    await t.test('key replay is immutable, preserves read-only confirmation after denial and rejects a new host event', async () => {
      const f = await fixture()
      const destination = { kind: 'device', deviceId: f.deviceId }
      const firstEvent = await addEvent(f, { bound: true, destination })
      const input = publicInput(f, `host:${randomUUID()}`)
      const first = await queueRun(f.userId, input, null, undefined, firstEvent)
      const before = (await pool.query('SELECT "agentDefinition" FROM agent_runs WHERE id=$1', [first.runId])).rows[0].agentDefinition
      const secondEvent = await addEvent(f, { bound: true, destination })
      await assert.rejects(queueRun(f.userId, input, null, undefined, secondEvent), /runDispatchKeyConflict/)
      await policy(f, 'deny')
      await clearPushGrant(f.userId, f.remoteKey)
      assert.deepEqual(await queueRun(f.userId, input, null, undefined, firstEvent), { runId: first.runId, status: 'queued', replayed: true })
      assert.deepEqual((await pool.query('SELECT "agentDefinition" FROM agent_runs WHERE id=$1', [first.runId])).rows[0].agentDefinition, before)
      await assert.rejects(queueRun(f.userId, { ...input, requestKey: `fresh:${randomUUID()}` }, null, undefined, secondEvent), /runInvalid/)
      assert.equal((await rowsFor(f)).runs, 1)
    })

    await t.test('replay cannot move between Bot scopes or survive a task scope round trip', async () => {
      const f = await fixture()
      const input = publicInput(f, `scope:${randomUUID()}`)
      const first = await queueRun(f.userId, input)
      const botId = randomUUID(), workspaceId = randomUUID()
      await pool.query('INSERT INTO bots (id,"ownerId","workspaceId",name) VALUES ($1,$2,$3,\'Synthetic scoped Bot\')', [botId, f.userId, workspaceId])
      await assert.rejects(queueRun(f.userId, input, botId), /runDispatchKeyConflict/)
      const oldScope = (await pool.query('SELECT "scopeVersion" FROM run_publications WHERE "runId"=$1', [first.runId])).rows[0].scopeVersion
      await scopeRoundTrip(f)
      assert.ok((await pool.query('SELECT "scopeVersion" FROM issues WHERE id=$1', [f.issueId])).rows[0].scopeVersion > oldScope)
      await assert.rejects(queueRun(f.userId, input), /runDispatchKeyConflict/)
      assert.equal((await rowsFor(f)).runs, 1)
      assert.equal((await pool.query('SELECT "scopeVersion" FROM run_publications WHERE "runId"=$1', [first.runId])).rows[0].scopeVersion, oldScope)
    })

    await t.test('Skill continuations inherit the existing origin and reject revoked generations', async () => {
      const f = await fixture({ destination: 'selected' })
      const origin = await dispatch(f)
      await pool.query('UPDATE agent_runs SET status=\'succeeded\',"finishedAt"=now(),"sessionId"=\'synthetic-completed-source\' WHERE id=$1', [origin.runId])
      const next = await transaction(tx => queueFactoryRun(tx, f.userId, internalInput(f, `skill:${randomUUID()}`), null, undefined, origin.runId))
      const child = (await pool.query('SELECT "botId","agentDefinition" FROM agent_runs WHERE id=$1', [next.runId])).rows[0]
      assert.equal(child.botId, null)
      assert.equal(child.agentDefinition.repositoryAdmission.requestEventId, f.eventId)
      assert.equal(await acceptedEventStillMatches(child.agentDefinition.repositoryAdmission, null), true)
      await scopeRoundTrip(f)
      await assert.rejects(transaction(tx => queueFactoryRun(tx, f.userId, internalInput(f, `skill:${randomUUID()}`), null, undefined, origin.runId)), /runInvalid/)
      assert.equal((await rowsFor(f)).runs, 2)
    })
  } finally {
    // Keep immutable audit fixtures, but leave no queued execution authority.
    if (fixtures.length) await pool.query('UPDATE agent_runs SET "stopRequestedAt"=coalesce("stopRequestedAt",now()) WHERE "userId"=any($1::text[])', [fixtures.map(f => f.userId)])
    await pool.end()
    await workspacePool.end()
  }
})
