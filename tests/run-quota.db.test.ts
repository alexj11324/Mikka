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
import { sealSecret, userE2bKeyAad } from '../lib/secrets/crypto'
import { seedRunProjectResources } from './helpers/run-project-resources'
import { threadPromptView } from '../lib/thread-prompt'

test('quota exhausted mid-run: continue on the person\'s key, else pause with the reset; resume and retry actions', { skip: !dbUrl }, async t => {
  const saved = { key: process.env.WORKSPACE_SECRETS_KEY, byos: process.env.MIKKA_BYOS_ENABLED }
  process.env.WORKSPACE_SECRETS_KEY = randomBytes(32).toString('hex')
  process.env.MIKKA_BYOS_ENABLED = '1'
  delete process.env.MIKKA_CLOUD_COMPUTER_TASKS
  delete process.env.MIKKA_FACTORY_ROUTING_ENABLED
  const next = await import('next/server')
  mock.module('next/server', { namedExports: { NextRequest: next.NextRequest, NextResponse: next.NextResponse, after: () => {} } })
  const { Client, Pool } = await import('pg')
  const query = Client.prototype.query
  let resourceReads = 0
  t.mock.method(Client.prototype, 'query', function (this: InstanceType<typeof Client>, ...args: unknown[]) {
    const text = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string })?.text
    if (text?.includes('FOR SHARE OF repo,device,agent')) resourceReads++
    return Reflect.apply(query, this, args)
  })
  const pool = new Pool({ connectionString: dbUrl, max: 3 })
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  // The real APP and Workspace pools each have one connection. Fixture setup
  // and lock observation use the separate PG pool above, never an auth mock.
  appPool.options.max = 1
  workspacePool.options.max = 1
  const { actAs } = await import('../lib/acting-user')
  const { enterprisePrincipal } = await import('../lib/enterprise/principal')
  const { tokenWorkspace } = await import('../lib/tokens/principal')
  const { withTaskWorkspace } = await import('../lib/task-workspace')
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
    await pool.query('DELETE FROM thread_machines WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM computer_run_bindings WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM "session" WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM model_api_key_runs m USING agent_runs r WHERE r.id=m."runId" AND r."userId" = ANY($1)', [users])
    await pool.query('DELETE FROM byos_native_runs n USING agent_runs r WHERE r.id=n."runId" AND r."userId" = ANY($1)', [users])
    await pool.query('DELETE FROM run_publications WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM run_tokens t USING agent_runs r WHERE r.id=t."runId" AND r."userId" = ANY($1)', [users]).catch(() => undefined)
    await pool.query('UPDATE agent_runs SET "retryOf"=NULL WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM agent_runs WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM bot_model_choices WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM model_api_keys WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM user_e2b_keys WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM byos_bindings WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM byos_connections WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM workspace_subscription_shares WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM device_tokens WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM bot_cloud_runtimes WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM bot_desktops WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM cloud_machines WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM agents WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM device_repos WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM devices WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM repository_settings WHERE "userId" = ANY($1)', [users])
    await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
  })

  const models = (ids: string[]) => (async () => Response.json({ data: ids.map(id => ({ id })) })) as unknown as typeof fetch
  const addKey = (ownerId: string, provider: 'anthropic' | 'openai', listed: string[]) =>
    keys.addApiKey(pool, ownerId, { provider, apiKey: `sk-${randomBytes(16).toString('hex')}` }, { env: process.env, fetch: models(listed) })
  const task = async (ownerId: string, workspaceId: string) => {
    const issueId = await seedIssue(pool, ownerId, workspaceId)
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
    // An installation row an earlier build recorded; admission no longer reads it (decision 2026-11-02-1600).
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
  const running = async (p: Person, harness: 'claude_code' | 'codex', model?: string, issueId?: string) => {
    const { runId } = await queueRun(p.id, { issueId: issueId ?? await task(p.id, p.workspaceId), agentId: p.agents[harness], repo: p.remote, model: model ?? (harness === 'claude_code' ? 'subscription-model' : 'gpt-fixture') }, p.botId)
    await pool.query(`UPDATE agent_runs SET status='running',"sessionId"=$2,"worktreePath"='/tmp/wt',"startedAt"=now(),"leaseExpiresAt"=now()+interval '5 minutes' WHERE id=$1`, [runId, `session-${runId}`])
    return runId
  }
  const quotaEnd = (p: Person, runId: string, resetsAt: string | null) =>
    persistRunCompletion(p.id, runId, { stopReason: 'quota_exhausted', report: { ...emptyRunReport('Stopped on the usage limit.'), resetsAt } })
  const row = async (runId: string) => (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [runId])).rows[0]
  const events = async (runId: string) => (await pool.query('SELECT kind,"dedupeKey","issueId","botId",payload FROM coordinator_events WHERE "runId"=$1 ORDER BY "createdAt"', [runId])).rows
  const continuations = async (runId: string) => (await pool.query('SELECT * FROM agent_runs WHERE "retryOf"=$1', [runId])).rows
  const claim = (p: Person, runId: string) => claimRoute.POST(new Request(`http://127.0.0.1/v1/devices/${p.deviceId}/runs/${runId}/claim`, {
    method: 'POST', headers: { 'x-mikka-client-version': '0.0.456', authorization: `Bearer ${p.token}`, [REPO_ORIGIN_HEADER]: '1', [MODEL_CREDENTIAL_HEADER]: '1', [RECOVERY_WORKTREE_HEADER]: '1' },
  }), { params: Promise.resolve({ deviceId: p.deviceId, runId }) })
  const failsWith = async (work: Promise<unknown>, code: string) => assert.rejects(work, (error: { code?: string }) => error.code === code)
  const resetsAt = new Date(Date.now() + 3 * 3_600_000).toISOString()

  for (const mutation of ['repository', 'environment-revision', 'environment-archive', 'project-archive', 'branch'] as const)
    for (const automatic of [true, false]) await t.test(`${automatic ? 'automatic quota completion' : 'manual quota retry'} refuses ${mutation} before a child or extra parent mutation`, async () => {
      const p = await person(`quota-resource-${mutation}-${automatic}`)
      await subscribe(p)
      const issueId = await task(p.id, p.workspaceId)
      const resources = await seedRunProjectResources(pool, { ownerId: p.id, workspaceId: p.workspaceId, issueId,
        repositoryKey: normalizeRepository(p.remote).key, runtime: 'local', harness: 'claude_code' })
      const runId = await running(p, 'claude_code', undefined, issueId)
      const frozen = (await row(runId)).agentDefinition
      assert.equal(frozen.projectExecution.environment.id, resources.environment!.id)
      if (!automatic) await quotaEnd(p, runId, resetsAt)
      else await addKey(p.id, 'anthropic', ['subscription-model'])
      await resources.refuse(mutation)
      const before = await row(runId), beforeEvents = await events(runId)
      const expected = mutation === 'repository' || mutation === 'branch' ? 'projectRepositoryDenied'
        : mutation === 'project-archive' ? 'projectArchived' : 'projectEnvironmentUnavailable'
      if (automatic) {
        await quotaEnd(p, runId, resetsAt)
        const stopped = await row(runId)
        assert.equal(stopped.status, 'paused'); assert.equal(stopped.stopReason, 'quota_exhausted')
        assert.deepEqual(stopped.agentDefinition, frozen)
        assert.equal(stopped.finishedAt, null); assert.equal(stopped.leaseExpiresAt, null)
        const recorded = await events(runId)
        assert.equal(recorded.length, 1); assert.equal(recorded[0].kind, 'run_blocked')
        assert.equal(recorded[0].payload.reasonCode, expected)
        await quotaEnd(p, runId, null)
        assert.deepEqual(await row(runId), stopped, 'the legitimate completion is idempotent after refusal')
        assert.deepEqual(await events(runId), recorded)
      } else {
        await failsWith(quota.retryQuotaPausedRun(p.id, runId), expected)
        assert.deepEqual(await row(runId), before)
        assert.deepEqual(await events(runId), beforeEvents)
      }
      assert.deepEqual(await continuations(runId), [])
    })

  for (const environment of [false, true]) await t.test(`legacy quota source cannot acquire ${environment ? 'a new Environment' : 'a changed branch'}`, async () => {
    const p = await person(`quota-legacy-resource-${environment}`)
    await subscribe(p)
    const runId = await running(p, 'claude_code')
    await quotaEnd(p, runId, resetsAt)
    const legacy = await row(runId)
    delete legacy.agentDefinition.projectExecution
    const { workerDefinitionDigest } = await import('../lib/agent-kit/worker-digest')
    legacy.agentDefinition.definitionDigest = workerDefinitionDigest(legacy.agentDefinition)
    await pool.query('UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1', [runId, JSON.stringify(legacy.agentDefinition)])
    const resources = await seedRunProjectResources(pool, { ownerId: p.id, workspaceId: p.workspaceId, issueId: legacy.issueId,
      repositoryKey: normalizeRepository(p.remote).key, runtime: 'local', harness: 'claude_code', environment })
    if (!environment) await resources.refuse('branch')
    const before = await row(runId), history = await events(runId)
    await failsWith(quota.retryQuotaPausedRun(p.id, runId), environment ? 'projectEnvironmentUnavailable' : 'projectRepositoryDenied')
    assert.deepEqual(await row(runId), before); assert.deepEqual(await events(runId), history)
    assert.deepEqual(await continuations(runId), [])
  })

  await t.test('(a) setting on and a key: the run ends quota_exhausted and goes on frozen on the key, in its worktree and session', async () => {
    const p = await person('quota-switch')
    const { connection, binding } = await subscribe(p)
    const runId = await running(p, 'claude_code')
    assert.equal((await row(runId)).agentDefinition.subscription.bindingId, binding, 'the run is on the subscription')
    const key = await addKey(p.id, 'anthropic', ['subscription-model', 'key-model-b'])

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
    assert.ok(original.promptTaskLength > 0)
    assert.deepEqual(threadPromptView(continuation.prompt, continuation.promptTaskStart, continuation.promptTaskLength),
      threadPromptView(original.prompt, original.promptTaskStart, original.promptTaskLength))
    assert.deepEqual(continuation.agentDefinition.apiKey, { keyId: key.id, model: 'subscription-model' })
    assert.equal(continuation.agentDefinition.modelSource, 'api_key')
    assert.equal(continuation.agentDefinition.subscription, undefined)
    assert.equal(continuation.agentDefinition.model, 'subscription-model')

    const recorded = await events(runId)
    assert.deepEqual(recorded.map(event => event.kind), ['run_credential_switched'], 'no run_finished besides it')
    assert.equal(recorded[0].dedupeKey, `run_credential_switched:${runId}`)
    assert.equal(recorded[0].issueId, original.issueId)
    assert.equal(recorded[0].botId, p.botId)
    assert.deepEqual(recorded[0].payload, {
      reason: 'quota_exhausted',
      from: { kind: 'subscription', provider: 'claude', connectionId: connection },
      to: { kind: 'api_key', keyId: key.id, provider: 'anthropic', name: null, last4: key.last4, model: 'subscription-model' },
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
    const runId = await running(p, 'codex', 'gpt-fixture')
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
    // Someone else's key, not shared with the owner, is never used to continue the owner's run.
    await addKey(other.id, 'openai', ['intruder-model'])
    await failsWith(quota.resumeQuotaPausedRunOnApiKey(p.id, runId), 'apiKeyNotFound')
    assert.deepEqual(await threadQuotaView(other.id, [runId], runId), { switched: [], paused: null })
    const key = await addKey(p.id, 'openai', ['gpt-fixture'])
    assert.equal((await threadQuotaView(p.id, [runId], runId)).paused?.keyReady, true, 'the card offers 用 API Key 继续 once a key exists')
    const { runId: retryRunId } = await quota.resumeQuotaPausedRunOnApiKey(p.id, runId)
    assert.deepEqual(await threadQuotaView(p.id, [runId, retryRunId], retryRunId), {
      switched: [{ runId, subscription: 'codex', plan: null, key: { provider: 'openai', name: null, model: 'gpt-fixture' } }], paused: null,
    })
    assert.deepEqual(await quota.resumeQuotaPausedRunOnApiKey(p.id, runId), { runId: retryRunId }, 'idempotent')
    const original = await row(runId)
    assert.equal(original.status, 'failed')
    assert.equal(original.pauseReason, null)
    assert.equal(original.stopReason, 'quota_exhausted')
    const [continuation, ...more] = await continuations(runId)
    assert.equal(more.length, 0)
    assert.equal(continuation.id, retryRunId)
    assert.deepEqual(continuation.agentDefinition.apiKey, { keyId: key.id, model: 'gpt-fixture' })
    const switched = (await events(runId)).filter(event => event.kind === 'run_credential_switched')
    assert.equal(switched.length, 1)
    assert.deepEqual(switched[0].payload, {
      reason: 'quota_exhausted',
      from: { kind: 'subscription', provider: 'codex', connectionId: null },
      to: { kind: 'api_key', keyId: key.id, provider: 'openai', name: null, last4: key.last4, model: 'gpt-fixture' },
      retryRunId, resetsAt,
    })
    await failsWith(quota.retryQuotaPausedRun(p.id, retryRunId), 'runNotActive')
  })

  await t.test('automatic subscription quota fallback requires the same frozen model, regardless of the chat Key', async () => {
    const p = await person('quota-same-model')
    await subscribe(p)
    const runId = await running(p, 'claude_code', 'subscription-model')
    assert.deepEqual([(await row(runId)).agentDefinition.cliModelSelection, (await row(runId)).agentDefinition.model], ['explicit', 'subscription-model'], 'a local run is frozen with its model, never left to the CLI')
    const chatKey = await keys.addApiKey(pool, p.id, { provider: 'deepseek', apiKey: `fixture-chat-${randomUUID()}` }, { fetch: models(['deepseek-chat']) })
    await keys.setBotApiKeyChoice(pool, { ownerId: p.id, workspaceId: p.workspaceId }, p.botId, chatKey.id, 'deepseek-chat')
    await quotaEnd(p, runId, resetsAt)
    assert.equal((await row(runId)).status, 'paused', 'a different model cannot silently continue the thread')
    assert.equal((await continuations(runId)).length, 0)
    assert.equal((await threadQuotaView(p.id, [runId], runId)).paused?.keyReady, false)
    const same = await addKey(p.id, 'anthropic', ['subscription-model'])
    assert.equal((await threadQuotaView(p.id, [runId], runId)).paused?.keyReady, true)
    const retry = await quota.resumeQuotaPausedRunOnApiKey(p.id, runId)
    const frozen = (await row(retry.runId)).agentDefinition
    assert.deepEqual(frozen.apiKey, { keyId: same.id, model: 'subscription-model' })
    assert.equal(frozen.model, 'subscription-model')
    assert.notEqual(frozen.apiKey.keyId, chatKey.id)
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

    const readsBeforeRetry = resourceReads
    const { runId: retryRunId } = await quota.retryQuotaPausedRun(p.id, runId)
    assert.equal(resourceReads - readsBeforeRetry, 1, 'the device continuation validates its locked project placement once')
    assert.deepEqual(await quota.retryQuotaPausedRun(p.id, runId), { runId: retryRunId }, 'idempotent')
    assert.equal(resourceReads - readsBeforeRetry, 1, 'replaying the recorded child performs no new placement admission')
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
    const runId = await running(p, 'claude_code', 'key-model-a')
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

  /** A real admitted local run with the legacy absence of frozen identity. */
  const legacyPausedBotless = async (p: Person) => {
    const { binding } = await subscribe(p)
    const { runId } = await queueRun(p.id, { issueId: await task(p.id,p.workspaceId), agentId:p.agents.claude_code,
      repo:p.remote,model:'subscription-model',subscriptionBindingId:binding }, null)
    await pool.query(`UPDATE agent_runs SET status='paused',"pauseReason"='quota_exhausted',"stopReason"='quota_exhausted',
      "sessionId"=$2,"worktreePath"='/tmp/quota-tenant-fixture',"startedAt"=now(),"leaseExpiresAt"=NULL,
      "agentDefinition"="agentDefinition"-'executionIdentity' WHERE id=$1`,[runId,`session-${runId}`])
    return row(runId)
  }
  const quotaState = async (ownerId: string) => (await pool.query(`SELECT
    (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]') FROM agent_runs r WHERE r."userId"=$1) AS runs,
    (SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.id),'[]') FROM coordinator_events e WHERE e."userId"=$1) AS events,
    (SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY b."runId"),'[]') FROM computer_run_bindings b WHERE b."ownerId"=$1) AS bindings,
    (SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m."runId"),'[]') FROM thread_machines m WHERE m."ownerId"=$1) AS machines,
    (SELECT coalesce(jsonb_agg(jsonb_build_array(w.id,w.kind) ORDER BY w.id),'[]') FROM mikka_workspaces w WHERE w."userId"=$1) AS workspaces`,
  [ownerId])).rows[0]

  await t.test('a botless quota plan uses its persisted shared tenant without creating Personal', async () => {
    const p = await person('quota-shared-scope')
    const other = await seedWorkspace(pool,p.id,[{userId:p.id,role:'admin'}])
    const run = await legacyPausedBotless(p)
    assert.equal(run.workspaceId,p.workspaceId); assert.equal(run.botId,null)
    assert.notEqual(run.workspaceId,other.id)
    const before = await quotaState(p.id)
    const plan = await quota.planQuotaExhausted(pool,run)
    assert.ok(plan)
    assert.equal(plan.choiceWorkspaceId,p.workspaceId)
    assert.equal(plan.botWorkspaceId,null)
    assert.equal(plan.cloud,null)
    assert.deepEqual(await quotaState(p.id),before,'quota planning is read-only and never invents an owner-based tenant')
  })

  await t.test('a legacy botless continuation freezes the bound tenant and refuses a revoked member without effects', async () => {
    const p = await person('quota-legacy-tenant')
    const original = await legacyPausedBotless(p)
    assert.equal(original.agentDefinition.executionIdentity,undefined)
    const before = await quotaState(p.id)
    await pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2',[p.workspaceId,p.id])
    try {
      await failsWith(quota.retryQuotaPausedRun(p.id,original.id),'workspaceAccessDenied')
      assert.deepEqual(await quotaState(p.id),before,'failed fresh membership check rolls back the original and writes no continuation or event')
    } finally { await pool.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2',[p.workspaceId,p.id]) }
    const result = await quota.retryQuotaPausedRun(p.id,original.id)
    const next = await row(result.runId)
    assert.equal(next.workspaceId,p.workspaceId)
    assert.equal(next.issueId,original.issueId); assert.equal(next.botId,null)
    assert.equal(next.agentDefinition.executionIdentity.workspaceId,p.workspaceId)
    assert.equal(next.agentDefinition.subscription.bindingId,original.agentDefinition.subscription.bindingId)
    assert.equal(next.agentDefinition.apiKey,undefined)
    assert.deepEqual(await quota.retryQuotaPausedRun(p.id,original.id),result)
    assert.equal((await continuations(original.id)).length,1)
  })

  await t.test('unresolved runs and a foreign cloud binding cannot plan or retry quota work', async () => {
    const p = await person('quota-unresolved')
    const original = await legacyPausedBotless(p)
    const other = await seedWorkspace(pool,p.id,[{userId:p.id,role:'admin'}])
    const otherBot = await seedBot(pool,other.id,p.id)
    await pool.query('INSERT INTO computer_run_bindings ("runId","botId","workspaceId","ownerId") VALUES($1,$2,$3,$4)',
      [original.id,otherBot,other.id,p.id])
    const beforeForeign = await quotaState(p.id)
    try {
      assert.equal(await quota.planQuotaExhausted(pool,await row(original.id)),null)
      assert.equal(await quota.quotaKeyReady(pool,await row(original.id)),false)
      await failsWith(quota.retryQuotaPausedRun(p.id,original.id),'runInvalid')
      await failsWith(quota.queueCloudQuotaContinuation(original,{workspaceId:other.id,botId:otherBot},null),'executionAccountUnavailable')
      assert.deepEqual(await quotaState(p.id),beforeForeign)
    } finally { await pool.query('DELETE FROM computer_run_bindings WHERE "runId"=$1',[original.id]) }
    const unresolvedId = randomUUID()
    const definition = {...original.agentDefinition}
    delete definition.repositoryAdmission
    await pool.query(`INSERT INTO agent_runs(id,"userId","agentId","deviceId",status,"pauseReason","stopReason","agentDefinition")
      VALUES($1,$2,$3,$4,'paused','quota_exhausted','quota_exhausted',$5)`,
    [unresolvedId,p.id,p.agents.claude_code,p.deviceId,JSON.stringify(definition)])
    const unresolved = await row(unresolvedId)
    assert.equal(unresolved.workspaceId,null); assert.equal(unresolved.issueId,null); assert.equal(unresolved.botId,null)
    const beforeUnresolved = await quotaState(p.id)
    assert.equal(await quota.planQuotaExhausted(pool,unresolved),null)
    assert.equal(await quota.quotaKeyReady(pool,unresolved),false)
    await failsWith(quota.retryQuotaPausedRun(p.id,unresolvedId),'runInvalid')
    assert.deepEqual(await quotaState(p.id),beforeUnresolved,'pending provenance gains no Personal workspace, continuation or event')
  })

  const readerFor = async (p: Person) => {
    const sessionId = randomUUID()
    await pool.query(`INSERT INTO "session"(id,"userId",token,"expiresAt","createdAt","updatedAt")
      VALUES($1,$2,$3,now()+interval '30 minutes',now(),now())`, [sessionId,p.id,`quota-fixture-${randomUUID()}`])
    return { id:p.id,[tokenWorkspace]:p.workspaceId,[enterprisePrincipal]:{kind:'session' as const,sessionId} }
  }
  async function bounded<T>(work: Promise<T>, label: string, milliseconds = 5000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(label)),milliseconds)})]) }
    finally { if (timer) clearTimeout(timer) }
  }
  async function waitFor(check: () => boolean | Promise<boolean>, label: string) {
    const until = Date.now()+4000
    while (!await check()) {
      if (Date.now()>=until) throw new Error(label)
      await new Promise(resolve=>setTimeout(resolve,10))
    }
  }
  /** The real WS writer owns its only connection, then needs APP. A quota
   * operation waiting for WS must not retain APP and close the pool cycle. */
  async function behindWorkspaceWriter<T>(p: Person, begin: () => Promise<T>, between?: () => Promise<void>): Promise<T> {
    assert.equal(appPool.options.max,1); assert.equal(workspacePool.options.max,1)
    const writer = await workspacePool.connect()
    let work: Promise<T> | undefined
    try {
      await writer.query('BEGIN')
      await writer.query('UPDATE mikka_workspace_members SET role=role WHERE "workspaceId"=$1 AND "userId"=$2',[p.workspaceId,p.id])
      work = begin()
      void work.catch(()=>undefined)
      await Promise.race([
        waitFor(()=>workspacePool.waitingCount===1,'quota did not wait for the authoritative WS connection'),
        work.then(()=>{throw new Error('quota finished before the workspace writer released its lease')}),
      ])
      await bounded(appPool.query('SELECT 1 AS available'),'quota held APP while waiting for WS',2000)
      await between?.()
    } finally {
      await writer.query('ROLLBACK'); writer.release()
      if (work) await bounded(work.then(()=>undefined,()=>undefined),'quota did not settle after WS was released')
    }
    assert.ok(work)
    return work
  }

  await t.test('quota retry leaves APP available behind a real WS writer with one connection per pool', {timeout:15000}, async () => {
    const p = await person('quota-one-pool')
    const original = await legacyPausedBotless(p)
    const reader = await readerFor(p)
    const result = await behindWorkspaceWriter(p,()=>actAs(reader,()=>quota.retryQuotaPausedRun(p.id,original.id)))
    const child = await row(result.runId)
    assert.equal(child.workspaceId,p.workspaceId)
    assert.equal(child.agentDefinition.executionIdentity.workspaceId,p.workspaceId)
    assert.equal((await row(original.id)).status,'failed')
    assert.deepEqual(await actAs(reader,()=>quota.retryQuotaPausedRun(p.id,original.id)),result)
    assert.equal((await continuations(original.id)).length,1)
  })

  await t.test('quota retries borrow only the selected tenant and reject another tenant or an ambient APP owner without effects', {timeout:15000}, async () => {
    const p = await person('quota-selected-lease')
    const original = await legacyPausedBotless(p)
    const other = await seedWorkspace(pool,p.id,[{userId:p.id,role:'admin'}])
    const reader = await readerFor(p)
    const before = await quotaState(p.id)
    await failsWith(actAs({...reader,[tokenWorkspace]:other.id},()=>quota.retryQuotaPausedRun(p.id,original.id)),'runNotFound')
    assert.deepEqual(await quotaState(p.id),before)
    const { withDatabaseClient } = await import('../lib/db')
    const client = await appPool.connect()
    try {
      await client.query('BEGIN')
      await failsWith(withDatabaseClient(client,()=>actAs(reader,()=>quota.retryQuotaPausedRun(p.id,original.id))),'executionAccountUnavailable')
      await client.query('ROLLBACK')
    } finally { client.release() }
    assert.deepEqual(await quotaState(p.id),before)
    const result = await bounded(actAs(reader,()=>withTaskWorkspace(reader,p.workspaceId,()=>quota.retryQuotaPausedRun(p.id,original.id))),
      'an exact outer WS lease must be reused without a second checkout')
    assert.equal((await row(result.runId)).workspaceId,p.workspaceId)
    assert.equal((await continuations(original.id)).length,1)
  })

  await t.test('quota membership lease survives the real APP commit and blocks suspension until then', {timeout:20000}, async () => {
    const p = await person('quota-membership-commit')
    const original = await legacyPausedBotless(p)
    const reader = await readerFor(p)
    const appPid = Number((await appPool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
    const workspacePid = Number((await workspacePool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
    const blocker = await pool.connect(), revoker = await pool.connect()
    let resumed: Promise<{runId:string}> | undefined, suspended: Promise<unknown> | undefined
    try {
      await blocker.query('BEGIN')
      const blockerPid = Number((await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      await blocker.query('SELECT id FROM agent_runs WHERE id=$1 FOR UPDATE',[original.id])
      resumed = actAs(reader,()=>quota.retryQuotaPausedRun(p.id,original.id))
      void resumed.catch(()=>undefined)
      await waitFor(async()=>Boolean((await pool.query('SELECT $1::int=ANY(pg_blocking_pids($2)) AS blocked',[blockerPid,appPid])).rows[0].blocked),
        'quota never held WS while awaiting the source Run')
      await revoker.query('BEGIN')
      const revokerPid = Number((await revoker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      suspended = revoker.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2',[p.workspaceId,p.id])
      void suspended.catch(()=>undefined)
      await waitFor(async()=>Boolean((await pool.query('SELECT $1::int=ANY(pg_blocking_pids($2)) AS blocked',[workspacePid,revokerPid])).rows[0].blocked),
        'membership suspension was not blocked by the quota WS lease')
      await blocker.query('ROLLBACK')
      const result = await bounded(resumed,'quota did not commit after its Run lock was released')
      await bounded(suspended,'suspension did not resume after quota committed')
      await revoker.query('COMMIT')
      assert.equal((await row(result.runId)).workspaceId,p.workspaceId)
      assert.equal((await continuations(original.id)).length,1)
      const committed = await quotaState(p.id)
      await failsWith(actAs(reader,()=>quota.retryQuotaPausedRun(p.id,original.id)),'workspaceAccessDenied')
      assert.deepEqual(await quotaState(p.id),committed,'even an idempotent replay is denied after member suspension')
    } finally {
      await blocker.query('ROLLBACK')
      await revoker.query('ROLLBACK')
      blocker.release(); revoker.release()
      if (resumed) await bounded(resumed.then(()=>undefined,()=>undefined),'quota cleanup did not settle')
      if (suspended) await bounded(suspended.then(()=>undefined,()=>undefined),'membership cleanup did not settle')
      await pool.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2',[p.workspaceId,p.id])
    }
  })

  const pausedCloud = async (p: Person) => {
    await subscribe(p)
    // Cloud admission requires the requester's own runtime account even when
    // the test never starts a VM or calls the provider.
    const sealed = sealSecret('synthetic-quota-e2b-fixture', userE2bKeyAad(p.id))
    await pool.query('INSERT INTO user_e2b_keys ("userId",ciphertext,iv,"keyVersion",last4) VALUES ($1,$2,$3,$4,\'test\')',
      [p.id,sealed.ciphertext,sealed.iv,sealed.keyVersion])
    // Production metadata registration allocates no VM and makes no provider call.
    const { ensureBotCloudRuntime } = await import('../lib/computer/auto-runtime')
    const runtime = await ensureBotCloudRuntime(pool,{userId:p.id,workspaceId:p.workspaceId},p.botId,{harness:'claude_code',model:'subscription-model'})
    assert.ok(runtime)
    const target = (await pool.query('SELECT r."agentId",r."repoId",a."deviceId" FROM bot_cloud_runtimes r JOIN agents a ON a.id=r."agentId" WHERE r."botId"=$1 AND r.harness=\'claude_code\'',[p.botId])).rows[0]
    assert.ok(target)
    const { ensureDeviceRepository } = await import('../lib/device-repositories')
    const repository = await ensureDeviceRepository(p.id,target.deviceId,p.remote)
    const { queueCloudRun } = await import('../lib/computer/queue-run')
    const { runId } = await queueCloudRun(pool,{userId:p.id,workspaceId:p.workspaceId},{botId:p.botId,
      issueId:await task(p.id,p.workspaceId),agentId:target.agentId,deviceRepoId:repository.id,
      title:'Quota tenant continuation',body:'Synthetic metadata-only continuation.',model:'subscription-model',readOnly:true,withoutBot:true})
    await pool.query(`UPDATE agent_runs SET status='paused',"pauseReason"='quota_exhausted',"stopReason"='quota_exhausted',
      "sessionId"=$2,"startedAt"=now(),"leaseExpiresAt"=NULL WHERE id=$1`,[runId,`quota-cloud-${runId}`])
    const paused = await row(runId)
    assert.equal(paused.workspaceId,p.workspaceId)
    assert.equal(paused.agentDefinition.executionIdentity.workspaceId,p.workspaceId)
    assert.equal(paused.agentDefinition.executionIdentity.billingAccount.model.kind,'subscription')
    assert.deepEqual(paused.agentDefinition.executionIdentity.billingAccount.runtime,
      {kind:'e2b',ownerId:p.id,resourceId:p.id,amount:'provider_unknown'})
    return paused
  }

  await t.test('cloud quota queue waits for WS without retaining APP, freezes its persisted tenant and keeps one child', {timeout:20000}, async () => {
    const p = await person('quota-cloud-one-pool')
    const original = await pausedCloud(p)
    const reader = await readerFor(p), cloud = {workspaceId:p.workspaceId,botId:p.botId}
    let networkCalls = 0
    const network = t.mock.method(globalThis,'fetch',async()=>{networkCalls++;throw new Error('No provider call belongs in quota queue admission')})
    try {
      const childId = await behindWorkspaceWriter(p,()=>actAs(reader,()=>quota.queueCloudQuotaContinuation(original,cloud,null)))
      const child = await row(childId)
      assert.equal(child.workspaceId,p.workspaceId)
      assert.equal(child.agentDefinition.executionIdentity.workspaceId,p.workspaceId)
      assert.equal(child.retryOf,original.id); assert.equal(child.issueId,original.issueId); assert.equal(child.botId,null)
      assert.ok(child.prompt.includes('## This run continues after a usage limit'))
      assert.equal(threadPromptView(child.prompt,child.promptTaskStart,child.promptTaskLength).task.includes('## This run continues after a usage limit'),false)
      assert.equal(child.agentDefinition.subscription.bindingId,original.agentDefinition.subscription.bindingId)
      assert.equal(await bounded(actAs(reader,()=>withTaskWorkspace(reader,p.workspaceId,()=>quota.queueCloudQuotaContinuation(original,cloud,null))),
        'cloud retry failed to borrow the active WS lease'),childId)
      assert.equal((await continuations(original.id)).length,1)
      assert.equal(networkCalls,0,'this covers real PG admission, not a provider VM or model run')
    } finally { network.mock.restore() }
  })

  await t.test('cloud quota rereads changed binding after WS wait and denied automatic fallback writes no event', {timeout:20000}, async () => {
    const p = await person('quota-cloud-fresh-source')
    const original = await pausedCloud(p)
    const reader = await readerFor(p), cloud = {workspaceId:p.workspaceId,botId:p.botId}
    const other = await seedWorkspace(pool,p.id,[{userId:p.id,role:'admin'}])
    const otherBot = await seedBot(pool,other.id,p.id)
    const before = await quotaState(p.id)
    await failsWith(behindWorkspaceWriter(p,()=>actAs(reader,()=>quota.queueCloudQuotaContinuation(original,cloud,null)),
      ()=>pool.query('UPDATE computer_run_bindings SET "workspaceId"=$2,"botId"=$3 WHERE "runId"=$1',[original.id,other.id,otherBot]).then(()=>undefined)),
    'executionAccountUnavailable')
    assert.equal((await continuations(original.id)).length,0)
    assert.deepEqual(await events(original.id),[])
    await pool.query('UPDATE computer_run_bindings SET "workspaceId"=$2,"botId"=$3 WHERE "runId"=$1',[original.id,p.workspaceId,p.botId])
    assert.deepEqual(await quotaState(p.id),before,'the rejected queue changes no run or event; only the fixture changed its binding')
    await addKey(p.id,'anthropic',['subscription-model'])
    const plan = await quota.planQuotaExhausted(pool,await row(original.id))
    assert.ok(plan?.key && plan.cloud)
    const deniedState = await quotaState(p.id)
    await actAs({...reader,[tokenWorkspace]:other.id},()=>quota.continueCloudQuotaRun(original,plan,null))
    assert.deepEqual(await quotaState(p.id),deniedState,'the automatic catch path cannot bypass an explicit tenant denial')
    await pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2',[p.workspaceId,p.id])
    try {
      await actAs(reader,()=>quota.continueCloudQuotaRun(original,plan,null))
      assert.deepEqual(await quotaState(p.id),deniedState,'revoked membership writes neither a child nor a fallback notification')
    } finally { await pool.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2',[p.workspaceId,p.id]) }
  })

  await t.test('cloud quota remote repository preparation cannot commit the owner before final continuation validation', {timeout:15000}, async () => {
    const p = await person('quota-cloud-owner-rollback')
    const original = await pausedCloud(p), reader = await readerFor(p)
    const repository = (await pool.query('SELECT "remoteUrl" FROM device_repos WHERE id=$1',[original.deviceRepoId])).rows[0]
    assert.ok(repository.remoteUrl,'exercise the real ensureDeviceRepository branch inside the quota transaction')
    const before = await quotaState(p.id)
    const name = 'quota_owner_rollback_'+randomUUID().replaceAll('-','')
    await pool.query(`CREATE FUNCTION "${name}"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."retryOf"='${original.id}'::uuid THEN
          RAISE EXCEPTION 'synthetic final quota validation failure' USING ERRCODE='P0001';
        END IF;
        RETURN NEW;
      END $$`)
    try {
      await pool.query(`CREATE TRIGGER "${name}" BEFORE UPDATE OF "retryOf" ON agent_runs FOR EACH ROW EXECUTE FUNCTION "${name}"()`)
      await assert.rejects(actAs(reader,()=>quota.queueCloudQuotaContinuation(original,{workspaceId:p.workspaceId,botId:p.botId},null)),
        (error: unknown)=>{
          const cause = error instanceof Error && error.cause ? error.cause : error
          return !!cause && typeof cause==='object' && 'code' in cause && cause.code==='P0001'
        })
      assert.deepEqual(await quotaState(p.id),before,'run, binding, machine and notification writes must roll back together')
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS "${name}" ON agent_runs`)
      await pool.query(`DROP FUNCTION "${name}"()`)
    }
    const child = await actAs(reader,()=>quota.queueCloudQuotaContinuation(original,{workspaceId:p.workspaceId,botId:p.botId},null))
    assert.equal((await row(child)).workspaceId,p.workspaceId)
    assert.equal((await continuations(original.id)).length,1,'a clean retry creates the single continuation')
  })
})
