// A subscription's quota runs out mid-run (stop reason `quota_exhausted`):
// with 「订阅额度用完后，自动改用 API Key」 on and a key for the run's Agent the
// run goes on at once on that key; otherwise it pauses for the person, who can
// resume it on a key or retry it with its original credential. Real
// PostgreSQL, the real dispatch, completion and claim; only Next's `after` (no
// request scope in node:test) and the provider's model list are replaced.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mock, test } from 'node:test'
import { DAEMON_PROTOCOL_VERSION } from '@mikka/protocol/daemon'
import { MODEL_CREDENTIAL_HEADER, RECOVERY_WORKTREE_HEADER, REPO_ORIGIN_HEADER } from '@mikka/protocol/device'
import { normalizeRepository } from '@mikka/protocol/repository'
import { emptyRunReport } from '@mikka/protocol/run'
import { dbUrl, seedBot, seedIssue, seedUser, seedWorkspace } from './support/workspace-admin-db'
import { recordPushGrant } from './support/github-app-stub'

test('quota exhausted mid-run: continue on the person\'s key, else pause with the reset; resume and retry actions', { skip: !dbUrl }, async t => {
  const saved = { key: process.env.WORKSPACE_SECRETS_KEY, byos: process.env.MIKKA_BYOS_ENABLED }
  process.env.WORKSPACE_SECRETS_KEY = randomBytes(32).toString('hex')
  process.env.MIKKA_BYOS_ENABLED = '1'
  delete process.env.MIKKA_CLOUD_COMPUTER_TASKS
  delete process.env.MIKKA_CLOUD_THREAD_MACHINES
  delete process.env.MIKKA_FACTORY_ROUTING_ENABLED
  const next = await import('next/server')
  mock.module('next/server', { namedExports: { NextRequest: next.NextRequest, NextResponse: next.NextResponse, after: () => {} } })
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 3 })
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const keys = await import('../lib/model-api-keys')
  const { queueRun } = await import('../lib/agent-runs')
  const { persistRunCompletion } = await import('../lib/run-publications')
  const { reclaimLostRuns } = await import('../lib/run-leases')
  const quota = await import('../lib/run-quota')
  const { threadQuotaView } = await import('../lib/run-quota-view')
  const { hashDeviceToken } = await import('../lib/device-link')
  const claimRoute = await import('../app/v1/devices/[deviceId]/runs/[runId]/claim/route')
  const users: string[] = []
  t.after(async () => {
    for (const [name, value] of [['WORKSPACE_SECRETS_KEY', saved.key], ['MIKKA_BYOS_ENABLED', saved.byos]] as const) if (value === undefined) delete process.env[name]; else process.env[name] = value
    await pool.query('DELETE FROM coordinator_events WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM model_api_key_runs m USING agent_runs r WHERE r.id=m."runId" AND r."userId" = ANY($1)', [users])
    await pool.query('DELETE FROM byos_native_runs n USING agent_runs r WHERE r.id=n."runId" AND r."userId" = ANY($1)', [users])
    await pool.query('DELETE FROM run_publications WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM run_tokens t USING agent_runs r WHERE r.id=t."runId" AND r."userId" = ANY($1)', [users]).catch(() => undefined)
    await pool.query('UPDATE agent_runs SET "retryOf"=NULL WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM agent_runs WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM bot_model_choices WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM model_api_keys WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM byos_bindings WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM byos_connections WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM workspace_subscription_shares WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM device_tokens WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM agents WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM device_repos WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM devices WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM repository_settings WHERE "userId" = ANY($1)', [users])
    await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
  })

  const models = (ids: string[]) => (async () => Response.json({ data: ids.map(id => ({ id })) })) as unknown as typeof fetch
  const addKey = (ownerId: string, provider: 'anthropic' | 'openai', listed: string[]) =>
    keys.addApiKey(pool, ownerId, { provider, apiKey: `sk-${randomBytes(16).toString('hex')}` }, { env: process.env, fetch: models(listed) })
  const task = async (ownerId: string) => {
    const issueId = await seedIssue(pool, ownerId)
    await pool.query(`UPDATE issues SET content=$2 WHERE id=$1`, [issueId, JSON.stringify({ type: 'doc', attrs: { mikka: { number: Math.floor(Math.random() * 1e6) + 1 } } })])
    return issueId
  }
  /** A person, their workspace and bot, and their own device with Claude Code and Codex. */
  const person = async (label: string) => {
    const id = await seedUser(pool, label)
    users.push(id)
    const ws = await seedWorkspace(pool, id, [{ userId: id, role: 'admin' }])
    await pool.query('INSERT INTO workspace_subscription_shares ("ownerId","workspaceId") VALUES ($1,$2)', [id, ws.id])
    const botId = await seedBot(pool, ws.id, id)
    const remote = `https://github.com/mikka-ci/run-quota-${randomUUID()}.git`
    // Push is what the GitHub App grants (lib/github/push-grant.ts); record that grant as a live check would.
    await recordPushGrant(pool, id, normalizeRepository(remote).key)
    const deviceId = randomUUID()
    await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,enabled,"protocolVersion","lastSeenAt",harnesses) VALUES ($1,$2,'Laptop','local',true,$3,now(),$4)`,
      [deviceId, id, DAEMON_PROTOCOL_VERSION, JSON.stringify([{ harness: 'claude_code', installed: true, toolApproval: true }, { harness: 'codex', installed: true, toolApproval: true }])])
    const agents: Record<'claude_code' | 'codex', string> = { claude_code: randomUUID(), codex: randomUUID() }
    for (const [harness, agentId] of Object.entries(agents)) await pool.query('INSERT INTO agents (id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,$4,$5)', [agentId, id, deviceId, harness, `${harness}-${agentId.slice(0, 8)}`])
    const token = `synthetic-${randomUUID()}`
    await pool.query('INSERT INTO device_tokens (id,"userId","tokenHash") VALUES ($1,$2,$3)', [randomUUID(), id, hashDeviceToken(token)])
    return { id, workspaceId: ws.id, botId, remote, deviceId, agents, token }
  }
  type Person = Awaited<ReturnType<typeof person>>
  /** A connected Claude subscription bound to the person's Claude Code Agent. */
  const subscribe = async (p: Person) => {
    const connection = randomUUID()
    await pool.query(`INSERT INTO byos_connections (id,"ownerId","workspaceId",provider,state,epoch,"secretName","secretDigest","providerSubject") VALUES ($1,$2,$3,'claude','connected',1,$5,$4,'synthetic-subject')`, [connection, p.id, p.workspaceId, 'a'.repeat(64), `synthetic-${connection}`])
    const binding = randomUUID()
    await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES ($1,$2,$3,$4,$5,1,'claude_code_cli','subscription-model')`, [binding, p.id, p.workspaceId, p.agents.claude_code, connection])
    return { connection, binding }
  }
  /** A run dispatched the ordinary way, then running on the device with a session, as a claim leaves it. */
  const running = async (p: Person, harness: 'claude_code' | 'codex') => {
    const { runId } = await queueRun(p.id, { issueId: await task(p.id), agentId: p.agents[harness], repo: p.remote }, p.botId)
    await pool.query(`UPDATE agent_runs SET status='running',"sessionId"=$2,"worktreePath"='/tmp/wt',"startedAt"=now(),"leaseExpiresAt"=now()+interval '5 minutes' WHERE id=$1`, [runId, `session-${runId}`])
    return runId
  }
  const quotaEnd = (p: Person, runId: string, resetsAt: string | null) =>
    persistRunCompletion(p.id, runId, { stopReason: 'quota_exhausted', report: { ...emptyRunReport('Stopped on the usage limit.'), resetsAt } })
  const row = async (runId: string) => (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [runId])).rows[0]
  const events = async (runId: string) => (await pool.query('SELECT kind,"dedupeKey","issueId","botId",payload FROM coordinator_events WHERE "runId"=$1 ORDER BY "createdAt"', [runId])).rows
  const continuations = async (runId: string) => (await pool.query('SELECT * FROM agent_runs WHERE "retryOf"=$1', [runId])).rows
  const claim = (p: Person, runId: string) => claimRoute.POST(new Request(`http://127.0.0.1/v1/devices/${p.deviceId}/runs/${runId}/claim`, {
    method: 'POST', headers: { authorization: `Bearer ${p.token}`, [REPO_ORIGIN_HEADER]: '1', [MODEL_CREDENTIAL_HEADER]: '1', [RECOVERY_WORKTREE_HEADER]: '1' },
  }), { params: Promise.resolve({ deviceId: p.deviceId, runId }) })
  const failsWith = async (work: Promise<unknown>, code: string) => assert.rejects(work, (error: { code?: string }) => error.code === code)
  const resetsAt = new Date(Date.now() + 3 * 3_600_000).toISOString()

  await t.test('(a) setting on and a key: the run ends quota_exhausted and goes on frozen on the key, in its worktree and session', async () => {
    const p = await person('quota-switch')
    const { connection, binding } = await subscribe(p)
    const runId = await running(p, 'claude_code')
    assert.equal((await row(runId)).agentDefinition.subscription.bindingId, binding, 'the run is on the subscription')
    const key = await addKey(p.id, 'anthropic', ['key-model-a', 'key-model-b'])

    await quotaEnd(p, runId, resetsAt)
    const original = await row(runId)
    assert.equal(original.status, 'failed')
    assert.equal(original.stopReason, 'quota_exhausted')
    assert.equal(original.pauseReason, null)
    assert.equal(original.quotaResetsAt.toISOString(), resetsAt)
    const [continuation, ...more] = await continuations(runId)
    assert.equal(more.length, 0)
    assert.equal(continuation.status, 'queued')
    assert.equal(continuation.deviceId, p.deviceId)
    assert.equal(continuation.deviceRepoId, original.deviceRepoId)
    assert.equal(continuation.issueId, original.issueId)
    assert.equal(continuation.botId, p.botId)
    assert.deepEqual(continuation.agentDefinition.apiKey, { keyId: key.id, model: 'key-model-a' })
    assert.equal(continuation.agentDefinition.modelSource, 'api_key')
    assert.equal(continuation.agentDefinition.subscription, undefined)
    assert.equal(continuation.agentDefinition.model, 'key-model-a')

    const recorded = await events(runId)
    assert.deepEqual(recorded.map(event => event.kind), ['run_credential_switched'], 'no run_finished besides it')
    assert.equal(recorded[0].dedupeKey, `run_credential_switched:${runId}`)
    assert.equal(recorded[0].issueId, original.issueId)
    assert.equal(recorded[0].botId, p.botId)
    assert.deepEqual(recorded[0].payload, {
      reason: 'quota_exhausted',
      from: { kind: 'subscription', provider: 'claude', connectionId: connection },
      to: { kind: 'api_key', keyId: key.id, provider: 'anthropic', name: null, last4: key.last4, model: 'key-model-a' },
      retryRunId: continuation.id, resetsAt,
    })

    // A replayed completion changes nothing.
    await quotaEnd(p, runId, null)
    assert.equal((await continuations(runId)).length, 1)
    assert.equal((await events(runId)).length, 1)

    // The claim continues the same worktree and session on this device, on the key.
    const response = await claim(p, continuation.id)
    const text = await response.text()
    assert.equal(response.status, 200, text)
    const assignment = JSON.parse(text)
    assert.equal(assignment.continuesRunId, runId)
    assert.equal(assignment.resumeSessionId, `session-${runId}`)
    assert.equal(assignment.requireWorktreeContinuation, true)
    assert.match(assignment.followUp, /usage limit/)
    assert.equal(assignment.modelCredential.protocol, 'anthropic')
    assert.equal(assignment.subscriptionBinding, undefined)
  })

  await t.test('(b) no key: the run is paused with the reset, holds no lease, is not reclaimed, and the card says noApiKey', async () => {
    const p = await person('quota-no-key')
    const runId = await running(p, 'codex')
    await quotaEnd(p, runId, resetsAt)
    const paused = await row(runId)
    assert.equal(paused.status, 'paused')
    assert.equal(paused.pauseReason, 'quota_exhausted')
    assert.equal(paused.stopReason, 'quota_exhausted')
    assert.equal(paused.quotaResetsAt.toISOString(), resetsAt)
    assert.equal(paused.leaseExpiresAt, null)
    assert.equal(paused.finishedAt, null)
    assert.equal((await continuations(runId)).length, 0)
    const recorded = await events(runId)
    assert.deepEqual(recorded.map(event => event.kind), ['run_quota_paused'])
    assert.equal(recorded[0].dedupeKey, `run_quota_paused:${runId}`)
    assert.deepEqual(recorded[0].payload, {
      reason: 'quota_exhausted', provider: 'codex', connectionId: null, resetsAt, why: 'noApiKey',
      actions: [{ action: 'addApiKey' }, { action: 'retryAfterReset', at: resetsAt }],
    })
    await reclaimLostRuns(p.id, new Date(Date.now() + 3_600_000))
    assert.equal((await row(runId)).status, 'paused', 'a paused run is not lost')
    await quotaEnd(p, runId, null)
    assert.equal((await row(runId)).quotaResetsAt.toISOString(), resetsAt, 'a replay does not change it')

    // The open thread's card: paused, the reset, no key yet; nothing for anyone else.
    assert.deepEqual(await threadQuotaView(p.id, [runId], runId), { switched: [], paused: { runId, subscription: 'codex', plan: null, resetsAt, keyReady: false } })

    // (d) resume on a key: none yet, then one added.
    await failsWith(quota.resumeQuotaPausedRunOnApiKey(p.id, runId), 'apiKeyNotFound')
    assert.equal((await row(runId)).status, 'paused')
    const other = await person('quota-intruder')
    await failsWith(quota.resumeQuotaPausedRunOnApiKey(other.id, runId), 'runNotFound')
    assert.deepEqual(await threadQuotaView(other.id, [runId], runId), { switched: [], paused: null })
    const key = await addKey(p.id, 'openai', ['key-model-c'])
    assert.equal((await threadQuotaView(p.id, [runId], runId)).paused?.keyReady, true, 'the card offers 用 API Key 继续 once a key exists')
    const { runId: retryRunId } = await quota.resumeQuotaPausedRunOnApiKey(p.id, runId)
    assert.deepEqual(await threadQuotaView(p.id, [runId, retryRunId], retryRunId), {
      switched: [{ runId, subscription: 'codex', plan: null, key: { provider: 'openai', name: null, model: 'key-model-c' } }], paused: null,
    })
    assert.deepEqual(await quota.resumeQuotaPausedRunOnApiKey(p.id, runId), { runId: retryRunId }, 'idempotent')
    const original = await row(runId)
    assert.equal(original.status, 'failed')
    assert.equal(original.pauseReason, null)
    assert.equal(original.stopReason, 'quota_exhausted')
    const [continuation, ...more] = await continuations(runId)
    assert.equal(more.length, 0)
    assert.equal(continuation.id, retryRunId)
    assert.deepEqual(continuation.agentDefinition.apiKey, { keyId: key.id, model: 'key-model-c' })
    const switched = (await events(runId)).filter(event => event.kind === 'run_credential_switched')
    assert.equal(switched.length, 1)
    assert.deepEqual(switched[0].payload, {
      reason: 'quota_exhausted',
      from: { kind: 'subscription', provider: 'codex', connectionId: null },
      to: { kind: 'api_key', keyId: key.id, provider: 'openai', name: null, last4: key.last4, model: 'key-model-c' },
      retryRunId, resetsAt,
    })
    await failsWith(quota.retryQuotaPausedRun(p.id, retryRunId), 'runNotActive')
  })

  await t.test('(c) setting off: paused with apiKeyAfterQuotaOff even with a key; (d) retry keeps the original credential', async () => {
    const p = await person('quota-off')
    await addKey(p.id, 'anthropic', ['key-model-a'])
    await keys.setApiKeyAfterQuota(pool, p.id, false)
    const { binding } = await subscribe(p)
    const runId = await running(p, 'claude_code')
    await quotaEnd(p, runId, null)
    const paused = await row(runId)
    assert.equal(paused.status, 'paused')
    assert.equal(paused.pauseReason, 'quota_exhausted')
    assert.equal(paused.quotaResetsAt, null)
    const [event] = await events(runId)
    assert.equal(event.kind, 'run_quota_paused')
    assert.equal(event.payload.why, 'apiKeyAfterQuotaOff')
    assert.equal(event.payload.resetsAt, null)
    assert.deepEqual(event.payload.actions, [{ action: 'addApiKey' }, { action: 'retryAfterReset', at: null }])

    const { runId: retryRunId } = await quota.retryQuotaPausedRun(p.id, runId)
    assert.deepEqual(await quota.retryQuotaPausedRun(p.id, runId), { runId: retryRunId }, 'idempotent')
    assert.equal((await row(runId)).status, 'failed')
    const [continuation] = await continuations(runId)
    assert.equal(continuation.id, retryRunId)
    assert.equal(continuation.agentDefinition.subscription.bindingId, binding, 'the original subscription')
    assert.equal(continuation.agentDefinition.apiKey, undefined)
    assert.equal((await events(runId)).filter(event => event.kind === 'run_credential_switched').length, 0)
    // If its quota is still out, it pauses again.
    await pool.query(`UPDATE agent_runs SET status='running',"leaseExpiresAt"=now()+interval '5 minutes' WHERE id=$1`, [retryRunId])
    await quotaEnd(p, retryRunId, resetsAt)
    assert.equal((await row(retryRunId)).status, 'paused')
  })

  await t.test('a run already on an API key that hits a rate limit is an ordinary error', async () => {
    const p = await person('quota-key-run')
    const key = await addKey(p.id, 'anthropic', ['key-model-a'])
    await keys.setBotApiKeyChoice(pool, { ownerId: p.id, workspaceId: p.workspaceId }, p.botId, key.id, 'key-model-a')
    const runId = await running(p, 'claude_code')
    assert.equal((await row(runId)).agentDefinition.modelSource, 'api_key')
    await quotaEnd(p, runId, resetsAt)
    const ended = await row(runId)
    assert.equal(ended.status, 'failed')
    assert.equal(ended.stopReason, 'error')
    assert.equal((await continuations(runId)).length, 0)
    assert.deepEqual((await events(runId)).map(event => event.kind), ['run_finished'])
  })

  await t.test('stopping a quota-paused run ends it at once', async () => {
    const p = await person('quota-stop')
    const runId = await running(p, 'codex')
    await quotaEnd(p, runId, null)
    const { requestRunStop } = await import('../lib/agent-runs')
    assert.deepEqual(await requestRunStop(p.id, runId), { stoppedRunIds: [runId] })
    const stopped = await row(runId)
    assert.equal(stopped.status, 'stopped')
    assert.equal(stopped.pauseReason, null)
  })
})
