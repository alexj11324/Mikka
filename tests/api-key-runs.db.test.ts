// A person with only their own API key runs threads on Claude Code or Codex,
// on their own device and on a cloud computer: the run is frozen on the key
// by id at dispatch, and the key is opened only when the run is claimed.
// Real PostgreSQL, the real dispatch and claim route; only Next's `after`
// (no request scope in node:test) and the provider's model list are replaced.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mock, test } from 'node:test'
import { DAEMON_PROTOCOL_VERSION } from '@mikka/protocol/daemon'
import { MODEL_CREDENTIAL_HEADER, REPO_ORIGIN_HEADER } from '@mikka/protocol/device'
import { normalizeRepository } from '@mikka/protocol/repository'
import { dbUrl, seedBot, seedIssue, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('API-key runs: frozen by id at dispatch, opened only at claim, subscription first, withdrawn key refused', { skip: !dbUrl }, async t => {
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
  const { queueCloudRun } = await import('../lib/computer/queue-run')
  const { hashDeviceToken } = await import('../lib/device-link')
  const { threadModel } = await import('../lib/rule-dispatch')
  const { ExecutionSettings } = await import('../lib/execution-settings')
  const claimRoute = await import('../app/v1/devices/[deviceId]/runs/[runId]/claim/route')
  const users: string[] = []
  t.after(async () => {
    for (const [name, value] of [['WORKSPACE_SECRETS_KEY', saved.key], ['MIKKA_BYOS_ENABLED', saved.byos]] as const) if (value === undefined) delete process.env[name]; else process.env[name] = value
    await pool.query('DELETE FROM model_api_key_runs m USING agent_runs r WHERE r.id=m."runId" AND r."userId" = ANY($1)', [users])
    await pool.query('DELETE FROM byos_native_runs n USING agent_runs r WHERE r.id=n."runId" AND r."userId" = ANY($1)', [users])
    await pool.query('DELETE FROM computer_run_bindings WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM run_tokens t USING agent_runs r WHERE r.id=t."runId" AND r."userId" = ANY($1)', [users]).catch(() => undefined)
    await pool.query('DELETE FROM agent_runs WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM bot_model_choices WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM model_api_keys WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM byos_bindings WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM byos_connections WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM workspace_subscription_shares WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM bot_desktops WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM cloud_machines WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM device_tokens WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM agents WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM device_repos WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM devices WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM repository_settings WHERE "userId" = ANY($1)', [users])
    await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
  })

  const models = (ids: string[]) => (async () => Response.json({ data: ids.map(id => ({ id })) })) as unknown as typeof fetch
  const addKey = (ownerId: string, provider: 'anthropic' | 'openai', apiKey: string, listed: string[]) =>
    keys.addApiKey(pool, ownerId, { provider, apiKey }, { env: process.env, fetch: models(listed) })
  /** One task per run: a person has one unfinished run per task. */
  const task = async (ownerId: string) => {
    const issueId = await seedIssue(pool, ownerId)
    await pool.query(`UPDATE issues SET content=$2 WHERE id=$1`, [issueId, JSON.stringify({ type: 'doc', attrs: { mikka: { number: Math.floor(Math.random() * 1e6) + 1 } } })])
    return issueId
  }
  /** A person, their workspace and bot, a task, and their own device with Claude Code and Codex. */
  const person = async (label: string) => {
    const id = await seedUser(pool, label)
    users.push(id)
    const ws = await seedWorkspace(pool, id, [{ userId: id, role: 'admin' }])
    await pool.query('INSERT INTO workspace_subscription_shares ("ownerId","workspaceId") VALUES ($1,$2)', [id, ws.id])
    const botId = await seedBot(pool, ws.id, id)
    const issueId = await task(id)
    const remote = `https://github.com/mikka-ci/api-key-runs-${randomUUID()}.git`
    await pool.query('INSERT INTO repository_settings ("userId","remoteKey",push) VALUES ($1,$2,$3)', [id, normalizeRepository(remote).key, JSON.stringify({ approved: true, remote: 'origin', approvedByUserId: id, approvedAt: new Date().toISOString() })])
    const deviceId = randomUUID()
    await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,enabled,"protocolVersion","lastSeenAt",harnesses) VALUES ($1,$2,'Laptop','local',true,$3,now(),$4)`,
      [deviceId, id, DAEMON_PROTOCOL_VERSION, JSON.stringify([{ harness: 'claude_code', installed: true, toolApproval: true }, { harness: 'codex', installed: true, toolApproval: true }])])
    const agents: Record<'claude_code' | 'codex', string> = { claude_code: randomUUID(), codex: randomUUID() }
    for (const [harness, agentId] of Object.entries(agents)) await pool.query('INSERT INTO agents (id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,$4,$5)', [agentId, id, deviceId, harness, `${harness}-${agentId.slice(0, 8)}`])
    const token = `synthetic-${randomUUID()}`
    await pool.query('INSERT INTO device_tokens (id,"userId","tokenHash") VALUES ($1,$2,$3)', [randomUUID(), id, hashDeviceToken(token)])
    return { id, workspaceId: ws.id, botId, issueId, remote, deviceId, agents, token }
  }
  const definition = async (runId: string) => (await pool.query('SELECT "agentDefinition" FROM agent_runs WHERE id=$1', [runId])).rows[0].agentDefinition
  const claim = (deviceId: string, runId: string, token: string, credentialHeader = true) => claimRoute.POST(new Request(`http://127.0.0.1/v1/devices/${deviceId}/runs/${runId}/claim`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, [REPO_ORIGIN_HEADER]: '1', ...(credentialHeader ? { [MODEL_CREDENTIAL_HEADER]: '1' } : {}) },
  }), { params: Promise.resolve({ deviceId, runId }) })
  const recorded = async (runId: string) => (await pool.query('SELECT "keyId" FROM model_api_key_runs WHERE "runId"=$1', [runId])).rows[0]?.keyId ?? null
  /** A connected Claude subscription bound to the person's Claude Code Agent. */
  const subscribe = async (p: Awaited<ReturnType<typeof person>>) => {
    const connection = randomUUID()
    await pool.query(`INSERT INTO byos_connections (id,"ownerId","workspaceId",provider,state,epoch,"secretName","secretDigest","providerSubject") VALUES ($1,$2,$3,'claude','connected',1,$5,$4,'synthetic-subject')`, [connection, p.id, p.workspaceId, 'a'.repeat(64), `synthetic-${connection}`])
    const binding = randomUUID()
    await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES ($1,$2,$3,$4,$5,1,'claude_code_cli','subscription-model')`, [binding, p.id, p.workspaceId, p.agents.claude_code, connection])
    return { connection, binding }
  }

  await t.test('own device: an API-key-only person\'s run is frozen on the key by id; the claim opens it for that run', async () => {
    const p = await person('key-device')
    const secret = `sk-ant-${randomBytes(16).toString('hex')}`
    const key = await addKey(p.id, 'anthropic', secret, ['key-model-a', 'key-model-b'])
    const { runId } = await queueRun(p.id, { issueId: p.issueId, agentId: p.agents.claude_code, repo: p.remote }, p.botId)
    const frozen = await definition(runId)
    assert.deepEqual(frozen.apiKey, { keyId: key.id, model: 'key-model-a' }, 'the key\'s first listed model')
    assert.equal(frozen.subscription, undefined)
    assert.equal(frozen.modelSource, 'api_key')
    assert.equal(frozen.model, 'key-model-a')
    assert.ok(!JSON.stringify((await pool.query('SELECT * FROM agent_runs WHERE id=$1', [runId])).rows[0]).includes(secret), 'the run row holds the key id only')
    assert.equal(await recorded(runId), null, 'nothing is opened at dispatch')

    const old = await claim(p.deviceId, runId, p.token, false)
    assert.equal(old.status, 409)
    assert.equal((await old.json()).code, 'daemonUpgradeRequired', 'a daemon that cannot inject the key never gets the run')
    assert.equal((await pool.query('SELECT status FROM agent_runs WHERE id=$1', [runId])).rows[0].status, 'queued')
    assert.equal(await recorded(runId), null)

    const response = await claim(p.deviceId, runId, p.token)
    const text = await response.text()
    assert.equal(response.status, 200, text)
    const assignment = JSON.parse(text)
    assert.deepEqual(assignment.modelCredential, { kind: 'provider', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', key: secret })
    assert.equal(assignment.model, 'key-model-a')
    assert.equal(assignment.subscriptionBinding, undefined)
    assert.equal(await recorded(runId), key.id, 'recorded so withdrawing the key stops the run')
    await keys.removeApiKey(pool, p.id, key.id)
    assert.ok((await pool.query('SELECT "stopRequestedAt" FROM agent_runs WHERE id=$1', [runId])).rows[0].stopRequestedAt, 'the claimed run is stopped')
  })

  await t.test('own device on Codex: an OpenAI key runs on the Codex Agent with its provider', async () => {
    const p = await person('key-codex')
    const secret = `sk-${randomBytes(16).toString('hex')}`
    const key = await addKey(p.id, 'openai', secret, ['key-model-c'])
    const { runId } = await queueRun(p.id, { issueId: p.issueId, agentId: p.agents.codex, repo: p.remote }, p.botId)
    assert.deepEqual((await definition(runId)).apiKey, { keyId: key.id, model: 'key-model-c' })
    const response = await claim(p.deviceId, runId, p.token)
    assert.equal(response.status, 200, await response.clone().text())
    assert.deepEqual((await response.json()).modelCredential, { kind: 'provider', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', key: secret })
    // A Claude Code run has no key for it: nothing is frozen.
    const other = await queueRun(p.id, { issueId: await task(p.id), agentId: p.agents.claude_code, repo: p.remote }, p.botId)
    assert.equal((await definition(other.runId)).apiKey, undefined)
  })

  await t.test('a withdrawn key: the claim is refused, the run ends and nothing is handed out', async () => {
    const p = await person('key-withdrawn')
    const key = await addKey(p.id, 'anthropic', `sk-ant-${randomBytes(16).toString('hex')}`, ['key-model-a'])
    const { runId } = await queueRun(p.id, { issueId: p.issueId, agentId: p.agents.claude_code, repo: p.remote }, p.botId)
    assert.equal((await definition(runId)).apiKey.keyId, key.id)
    await keys.removeApiKey(pool, p.id, key.id)
    const response = await claim(p.deviceId, runId, p.token)
    assert.equal(response.status, 409)
    const body = await response.json()
    assert.equal(body.code, 'apiKeyUnavailable')
    assert.equal(body.modelCredential, undefined)
    const run = (await pool.query('SELECT status,"stopReason" FROM agent_runs WHERE id=$1', [runId])).rows[0]
    assert.notEqual(run.status, 'queued', 'the run does not wait for a key that is gone')
    assert.notEqual(run.status, 'preparing')
    assert.equal(await recorded(runId), null)
  })

  await t.test('subscription and key: the subscription goes first; a used-up quota or the bot\'s saved key model picks the key', async () => {
    const p = await person('key-and-subscription')
    const key = await addKey(p.id, 'anthropic', `sk-ant-${randomBytes(16).toString('hex')}`, ['key-model-a', 'subscription-model'])
    const { connection, binding } = await subscribe(p)
    const queue = async () => definition((await queueRun(p.id, { issueId: await task(p.id), agentId: p.agents.claude_code, repo: p.remote }, p.botId)).runId)
    const first = await queue()
    assert.equal(first.subscription?.bindingId, binding)
    assert.equal(first.apiKey, undefined)

    const resetsAt = new Date(Date.now() + 3_600_000).toISOString()
    await pool.query('UPDATE byos_connections SET quota=$2 WHERE id=$1', [connection, JSON.stringify({ vendor: 'claude_code', source: 'official', status: 'ok', plan: null, windows: [{ kind: 'five_hour', used: 1, resetsAt }], observedAt: new Date().toISOString() })])
    const exhausted = await queue()
    assert.equal(exhausted.subscription, undefined)
    assert.deepEqual(exhausted.apiKey, { keyId: key.id, model: 'key-model-a' }, '订阅额度用完后，自动改用 API Key (on by default)')
    await keys.setApiKeyAfterQuota(pool, p.id, false)
    assert.equal((await queue()).subscription?.bindingId, binding, 'switched off: the subscription stays')
    await pool.query('UPDATE byos_connections SET quota=NULL WHERE id=$1', [connection])

    await keys.setBotApiKeyChoice(pool, { ownerId: p.id, workspaceId: p.workspaceId }, p.botId, key.id, 'subscription-model')
    const chosen = await queue()
    assert.deepEqual(chosen.apiKey, { keyId: key.id, model: 'subscription-model' }, 'the bot\'s saved choice wins (§ 2)')
    assert.equal(chosen.subscription, undefined)
    const thread = await threadModel(new ExecutionSettings(pool), { ownerId: p.id, workspaceId: p.workspaceId }, p.botId)
    assert.deepEqual(thread, { model: 'subscription-model', subscription: false, apiKey: true, harness: 'claude_code' }, 'a saved API-key model is the thread\'s model, not Mikka 默认')
  })

  await t.test('cloud computer: queued with no subscription, the claim returns the key', async () => {
    const p = await person('key-cloud')
    const secret = `sk-ant-${randomBytes(16).toString('hex')}`
    const key = await addKey(p.id, 'anthropic', secret, ['key-model-a'])
    const cloudDevice = randomUUID(), agentId = randomUUID(), repoId = randomUUID()
    await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,enabled,harnesses) VALUES ($1,$2,'Cloud computer','cloud',true,$3)`,
      [cloudDevice, p.id, JSON.stringify([{ harness: 'claude_code', installed: true, toolApproval: true, subscriptionBroker: true, computerBroker: true }])])
    await pool.query(`INSERT INTO cloud_machines ("workspaceId","ownerId","operationId","sandboxId","deviceId",state,"runtimeReady") VALUES ($1,$2,$3,$4,$5,'running',true)`, [p.workspaceId, p.id, randomUUID(), `sbx-${randomUUID()}`, cloudDevice])
    await pool.query(`INSERT INTO bot_desktops ("botId","workspaceId","ownerId",display) VALUES ($1,$2,$3,1)`, [p.botId, p.workspaceId, p.id])
    await pool.query('INSERT INTO agents (id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,\'claude_code\',$4)', [agentId, p.id, cloudDevice, `cloud-${agentId.slice(0, 8)}`])
    await pool.query('INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl") VALUES ($1,$2,$3,$4,$5)', [repoId, cloudDevice, p.id, normalizeRepository(p.remote).key, p.remote])
    const token = `cloud-${randomUUID()}`
    await pool.query(`INSERT INTO device_tokens (id,"userId","tokenHash","boundDeviceId","boundWorkspaceId","expiresAt") VALUES ($1,$2,$3,$4,$5,now()+interval '1 hour')`, [randomUUID(), p.id, hashDeviceToken(token), cloudDevice, p.workspaceId])

    const { runId } = await queueCloudRun(pool, { userId: p.id, workspaceId: p.workspaceId }, { botId: p.botId, issueId: p.issueId, agentId, deviceRepoId: repoId, title: 'Task', body: '', model: 'auto' })
    const frozen = await definition(runId)
    assert.deepEqual(frozen.apiKey, { keyId: key.id, model: 'key-model-a' })
    assert.equal(frozen.subscription, undefined, 'no subscription is needed for a cloud run')
    assert.equal(await recorded(runId), null)

    const response = await claim(cloudDevice, runId, token)
    const text = await response.text()
    assert.equal(response.status, 200, text)
    const assignment = JSON.parse(text)
    assert.deepEqual(assignment.modelCredential, { kind: 'provider', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', key: secret })
    assert.equal(assignment.subscriptionBinding, undefined)
    assert.equal(assignment.computer.botId, p.botId)
    assert.equal(await recorded(runId), key.id)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM byos_native_runs WHERE "runId"=$1', [runId])).rows[0].n, 0)
  })
})
