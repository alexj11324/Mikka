// A person with only their own API key runs threads on Claude Code or Codex,
// on their own device and on a cloud computer: the run is frozen on the key
// by id at dispatch, and the key is opened only when the run is claimed.
// Real PostgreSQL, the real dispatch and claim route; only Next's `after`
// (no request scope in node:test) and the provider's model list are replaced.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { mock, test } from 'node:test'
import { DAEMON_PROTOCOL_VERSION } from '@mikka/protocol/daemon'
import { MODEL_CREDENTIAL_HEADER, REPO_ORIGIN_HEADER } from '@mikka/protocol/device'
import { normalizeRepository } from '@mikka/protocol/repository'
import { apiKeyHarnesses } from '../lib/model-api-key-providers'
import { dbUrl, seedBot, seedIssue, seedPersonalWorkspace, seedUser, seedWorkspace } from './support/workspace-admin-db'
import { recordPushGrant } from './support/github-app-stub'
import { sealSecret, userE2bKeyAad } from '../lib/secrets/crypto'
import { fakeThreadMachines } from './support/thread-machine-fake'

test('API-key runs: frozen by id at dispatch, opened only at claim, subscription first, withdrawn key refused', { skip: !dbUrl }, async t => {
  const saved = { key: process.env.WORKSPACE_SECRETS_KEY, byos: process.env.MIKKA_BYOS_ENABLED }
  process.env.WORKSPACE_SECRETS_KEY = randomBytes(32).toString('hex')
  process.env.MIKKA_BYOS_ENABLED = '1'
  delete process.env.MIKKA_CLOUD_COMPUTER_TASKS
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
  const claimRoute = await import('../app/v1/devices/[deviceId]/runs/[runId]/claim/route')
  const users: string[] = []
  t.after(async () => {
    for (const [name, value] of [['WORKSPACE_SECRETS_KEY', saved.key], ['MIKKA_BYOS_ENABLED', saved.byos]] as const) if (value === undefined) delete process.env[name]; else process.env[name] = value
    await pool.query('DELETE FROM model_api_key_runs m USING agent_runs r WHERE r.id=m."runId" AND r."userId" = ANY($1)', [users])
    await pool.query('DELETE FROM byos_native_runs n USING agent_runs r WHERE r.id=n."runId" AND r."userId" = ANY($1)', [users])
    await pool.query('DELETE FROM computer_run_bindings WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM thread_machines WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM run_tokens t USING agent_runs r WHERE r.id=t."runId" AND r."userId" = ANY($1)', [users]).catch(() => undefined)
    await pool.query('DELETE FROM agent_runs WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM bot_model_choices WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM model_api_keys WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM user_e2b_keys WHERE "userId" = ANY($1)', [users])
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
  const addKey = (ownerId: string, provider: 'anthropic' | 'openai' | 'deepseek', apiKey: string, listed: string[]) =>
    keys.addApiKey(pool, ownerId, { provider, apiKey }, { env: process.env, fetch: models(listed) })
  /** One task per run: a person has one unfinished run per task. */
  const task = async (ownerId: string, workspaceId: string) => {
    const issueId = await seedIssue(pool, ownerId, workspaceId)
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
    const issueId = await task(id, ws.id)
    const remote = `https://github.com/mikka-ci/api-key-runs-${randomUUID()}.git`
    // An installation row an earlier build recorded; admission no longer reads it (decision 2026-11-02-1600).
    await recordPushGrant(pool, id, normalizeRepository(remote).key)
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
    method: 'POST', headers: { 'x-mikka-client-version': '0.0.456', authorization: `Bearer ${token}`, [REPO_ORIGIN_HEADER]: '1', ...(credentialHeader ? { [MODEL_CREDENTIAL_HEADER]: '1' } : {}) },
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

  /** A worker on E2B's claude or codex template (no desktop), and one with the desktop's computer broker. */
  const taskMachine = [{ harness: 'claude_code', installed: true, toolApproval: true, subscriptionBroker: true }]
  const desktopMachine = [{ ...taskMachine[0], computerBroker: true }]
  /** The Bot's own computer, which dispatch queues against; each cloud thread then runs on its own thread machine. */
  const botComputer = async (p: Awaited<ReturnType<typeof person>>) => {
    const cloudDevice = randomUUID(), agentId = randomUUID(), repoId = randomUUID()
    const sealed = sealSecret('synthetic-e2b-fixture', userE2bKeyAad(p.id))
    await pool.query('INSERT INTO user_e2b_keys("userId",ciphertext,iv,"keyVersion",last4) VALUES($1,$2,$3,$4,\'test\') ON CONFLICT DO NOTHING', [p.id, sealed.ciphertext, sealed.iv, sealed.keyVersion])
    await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,enabled,harnesses) VALUES ($1,$2,'Cloud computer','cloud',true,$3)`, [cloudDevice, p.id, JSON.stringify(desktopMachine)])
    await pool.query(`INSERT INTO cloud_machines ("workspaceId","ownerId","operationId","sandboxId","deviceId",state,"runtimeReady") VALUES ($1,$2,$3,$4,$5,'running',true)`, [p.workspaceId, p.id, randomUUID(), `sbx-${randomUUID()}`, cloudDevice])
    await pool.query(`INSERT INTO bot_desktops ("botId","workspaceId","ownerId",display) VALUES ($1,$2,$3,1)`, [p.botId, p.workspaceId, p.id])
    await pool.query('INSERT INTO agents (id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,\'claude_code\',$4)', [agentId, p.id, cloudDevice, `cloud-${agentId.slice(0, 8)}`])
    await pool.query('INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl") VALUES ($1,$2,$3,$4,$5)', [repoId, cloudDevice, p.id, normalizeRepository(p.remote).key, p.remote])
    await pool.query('INSERT INTO bot_cloud_runtimes ("botId","ownerId","workspaceId",harness,"agentId","repoId") VALUES ($1,$2,$3,\'claude_code\',$4,$5)', [p.botId,p.id,p.workspaceId,agentId,repoId])
    return { cloudDevice, agentId, repoId }
  }

  await t.test('bot-less shared tasks freeze their own tenant and survive personal Coordinator backfill', async () => {
    const p = await person('task-tenant')
    const personal = await seedPersonalWorkspace(pool, p.id)
    await pool.query('update mikka_workspaces set "createdAt"=\'2000-01-01\' where id=$1', [personal])
    const { runId } = await queueRun(p.id, { issueId: p.issueId, agentId: p.agents.claude_code, repo: p.remote,
      model: 'fixture-model', modelDispatch: { mode: 'preference', location: 'local' } })
    const frozen = await definition(runId)
    assert.equal(frozen.executionIdentity.workspaceId, p.workspaceId)
    assert.equal(frozen.executionIdentity.botId, null)
    assert.equal((await pool.query('select "workspaceId" from agent_runs where id=$1', [runId])).rows[0].workspaceId, p.workspaceId)
    const { runId: personalRun } = await queueRun(p.id, { issueId: await task(p.id, personal), agentId: p.agents.claude_code, repo: p.remote,
      model: 'fixture-model', modelDispatch: { mode: 'picked', location: 'local' } })
    const personalFrozen = await definition(personalRun)
    const coordinator = await import('../lib/coordinator/coordinator-bot')
    const personalBot = await coordinator.coordinatorBot(p.id, personal, { backfill: false })
    await coordinator.backfillCoordinatorChat(pool, p.id, personalBot)
    assert.deepEqual(await definition(runId), frozen)
    assert.deepEqual(await definition(personalRun), personalFrozen)
    const rows = (await pool.query('select "botId","workspaceId" from agent_runs where id=any($1::uuid[])', [[runId, personalRun]])).rows
    assert.ok(rows.every(row => row.botId === null), 'backfill never rewrites a frozen execution identity, even in its own tenant')
    assert.deepEqual(new Set(rows.map(row => row.workspaceId)), new Set([p.workspaceId, personal]))
    await assert.rejects(pool.query(`update agent_runs set "agentDefinition"=jsonb_set("agentDefinition",'{executionIdentity,workspaceId}',to_jsonb($2::text)) where id=$1`, [runId, personal]), /taskWorkspaceMismatch/)
    const foreignBot = await seedBot(pool, personal, p.id)
    await assert.rejects(queueRun(p.id, { issueId: p.issueId, agentId: p.agents.claude_code, repo: p.remote, model: 'fixture-model' }, foreignBot), { code: 'runInvalid' })
    assert.equal((await pool.query('select count(*)::int as n from agent_runs where "userId"=$1', [p.id])).rows[0].n, 2)
    const accepted = await claim(p.deviceId, runId, p.token)
    assert.equal(accepted.status, 200, await accepted.text())
  })

  await t.test('own device: a bot saved on a key model is frozen on the key by id; the claim opens it for that run', async () => {
    const p = await person('key-device')
    const secret = `sk-ant-${randomBytes(16).toString('hex')}`
    const key = await addKey(p.id, 'anthropic', secret, ['key-model-a', 'key-model-b'])
    await keys.setBotApiKeyChoice(pool, { ownerId: p.id, workspaceId: p.workspaceId }, p.botId, key.id, 'key-model-a')
    const { runId } = await queueRun(p.id, { issueId: p.issueId, agentId: p.agents.claude_code, repo: p.remote, model: 'key-model-a' }, p.botId)
    const frozen = await definition(runId)
    assert.deepEqual(frozen.apiKey, { keyId: key.id, model: 'key-model-a' }, 'the bot\'s saved key model')
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
    await keys.setBotApiKeyChoice(pool, { ownerId: p.id, workspaceId: p.workspaceId }, p.botId, key.id, 'key-model-c')
    const { runId } = await queueRun(p.id, { issueId: p.issueId, agentId: p.agents.codex, repo: p.remote, model: 'key-model-c' }, p.botId)
    assert.deepEqual((await definition(runId)).apiKey, { keyId: key.id, model: 'key-model-c' })
    const response = await claim(p.deviceId, runId, p.token)
    assert.equal(response.status, 200, await response.clone().text())
    assert.deepEqual((await response.json()).modelCredential, { kind: 'provider', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', key: secret })
    // A Claude Code run: the saved key is Codex's, so the device's own login runs it.
    const other = await queueRun(p.id, { issueId: await task(p.id, p.workspaceId), agentId: p.agents.claude_code, repo: p.remote, model: 'key-model-c' }, p.botId)
    assert.equal((await definition(other.runId)).apiKey, undefined)
  })

  await t.test('own device signed in, a key stored, no key model saved: the key is not injected', async () => {
    const p = await person('key-local-login')
    const secret = `sk-ant-${randomBytes(16).toString('hex')}`
    await addKey(p.id, 'anthropic', secret, ['key-model-a'])
    const { runId } = await queueRun(p.id, { issueId: p.issueId, agentId: p.agents.claude_code, repo: p.remote, model: 'login-model' }, p.botId)
    const frozen = await definition(runId)
    assert.equal(frozen.apiKey, undefined, 'frozen on the device\'s own login')
    assert.notEqual(frozen.modelSource, 'api_key')
    const response = await claim(p.deviceId, runId, p.token)
    const text = await response.text()
    assert.equal(response.status, 200, text)
    const assignment = JSON.parse(text)
    assert.equal(assignment.modelCredential, undefined, 'no key handed to the device')
    assert.ok(!text.includes(secret))
    assert.equal(await recorded(runId), null, 'the key was never opened')
  })

  await t.test('a withdrawn key: the claim is refused, the run ends and nothing is handed out', async () => {
    const p = await person('key-withdrawn')
    const key = await addKey(p.id, 'anthropic', `sk-ant-${randomBytes(16).toString('hex')}`, ['key-model-a'])
    await keys.setBotApiKeyChoice(pool, { ownerId: p.id, workspaceId: p.workspaceId }, p.botId, key.id, 'key-model-a')
    const { runId } = await queueRun(p.id, { issueId: p.issueId, agentId: p.agents.claude_code, repo: p.remote, model: 'key-model-a' }, p.botId)
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

  await t.test('subscription and key on a device: the subscription goes first, also when used up; the bot\'s saved key model picks the key', async () => {
    const p = await person('key-and-subscription')
    const key = await addKey(p.id, 'anthropic', `sk-ant-${randomBytes(16).toString('hex')}`, ['key-model-a', 'subscription-model'])
    const { connection, binding } = await subscribe(p)
    // The run names its model; the subscription lists it, as a connected account does.
    await pool.query('UPDATE byos_connections SET "modelCatalog"=$2 WHERE id=$1', [connection, JSON.stringify({ revision: '1', models: ['subscription-model'] })])
    const queue = async () => definition((await queueRun(p.id, { issueId: await task(p.id, p.workspaceId), agentId: p.agents.claude_code, repo: p.remote, model: 'subscription-model' }, p.botId)).runId)
    const first = await queue()
    assert.equal(first.subscription?.bindingId, binding)
    assert.equal(first.apiKey, undefined)

    const resetsAt = new Date(Date.now() + 3_600_000).toISOString()
    await pool.query('UPDATE byos_connections SET quota=$2 WHERE id=$1', [connection, JSON.stringify({ vendor: 'claude_code', source: 'official', status: 'ok', plan: null, windows: [{ kind: 'five_hour', used: 1, resetsAt }], observedAt: new Date().toISOString() })])
    const exhausted = await queue()
    assert.equal(exhausted.subscription?.bindingId, binding, 'on a device the CLI login stays: a stored key is not turned into per-token billing')
    assert.equal(exhausted.apiKey, undefined)
    await pool.query('UPDATE byos_connections SET quota=NULL WHERE id=$1', [connection])

    await keys.setBotApiKeyChoice(pool, { ownerId: p.id, workspaceId: p.workspaceId }, p.botId, key.id, 'subscription-model')
    // The dispatcher names the saved key with the model, as dispatch_run does from 优先使用的模型.
    const chosen = definition((await queueRun(p.id, { issueId: await task(p.id, p.workspaceId), agentId: p.agents.claude_code, repo: p.remote, model: 'subscription-model', apiKeyId: key.id }, p.botId)).runId)
    assert.deepEqual((await chosen).apiKey, { keyId: key.id, model: 'subscription-model' }, 'the bot\'s saved choice wins (§ 2)')
    assert.equal((await chosen).subscription, undefined)
  })

  await t.test('a rule\'s model only an API key lists runs on that key, beside a usable subscription; one the subscription lists stays on it', async () => {
    const p = await person('key-rule-model')
    const key = await addKey(p.id, 'anthropic', `sk-ant-${randomBytes(16).toString('hex')}`, ['key-only-model', 'shared-model'])
    const { connection } = await subscribe(p)
    await pool.query('UPDATE byos_connections SET "modelCatalog"=$2 WHERE id=$1', [connection, JSON.stringify({ revision: '1', models: ['subscription-model', 'shared-model'] })])
    const queue = async (model: string) => {
      if (model !== 'key-only-model') await (await import('../lib/model-dispatch')).bindAgentToConnection(pool, { ownerId: p.id, workspaceId: p.workspaceId }, p.agents.claude_code, 'claude_code', connection, model)
      return definition((await queueRun(p.id, { issueId: await task(p.id, p.workspaceId), agentId: p.agents.claude_code, repo: p.remote, model }, p.botId)).runId)
    }
    const keyed = await queue('key-only-model')
    assert.deepEqual(keyed.apiKey, { keyId: key.id, model: 'key-only-model' }, 'a model the subscription does not offer is never asked of it')
    assert.equal(keyed.subscription, undefined)
    for (const model of ['shared-model', 'subscription-model']) {
      const kept = await queue(model)
      assert.equal(kept.subscription?.modelId, model, `${model}: the selected subscription model stays frozen`)
      assert.equal(kept.apiKey, undefined)
    }
  })

  await t.test('explicit thread model and key remain independent of the Bot chat preference on device and cloud', async () => {
    const p = await person('chat-thread-choice')
    const { connection, binding } = await subscribe(p)
    await pool.query('UPDATE byos_connections SET "modelCatalog"=$2 WHERE id=$1', [connection, JSON.stringify({ revision: '1', models: ['subscription-model'] })])
    const chatKey = await keys.addApiKey(pool, p.id, { provider: 'deepseek', apiKey: `fixture-chat-${randomUUID()}` }, { fetch: models(['deepseek-chat']) })
    const threadKey = await addKey(p.id, 'anthropic', `fixture-thread-${randomUUID()}`, ['subscription-model'])
    await keys.setBotApiKeyChoice(pool, { ownerId: p.id, workspaceId: p.workspaceId }, p.botId, chatKey.id, 'deepseek-chat')
    const { agentId, repoId } = await botComputer(p)
    const cloudBinding = randomUUID()
    await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId")
      VALUES ($1,$2,$3,$4,$5,1,'claude_code_cli','subscription-model')`, [cloudBinding, p.id, p.workspaceId, agentId, connection])
    for (const cloud of [false, true]) for (const useKey of [false, true]) {
      const issueId = await task(p.id, p.workspaceId)
      const run = cloud
        ? await queueCloudRun(pool, { userId: p.id, workspaceId: p.workspaceId }, { botId: p.botId, issueId, agentId, deviceRepoId: repoId, title: 'Explicit source', body: '', model: 'subscription-model', ...(useKey ? { apiKeyId: threadKey.id } : {}) })
        : await queueRun(p.id, { issueId, agentId: p.agents.claude_code, repo: p.remote, model: 'subscription-model', ...(useKey ? { apiKeyId: threadKey.id } : {}) }, p.botId)
      const frozen = await definition(run.runId)
      assert.equal(frozen.model, 'subscription-model', `${cloud ? 'cloud' : 'device'} keeps the explicit thread model`)
      if (useKey) {
        assert.deepEqual(frozen.apiKey, { keyId: threadKey.id, model: 'subscription-model' })
        assert.equal(frozen.subscription, undefined)
      } else {
        assert.equal(frozen.subscription?.bindingId, cloud ? cloudBinding : binding)
        assert.equal(frozen.apiKey, undefined)
      }
      assert.notEqual(frozen.apiKey?.keyId, chatKey.id)
    }
  })

  await t.test('a reported CLI slot cannot replace the provider model from resolver through queue and native launch', { timeout: 20_000 }, async () => {
    const p = await person('canonical-native-model')
    const providerModel = 'claude-opus-fixture'
    const { connection, binding } = await subscribe(p)
    process.env.MIKKA_BYOS_VALIDATED_MODEL_ROUTES = 'claude_cpa,codex_cpa'
    const quota = { vendor: 'claude_code', source: 'official', status: 'ok', plan: 'Max', observedAt: new Date().toISOString(), windows: [{ kind: 'five_hour', used: .2, resetsAt: null }] }
    await pool.query('UPDATE byos_connections SET "modelCatalog"=$2,quota=$3 WHERE id=$1', [connection, JSON.stringify({ revision: '1', models: [providerModel] }), JSON.stringify(quota)])
    await pool.query('UPDATE byos_bindings SET "modelId"=$2 WHERE id=$1', [binding, providerModel])
    await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES ($1,$2,$3,$6,$4,1,'claude_cpa',$5)`, [randomUUID(), p.id, p.workspaceId, connection, providerModel, randomUUID()])
    await pool.query('UPDATE devices SET harnesses=$2 WHERE id=$1', [p.deviceId, JSON.stringify([{ harness: 'claude_code', installed: true, toolApproval: true, subscriptionBroker: true, modelSlots: [{ slot: 'opus', model: providerModel, name: 'Opus' }] }])])
    const { resolveModelDispatch } = await import('../lib/model-dispatch')
    const target = await resolveModelDispatch(pool, { ownerId: p.id, workspaceId: p.workspaceId, botId: p.botId }, { harness: 'claude_code', model: providerModel })
    assert.equal(target.kind, 'device')
    if (target.kind !== 'device') throw Error('fixture dispatch failed')
    assert.equal(target.model, providerModel)
    const queued = await queueRun(p.id, { issueId: p.issueId, agentId: target.agentId, repo: p.remote, model: target.model, subscriptionBindingId: target.subscriptionBindingId, readOnly: true }, p.botId)
    const frozen = await definition(queued.runId)
    assert.equal(frozen.model, providerModel)
    assert.equal(frozen.model, frozen.subscription.modelId)
    const root = mkdtempSync(join(tmpdir(), 'mikka-native-model-'))
    try {
      execFileSync('git', ['init', '-q', root])
      const output = execFileSync(process.execPath, ['--import', 'tsx', resolve('tests/support/subscription-native-model.mjs'), root, JSON.stringify({
        runId: queued.runId, deviceId: target.deviceId, model: frozen.model, subscription: frozen.subscription,
        binding: { bindingId: frozen.subscription.bindingId, ownerId: p.id, workspaceId: p.workspaceId, consumerId: target.agentId, route: 'claude_code_cli' },
      })], { encoding: 'utf8', timeout: 15_000 })
      assert.deepEqual(JSON.parse(output), { model: providerModel, leaseReads: 1, outcome: 'succeeded' }, 'the actual native CLI configuration must match the provider model in its lease')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  for (const cloud of [false, true]) await t.test(`${cloud ? 'cloud' : 'local'} freezes the selected binding despite another task rebinding the same Agent`, async () => {
    const p = await person('exact-subscription')
    const first = await subscribe(p)
    await pool.query('UPDATE byos_connections SET "providerSubject"=$2 WHERE id=$1', [first.connection, `synthetic-${first.connection}`])
    const second = await subscribe(p)
    const runtime = cloud ? await botComputer(p) : { agentId: p.agents.claude_code, repoId: '' }
    const { bindAgentToConnection } = await import('../lib/model-dispatch')
    const scope = { ownerId: p.id, workspaceId: p.workspaceId }
    const readLatest = async () => (await pool.query('SELECT id FROM byos_bindings WHERE "consumerId"=$1 ORDER BY "createdAt" DESC,id DESC LIMIT 1', [runtime.agentId])).rows[0].id as string
    // Deterministic interleaving: task A chooses account 1, task B chooses account 2, then A queues.
    const selectedA = await bindAgentToConnection(pool, scope, runtime.agentId, 'claude_code', first.connection, 'subscription-model')
    const bindingA = await readLatest()
    await bindAgentToConnection(pool, scope, runtime.agentId, 'claude_code', second.connection, 'subscription-model')
    const bindingB = await readLatest()
    assert.notEqual(bindingA, bindingB)
    const issueId = await task(p.id, p.workspaceId), requestKey = `binding-race:${randomUUID()}`
    const queue = (subscriptionBindingId: string, key = requestKey, issue = issueId) => cloud
      ? queueCloudRun(pool, { userId: p.id, workspaceId: p.workspaceId }, { botId: p.botId, issueId: issue, agentId: runtime.agentId, deviceRepoId: runtime.repoId, title: 'Read', body: '', model: 'subscription-model', subscriptionBindingId, readOnly: true, idempotencyKey: key })
      : queueRun(p.id, { issueId: issue, agentId: runtime.agentId, repo: p.remote, model: 'subscription-model', subscriptionBindingId, readOnly: true, requestKey: key }, p.botId)
    const queued = await queue(bindingA)
    assert.equal((await definition(queued.runId)).subscription?.bindingId, bindingA, 'task A must freeze the account it selected, not task B’s latest binding')
    assert.equal(selectedA, bindingA, 'the binding returned to the dispatcher is the exact frozen identity')
    assert.equal((await queue(bindingA)).runId, queued.runId)
    await assert.rejects(queue(bindingB), cloud ? { status: 409 } : { code: 'runDispatchKeyConflict' }, 'the same request key cannot acquire a different subscription')
    assert.equal((await definition(queued.runId)).subscription?.bindingId, bindingA)
    const stranger = await person('foreign-binding')
    const foreign = await subscribe(stranger)
    await assert.rejects(queue(foreign.binding, `foreign:${randomUUID()}`, await task(p.id, p.workspaceId)), cloud ? { status: 409 } : { code: 'executionAccountUnavailable' }, 'an id never grants access to another Agent or owner’s subscription')
  })

  await t.test('cloud queue refuses a key withdrawn after preflight even when another key serves the same model', async () => {
    const p = await person('key-withdrawn-before-cloud-queue')
    const selected = await addKey(p.id, 'anthropic', `sk-ant-${randomBytes(16).toString('hex')}`, ['key-model-a'])
    // A preset replaces the owner's existing key. Use another preset that
    // also serves Claude Code; the model list remains this test's fake fetch.
    const other = await addKey(p.id, 'deepseek', `sk-${randomBytes(16).toString('hex')}`, ['key-model-a'])
    assert.notEqual(selected.id, other.id)
    for (const key of [selected, other]) {
      assert.ok(apiKeyHarnesses(key).includes('claude_code'))
      assert.ok(key.models.includes('key-model-a'))
    }
    const { agentId, repoId } = await botComputer(p)
    const { runCredentialSource } = await import('../lib/run-credential-source')
    const selection = { ownerId: p.id, botId: p.botId, harness: 'claude_code', model: 'key-model-a', keyId: selected.id, botWorkspaceId: p.workspaceId, choiceWorkspaceId: p.workspaceId, subscription: null }
    assert.deepEqual((await runCredentialSource(pool, selection)).apiKey, { keyId: selected.id, model: 'key-model-a' })
    // Deterministic interleaving: preflight chooses A, the owner withdraws A
    // during wake, then the real queue reauthorizes with usable key B present.
    await keys.removeApiKey(pool, p.id, selected.id)
    assert.deepEqual((await runCredentialSource(pool, selection)).apiKey, { keyId: other.id, model: 'key-model-a' })
    const snapshot = async () => (await pool.query(`SELECT
      (SELECT count(*) FROM agent_runs WHERE "userId"=$1) AS runs,
      (SELECT count(*) FROM computer_run_bindings WHERE "ownerId"=$1) AS bindings,
      (SELECT count(*) FROM thread_machines WHERE "ownerId"=$1) AS machines,
      (SELECT count(*) FROM run_publications WHERE "userId"=$1) AS publications`, [p.id])).rows[0]
    const before = await snapshot()
    await assert.rejects(queueCloudRun(pool, { userId: p.id, workspaceId: p.workspaceId }, {
      botId: p.botId, issueId: p.issueId, agentId, deviceRepoId: repoId, title: 'Keep selected key', body: '', model: 'key-model-a', apiKeyId: selected.id, readOnly: true,
    }), { status: 409 })
    assert.deepEqual(await snapshot(), before, 'a refused credential creates no run, binding, task machine or publication')
  })

  await t.test('cloud computer: queued with no subscription, the claim returns the key', async () => {
    const p = await person('key-cloud')
    const secret = `sk-ant-${randomBytes(16).toString('hex')}`
    const key = await addKey(p.id, 'anthropic', secret, ['key-model-a'])
    const { cloudDevice, agentId, repoId } = await botComputer(p)

    const { runId } = await queueCloudRun(pool, { userId: p.id, workspaceId: p.workspaceId }, { botId: p.botId, issueId: p.issueId, agentId, deviceRepoId: repoId, title: 'Task', body: '', model: 'key-model-a' })
    const frozen = await definition(runId)
    assert.deepEqual(frozen.apiKey, { keyId: key.id, model: 'key-model-a' })
    assert.equal(frozen.subscription, undefined, 'no subscription is needed for a cloud run')
    assert.equal(await recorded(runId), null)

    // The run's own thread machine, with a desktop, takes it; the Bot's computer never does.
    const machines = await fakeThreadMachines(pool, desktopMachine)
    const thread = await machines.start({ userId: p.id, workspaceId: p.workspaceId }, runId).finally(() => machines.restore())
    assert.notEqual(thread.deviceId, cloudDevice)
    const response = await claim(thread.deviceId, runId, thread.token)
    const text = await response.text()
    assert.equal(response.status, 200, text)
    const assignment = JSON.parse(text)
    assert.deepEqual(assignment.modelCredential, { kind: 'provider', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', key: secret })
    assert.equal(assignment.subscriptionBinding, undefined)
    assert.equal(assignment.computer.botId, p.botId)
    assert.equal(await recorded(runId), key.id)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM byos_native_runs WHERE "runId"=$1', [runId])).rows[0].n, 0)
  })

  await t.test('read-only cloud file checks get a credential without an unusable interactive desktop grant', async () => {
    for (const denyComputer of [false, true]) {
      const p = await person('readonly-cloud-files'), secret = `sk-ant-${randomBytes(16).toString('hex')}`
      await addKey(p.id, 'anthropic', secret, ['key-model-a'])
      const { cloudDevice, agentId } = await botComputer(p)
      const computerRepo = randomUUID(), actor = { userId:p.id, workspaceId:p.workspaceId }
      await pool.query('INSERT INTO device_repos (id,"deviceId","userId","repoPath") VALUES ($1,$2,$3,$4)', [computerRepo, cloudDevice, p.id, '/home/user/.mikka/bot-workspaces/fixture'])
      await pool.query('UPDATE bot_cloud_runtimes SET "repoId"=$2 WHERE "botId"=$1', [p.botId,computerRepo])
      const { runId } = await queueCloudRun(pool, actor, { botId:p.botId, issueId:p.issueId, agentId, deviceRepoId:computerRepo, title:'Inspect files', body:'Read the delivery only', model:'key-model-a', readOnly:true })
      const machines = await fakeThreadMachines(pool, desktopMachine)
      const thread = await machines.start(actor,runId).finally(() => machines.restore())
      if (denyComputer) await pool.query(`INSERT INTO workspace_computer_policies ("workspaceId",permission,version) VALUES ($1,'deny',3)`, [p.workspaceId])
      const response = await claim(thread.deviceId,runId,thread.token), text = await response.text()
      assert.equal(response.status,200,text)
      const assignment = JSON.parse(text)
      assert.equal(assignment.modelCredential.key,secret)
      assert.equal(assignment.policy.readOnly,true)
      assert.equal(assignment.policy.permissions.computer_use,'deny')
      assert.equal(assignment.computer,undefined,'the hosted runner rejects a computer envelope whose read-only policy cannot obtain a broker grant')
      assert.equal((await pool.query('SELECT status FROM agent_runs WHERE id=$1',[runId])).rows[0].status,'preparing')
    }
  })

  await t.test('task machine without a desktop: the claim succeeds and hands out no desktop', async () => {
    // A worker on E2B's claude or codex template reports its harness with no computer broker.
    const p = await person('key-task-machine')
    const secret = `sk-ant-${randomBytes(16).toString('hex')}`
    await addKey(p.id, 'anthropic', secret, ['key-model-a'])
    const { cloudDevice, agentId, repoId } = await botComputer(p)
    const actor = { userId: p.id, workspaceId: p.workspaceId }
    const queue = (deviceRepoId: string) => queueCloudRun(pool, actor, { botId: p.botId, issueId: p.issueId, agentId, deviceRepoId, title: 'Task', body: '', model: 'key-model-a' })
    const status = async (id: string) => (await pool.query('SELECT status FROM agent_runs WHERE id=$1', [id])).rows[0].status
    const machines = await fakeThreadMachines(pool, taskMachine)
    try {
      // A computer task (no remote) needs a desktop: refused at claim, the run stays queued.
      const computerRepo = randomUUID()
      await pool.query('INSERT INTO device_repos (id,"deviceId","userId","repoPath") VALUES ($1,$2,$3,$4)', [computerRepo, cloudDevice, p.id, '/home/user/.mikka/bot-workspaces/fixture'])
      await pool.query('UPDATE bot_cloud_runtimes SET "repoId"=$2 WHERE "botId"=$1', [p.botId,computerRepo])
      const computerRun = (await queue(computerRepo)).runId
      const computerThread = await machines.start(actor, computerRun)
      const refused = await claim(computerThread.deviceId, computerRun, computerThread.token)
      assert.equal(refused.status, 409, await refused.text())
      assert.equal(await status(computerRun), 'queued')
      await pool.query("UPDATE agent_runs SET status='cancelled' WHERE id=$1", [computerRun])
      await machines.park(actor, computerRun)

      // A person holding the Bot's desktop does not hold a run on a machine without one.
      await pool.query(`UPDATE bot_desktops SET control='user',"controlledBy"=$2,"controlUntil"=now()+interval '5 minutes' WHERE "botId"=$1`, [p.botId, p.id])
      const { runId } = await queue(repoId)
      const thread = await machines.start(actor, runId)
      const response = await claim(thread.deviceId, runId, thread.token)
      const text = await response.text()
      assert.equal(response.status, 200, text)
      const assignment = JSON.parse(text)
      assert.equal(assignment.modelCredential.key, secret)
      assert.equal(assignment.computer, undefined, 'a machine with no desktop gets no desktop')
      assert.equal(await status(runId), 'preparing')

      // Nor a computer task on its own thread machine's desktop: it is claimed with that desktop.
      const desktopRun = (await queueCloudRun(pool, actor, { botId: p.botId, issueId: await task(p.id, p.workspaceId), agentId, deviceRepoId: computerRepo, title: 'Task', body: '', model: 'key-model-a' })).runId
      const desktops = await fakeThreadMachines(pool, desktopMachine)
      const desktopThread = await desktops.start(actor, desktopRun).finally(() => desktops.restore())
      const desktopResponse = await claim(desktopThread.deviceId, desktopRun, desktopThread.token)
      const desktopText = await desktopResponse.text()
      assert.equal(desktopResponse.status, 200, desktopText)
      assert.equal(JSON.parse(desktopText).computer.botId, p.botId, 'the thread machine\'s own desktop')
      assert.equal(await status(desktopRun), 'preparing')
    } finally { machines.restore() }
  })

  await t.test('a workspace that denies computer use: a repository task on a task machine is claimed with no computer; a computer task is refused', async () => {
    const p = await person('key-deny')
    const secret = `sk-ant-${randomBytes(16).toString('hex')}`
    await addKey(p.id, 'anthropic', secret, ['key-model-a'])
    const { cloudDevice, agentId, repoId } = await botComputer(p)
    const actor = { userId: p.id, workspaceId: p.workspaceId }
    const queue = async (deviceRepoId: string, harnesses: Record<string, unknown>[]) => {
      const { runId } = await queueCloudRun(pool, actor, { botId: p.botId, issueId: await task(p.id, p.workspaceId), agentId, deviceRepoId, title: 'Task', body: '', model: 'key-model-a' })
      const machines = await fakeThreadMachines(pool, harnesses)
      try { return { runId, ...(await machines.start(actor, runId)) } } finally { machines.restore() }
    }
    const computerRepo = randomUUID()
    await pool.query('INSERT INTO device_repos (id,"deviceId","userId","repoPath") VALUES ($1,$2,$3,$4)', [computerRepo, cloudDevice, p.id, '/home/user/.mikka/bot-workspaces/fixture'])
      await pool.query('UPDATE bot_cloud_runtimes SET "repoId"=$2 WHERE "botId"=$1', [p.botId,computerRepo])
    const repository = await queue(repoId, taskMachine)
    const computerTask = await queue(computerRepo, desktopMachine)
    // An admin denies computer use once both threads are queued on their own machines.
    await pool.query(`INSERT INTO workspace_computer_policies ("workspaceId",permission,version) VALUES ($1,'deny',3)`, [p.workspaceId])
    try {
      const response = await claim(repository.deviceId, repository.runId, repository.token)
      const text = await response.text()
      assert.equal(response.status, 200, text)
      const assignment = JSON.parse(text)
      assert.equal(assignment.modelCredential.key, secret)
      assert.equal(assignment.computer, undefined, 'a repository task gets no computer')
      assert.notEqual(assignment.policy.permissions.computer_use, 'allow', 'a deny workspace grants no computer use')

      const refused = await claim(computerTask.deviceId, computerTask.runId, computerTask.token)
      assert.equal(refused.status, 409, await refused.text())
      assert.equal((await pool.query('SELECT status FROM agent_runs WHERE id=$1', [computerTask.runId])).rows[0].status, 'queued', 'a computer task stays queued under deny')
    } finally { await pool.query('DELETE FROM workspace_computer_policies WHERE "workspaceId"=$1', [p.workspaceId]) }
  })

  await t.test('a released daemon below the minimum: the claim is refused with daemonUpgradeRequired and the run ends, so the Bot says to update Mikka', async () => {
    const p = await person('old-daemon')
    const { MIN_DAEMON_VERSION } = await import('@mikka/protocol/device')
    const { DAEMON_UPGRADE_REQUIRED } = await import('../lib/run-leases')
    await pool.query('UPDATE devices SET "daemonVersion"=$2 WHERE id=$1', [p.deviceId, '0.0.298'])
    const { runId } = await queueRun(p.id, { issueId: p.issueId, agentId: p.agents.claude_code, repo: p.remote, model: 'fixture-model' }, p.botId)
    const refused = await claim(p.deviceId, runId, p.token)
    assert.equal(refused.status, 409)
    const body = await refused.json()
    assert.equal(body.code, 'daemonUpgradeRequired')
    assert.equal(body.minVersion, MIN_DAEMON_VERSION)
    assert.equal(body.daemonVersions?.min, MIN_DAEMON_VERSION, 'names the releases so the refused daemon updates to the version this server names')
    const run = (await pool.query('SELECT status, "stopReason", error FROM agent_runs WHERE id=$1', [runId])).rows[0]
    assert.deepEqual(run, { status: 'failed', stopReason: 'error', error: DAEMON_UPGRADE_REQUIRED })
    const events = (await pool.query('SELECT kind, payload FROM coordinator_events WHERE "runId"=$1', [runId])).rows
    assert.equal(events.length, 1)
    assert.equal(events[0].kind, 'run_finished')
    assert.equal(events[0].payload.daemonUpgradeRequired, true)
    await pool.query('DELETE FROM coordinator_events WHERE "runId"=$1', [runId])

    await pool.query('UPDATE devices SET "daemonVersion"=$2 WHERE id=$1', [p.deviceId, MIN_DAEMON_VERSION])
    const { runId: next } = await queueRun(p.id, { issueId: await task(p.id, p.workspaceId), agentId: p.agents.claude_code, repo: p.remote, model: 'fixture-model' }, p.botId)
    const accepted = await claim(p.deviceId, next, p.token)
    assert.equal(accepted.status, 200, await accepted.text())

    // The heartbeat answer names the releases; a failed automatic update is kept until the daemon clears it.
    const heartbeatRoute = await import('../app/v1/devices/[deviceId]/heartbeat/route')
    const beat = (body: Record<string, unknown>) => heartbeatRoute.POST(new Request(`http://127.0.0.1/v1/devices/${p.deviceId}/heartbeat`, {
      method: 'POST', headers: { 'x-mikka-client-version': '0.0.456', authorization: `Bearer ${p.token}` }, body: JSON.stringify({ harnesses: [], runs: [], worktreeDiskBytes: 0, ...body }),
    }), { params: Promise.resolve({ deviceId: p.deviceId }) })
    const stored = async () => (await pool.query('SELECT "updateFailure" FROM devices WHERE id=$1', [p.deviceId])).rows[0].updateFailure
    const failure = { version: '0.0.331', code: 'install_failed', at: '2026-11-02T21:00:00.000Z' }
    const answer = await beat({ updateFailure: failure })
    assert.equal(answer.status, 200)
    assert.equal((await answer.json()).daemonVersions.min, MIN_DAEMON_VERSION)
    assert.deepEqual(await stored(), failure)
    assert.equal((await beat({})).status, 200)
    assert.deepEqual(await stored(), failure, 'a daemon that reports nothing leaves it')
    assert.equal((await beat({ updateFailure: { ...failure, code: 'npm ERR! 404' } })).status, 400, 'codes only')
    assert.equal((await beat({ updateFailure: null })).status, 200)
    assert.equal(await stored(), null)
  })
})
