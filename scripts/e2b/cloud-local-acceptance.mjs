// New remote repository task on a ready E2B template + real DeepSeek + local API.
// Run only after local acceptance, with the isolated server's database env:
// NODE_USE_ENV_PROXY=1 node --import ./tests/support/server-only.mjs --import tsx \
//   scripts/e2b/cloud-local-acceptance.mjs <environment.json>
// E2B_API_KEY, E2B_ACCEPTANCE_TEMPLATE and E2B_WORKER_SHA stay in process memory.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { Agent, EnvHttpProxyAgent, fetch as proxyFetch } from 'undici'
import { Sandbox } from 'e2b'
import { remoteKey } from '@mikka/protocol/repository'
import { assertE2eTarget, disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { loadEnvironment } from '../test-accounts/environment.mjs'
import { acquireTestAccounts } from '../test-accounts/session.mjs'
import { preferredModel } from '../dev-local/seed-model-keys.ts'
import { ensureBotRuntime } from '../../lib/computer/bot-runtime.ts'
import { ensureThreadMachine } from '../../lib/cloud-computer/thread-machines.ts'
import { localGitOrigin } from '../../packages/daemon/src/agents/local-git-origin.ts'
import { startLocalRelay } from './local-api-relay.mjs'

const id = randomUUID(), directory = resolve('.cache/dev-local', `cloud-${id}`), sandboxIds = new Set(), snapshotIds = new Set()
const localAgent = new Agent(), remoteAgent = new EnvHttpProxyAgent()
const abort = new AbortController()
let options = {}, timeout, heartbeat, started = false
const send = (url, options) => proxyFetch(url, { ...options, dispatcher: ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname) ? localAgent : remoteAgent })
let pool, accounts, relay, actor, botId, sourceDevice, sourceSandboxId, runId, taskDevice, stage = 'guard'
let ownsPool = false, ownsAccounts = false
const observed = [], metric = { id, scope: 'new remote repository task on a ready E2B template, isolated local API/DB, real DeepSeek, run-bound MCP' }
const connection = { apiKey: process.env.E2B_API_KEY, proxy: process.env.HTTPS_PROXY ?? process.env.https_proxy }
async function wait(check, limit = 120_000) {
  const until = performance.now() + limit
  while (performance.now() < until) { abort.signal.throwIfAborted(); const result = await check(); if (result) return result; await delay(250, undefined, { signal: abort.signal }) }
  throw Error(`Timed out at ${stage}`)
}
async function api(path, body, method = body ? 'POST' : 'GET') {
  const response = await accounts.owner.request(path, { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) })
  assert.ok(response.ok, `${method} ${path}: HTTP ${response.status}`)
  return response.json()
}
async function main() {
  assert.ok(disposableDatabase(process.env), 'All application databases must be disposable loopback _e2e targets')
  assertE2eTarget(process.env.E2E_DATABASE_URL)
  assert.ok(connection.apiKey && /^[A-Za-z0-9_-]+$/.test(process.env.E2B_ACCEPTANCE_TEMPLATE ?? '') && /^[a-f0-9]{40}$/.test(process.env.E2B_WORKER_SHA ?? ''), 'Private E2B test template credentials required')
  for (const name of ['CI', 'GITHUB_ACTIONS', 'RUNNER_ENVIRONMENT', 'GITHUB_RUN_ID']) assert.ok(!process.env[name], 'No CI impersonation')
  const environment = options.environment ?? await loadEnvironment({ ...process.env, MIKKA_TEST_ENVIRONMENT_FILE: process.argv[2] ?? process.env.MIKKA_TEST_ENVIRONMENT_FILE })
  const localOrigin = environment.origin
  assert.ok(['localhost', '127.0.0.1'].includes(new URL(localOrigin).hostname))
  ownsPool = !options.pool
  pool = options.pool ?? new pg.Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 5, statement_timeout: 20_000 })
  assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, environment.database.name)
  await pool.query(`CREATE TABLE IF NOT EXISTS mikka_test_accounts.cloud_relays (
    device_id uuid PRIMARY KEY,owner_id text NOT NULL,workspace_id uuid NOT NULL,run_id uuid NOT NULL,
    issuer text NOT NULL,expires_at timestamptz NOT NULL)`)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  stage = 'normal-account-lease'
  ownsAccounts = !options.accounts
  accounts = options.accounts ?? await acquireTestAccounts({ environment, database: pool, runId: id, workerId: 'e2b-real-loop', requestId: id, ttlMs: 300_000 })
  await accounts.assertActive()
  metric.accountLeaseSource = ownsAccounts ? 'independent-helper' : 'owning-driver'
  stage = 'actor-fixture'
  actor = { userId: accounts.owner.userId, workspaceId: (await api('/api/workspace')).workspace.id }
  botId = (await api('/api/mobile/bots', { name: `Cloud acceptance ${id.slice(0, 8)}`, color: 'bleu', shape: 'cercle' })).id
  stage = 'source-sandbox'
  const source = await Sandbox.create(process.env.E2B_ACCEPTANCE_TEMPLATE, { ...connection, timeoutMs: 900_000, metadata: { purpose: 'isolated-cloud-source', acceptance: id } })
  sourceSandboxId = source.sandboxId
  sandboxIds.add(source.sandboxId)
  assert.equal((await source.files.read('/opt/mikka/worker-source-sha', { user: 'root' })).trim(), process.env.E2B_WORKER_SHA)
  sourceDevice = randomUUID()
  // Disposable account-owned machine metadata. The source holds software and
  // a fixture repository only; no device credential is installed or snapshotted.
  await pool.query('INSERT INTO devices (id,"ownerId",name,kind,harnesses) VALUES ($1,$2,$3,\'cloud\',$4)', [sourceDevice, actor.userId, 'Cloud acceptance source', JSON.stringify([{ harness: 'claude_code', installed: true, subscriptionBroker: true, computerBroker: true }])])
  await pool.query('INSERT INTO cloud_machines ("workspaceId","ownerId","sandboxId","operationId","runtimeReady",state,"deviceId") VALUES ($1,$2,$3,$4,true,\'running\',$5)', [actor.workspaceId, actor.userId, source.sandboxId, randomUUID(), sourceDevice])
  await pool.query('INSERT INTO bot_desktops ("botId","workspaceId","ownerId",display) VALUES ($1,$2,$3,1)', [botId, actor.workspaceId, actor.userId])
  const sourceRuntimes = await ensureBotRuntime(pool, actor, botId, source, sourceDevice)
  stage = 'real-model-selection'
  await wait(async () => {
    assert.ok((await send('http://127.0.0.1:3191/refresh', { method: 'POST', signal: abort.signal })).ok)
    const key = (await pool.query('SELECT models FROM model_api_keys WHERE "ownerId"=$1 AND provider=\'deepseek\'', [actor.userId])).rows[0]
    if (!key) return false
    metric.model = preferredModel(key.models)
    return Boolean(metric.model)
  })
  const marker = `cloud-acceptance-${id}`
  await api('/api/coordinator/messages', { text: `请只创建一个个人任务，标题“${marker}”，描述“在当前仓库写入文件 cloud-acceptance.txt，内容为 ${marker}。完成后用 submit 工具提交报告，不推送、不创建PR。”。不要派发，不启动线程，不调用电脑。`, submissionId: randomUUID() })
  const issue = await wait(async () => (await pool.query('SELECT id FROM issues WHERE "userId"=$1 AND title=$2', [actor.userId, marker])).rows[0])

  stage = 'restricted-https-relay'
  const relayOrigin = `https://${source.getHost(8765)}`, controlToken = randomBytes(32).toString('base64url'), initialDevice = `orv_${randomBytes(32).toString('base64url')}`, repoToken = randomBytes(32).toString('base64url')
  const runtime = options.runtime ?? JSON.parse(await readFile(resolve('.cache/dev-local/runtime.json'), 'utf8'))
  assert.equal(new URL(runtime.server).origin, localOrigin)
  const barePath = localGitOrigin({ ...process.env, MIKKA_DEV_GIT_ORIGIN: runtime.scenario.barePath })
  assert.ok(barePath, 'Only the existing isolated dev:local Git fixture can be exposed')
  const baseBranch = runtime.scenario.baseBranch
  assert.equal(typeof baseBranch, 'string', 'The fixture must declare its actual default base branch')
  execFileSync('git', ['check-ref-format', '--branch', baseBranch], { stdio: 'ignore' })
  const repository = `${relayOrigin}/mikka/v1/git/core-loop.git`
  metric.fixtureBaseBranch = baseBranch
  metric.fixtureBaseCommit = execFileSync('git', ['--git-dir', barePath, 'rev-parse', `refs/heads/${baseBranch}`], { encoding: 'utf8' }).trim()
  for (const current of sourceRuntimes) await pool.query('UPDATE device_repos SET "repoPath"=$2,"remoteUrl"=$3,"baseBranch"=$4 WHERE id=$1 AND "userId"=$5', [current.repoId, remoteKey(repository), repository, baseBranch, actor.userId])
  await source.commands.run('install -d -m 700 /run/mikka-relay', { user: 'root' })
  await source.files.write('/run/mikka-relay/server.py', await readFile(new URL('./local-api-relay.py', import.meta.url), 'utf8'), { user: 'root' })
  await source.files.write('/run/mikka-relay/config.json', JSON.stringify({ origin: relayOrigin, deviceToken: initialDevice, controlToken, repoToken, bindDeviceOnce: true }), { user: 'root' })
  await source.commands.run('chmod 600 /run/mikka-relay/config.json; exec /usr/bin/python3 /run/mikka-relay/server.py /run/mikka-relay/config.json > /run/mikka-relay/server.log 2>&1', { user: 'root', background: true, timeoutMs: 0 })
  await wait(async () => { try { return (await send(`${relayOrigin}/mikka/v1/probe`, { signal: abort.signal })).status === 401 } catch { return false } })
  relay = await startLocalRelay({ localOrigin, relayOrigin, deviceToken: initialDevice, controlToken, signal: abort.signal, barePath, send, observe: value => { observed.push({ at: new Date().toISOString(), ...value }); if (value.type === 'claim') metric.policyIssuer = value.issuer } })
  void relay.done.catch(error => abort.abort(error))
  process.env.MIKKA_CLOUD_WORKER_URL = `${relayOrigin}/mikka`
  process.env.MIKKA_CLOUD_WORKER_SHA = process.env.E2B_WORKER_SHA
  process.env.MIKKA_CLOUD_THREAD_MACHINES = '1'
  process.env.E2B_BYO_COMPUTER_TEMPLATE = process.env.E2B_ACCEPTANCE_TEMPLATE

  stage = 'signed-route-warmup'
  // next dev compiles routes lazily. Warm the unchanged authorization paths
  // anonymously before the daemon's bounded signed-policy requests; 401 is
  // required, and no policy timeout or verifier is weakened.
  for (const path of [`/mikka/v1/runs/${randomUUID()}/policy-snapshot?deviceId=${randomUUID()}`, `/mikka/v1/devices/${randomUUID()}/runs/${randomUUID()}/claim`]) {
    const response = await send(`${localOrigin}${path}`, { method: path.includes('/claim') ? 'POST' : 'GET', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(90_000)]) })
    assert.equal(response.status, 401, 'Anonymous cloud route warmup must remain unauthorized')
    await response.arrayBuffer()
  }

  stage = 'api-task-dispatch'
  const queued = await api(`/api/bots/${botId}/computer/runs`, { issueId: issue.id, harness: 'claude_code', note: `Use the real selected ${metric.model}. Write cloud-acceptance.txt with ${marker}, then submit. Do not push or open a PR.` })
  runId = queued.runId
  assert.ok(runId)
  const frozen = (await pool.query('SELECT r."agentDefinition",k.provider FROM agent_runs r JOIN model_api_keys k ON k.id=(r."agentDefinition"->\'apiKey\'->>\'keyId\')::uuid AND k."ownerId"=r."userId" WHERE r.id=$1 AND r."userId"=$2', [runId, actor.userId])).rows[0]
  assert.equal(frozen?.provider, 'deepseek', 'Cloud run must freeze the real DeepSeek key')
  assert.equal(frozen.agentDefinition.modelSource, 'api_key')
  assert.equal(frozen.agentDefinition.model, metric.model)
  const provider = {
    snapshot: async () => { assert.fail('A new repository task must never clone the bot filesystem') },
    create: async (snapshot, operationId, metadata) => {
      assert.equal(snapshot, process.env.E2B_ACCEPTANCE_TEMPLATE, 'The actual E2B create must use the ready template')
      metric.machineSource = 'ready-template'
      metric.workspaceSnapshotsUsed = 0
      metric.createRequestedAt = new Date().toISOString()
      const began = performance.now()
      const sandbox = await Sandbox.create(snapshot, { ...connection, idempotencyKey: operationId, timeoutMs: 900_000, metadata: { ...metadata, purpose: 'isolated-cloud-task', acceptance: id } })
      sandboxIds.add(sandbox.sandboxId)
      metric.e2bCreateMs = Math.round(performance.now() - began)
      const fixtureStarted = performance.now()
      // This transport credential is a separate read-only capability for the
      // disposable fixture, never a device token. It stays under the daemon's
      // existing SRT denyRead path; the repository config and agent env omit it.
      const gitConfig = '/home/mikka-runner/.mikka/worker/adapters/pids/fixture-git.config'
      // install sets ownership only on named directories, not implicit parents.
      await sandbox.commands.run('install -d -o mikka-runner -g mikka-runner -m 700 /home/mikka-runner/.mikka/worker /home/mikka-runner/.mikka/worker/adapters /home/mikka-runner/.mikka/worker/adapters/pids', { user: 'root' })
      await sandbox.files.write(gitConfig, `[http "${repository}"]\n\textraHeader =\n\textraHeader = Authorization: Bearer ${repoToken}\n`, { user: 'root' })
      await sandbox.files.write('/usr/local/bin/git', `#!/bin/sh\nif test -r ${gitConfig}; then exec /usr/bin/git -c include.path=${gitConfig} "$@"; fi\nexec /usr/bin/git "$@"\n`, { user: 'root' })
      await sandbox.commands.run(`chown mikka-runner:mikka-runner ${gitConfig}; chmod 600 ${gitConfig}; chown root:root /usr/local/bin/git; chmod 755 /usr/local/bin/git`, { user: 'root' })
      metric.fixtureTransportSetupMs = Math.round(performance.now() - fixtureStarted)
      const files = new Proxy(sandbox.files, { get(target, name) {
        if (name === 'write') return async (path, contents, options) => {
          if (typeof path === 'string' && /^\/run\/mikka-viewer\/thread-[a-f0-9-]+\.json$/.test(path)) {
            const config = JSON.parse(contents)
            taskDevice = config.deviceId
            assert.equal(config.server, `${relayOrigin}/mikka`)
            await pool.query('INSERT INTO mikka_test_accounts.cloud_relays (device_id,owner_id,workspace_id,run_id,issuer,expires_at) VALUES ($1,$2,$3,$4,$5,now()+interval \'15 minutes\')', [taskDevice, actor.userId, actor.workspaceId, runId, `${relayOrigin}/mikka`])
            await relay.bindDevice(config.credential, config.deviceId)
          }
          return target.write(path, contents, options)
        }
        const value = Reflect.get(target, name, target)
        return typeof value === 'function' ? value.bind(target) : value
      } })
      return new Proxy(sandbox, { get(target, name) { return name === 'files' ? files : Reflect.get(target, name, target) } })
    },
    connect: async sandboxId => { assert.ok(sandboxIds.has(sandboxId)); return Sandbox.connect(sandboxId, connection) },
    kill: async sandboxId => { assert.ok(sandboxIds.has(sandboxId)); await Sandbox.kill(sandboxId, connection); sandboxIds.delete(sandboxId) },
  }
  stage = 'real-thread-provision-and-worker'
  await ensureThreadMachine(pool, actor, runId, provider)
  stage = 'real-agent-first-event-and-completion'
  const first = await wait(async () => (await pool.query('SELECT chunk,"createdAt" FROM run_chunks WHERE "runId"=$1 AND chunk->>\'type\'=ANY($2::text[]) ORDER BY seq LIMIT 1', [runId, ['text-start', 'text-delta', 'reasoning-start', 'tool-input-start', 'tool-input-available']])).rows[0], 300_000)
  metric.firstEventAt = first.createdAt.toISOString()
  metric.firstEventType = first.chunk.type
  metric.createToFirstEventMs = first.createdAt.getTime() - Date.parse(metric.createRequestedAt)
  metric.addedAfterE2BBootMs = metric.createToFirstEventMs - metric.e2bCreateMs
  const done = await wait(async () => {
    const row = (await pool.query('SELECT status,"stopReason",error,report FROM agent_runs WHERE id=$1 AND "userId"=$2', [runId, actor.userId])).rows[0]
    return ['succeeded', 'failed', 'stopped', 'cancelled'].includes(row?.status) ? row : null
  }, 600_000)
  assert.equal(done.status, 'succeeded', `Cloud task failed (${done.stopReason ?? 'unknown'})`)
  assert.equal(done.stopReason, 'submitted')
  assert.equal(metric.policyIssuer, `${relayOrigin}/mikka`)
  const taskMachine = (await pool.query('SELECT "sandboxId" FROM thread_machines WHERE "runId"=$1 AND "ownerId"=$2', [runId, actor.userId])).rows[0]
  assert.ok(taskMachine?.sandboxId && sandboxIds.has(taskMachine.sandboxId))
  const taskSandbox = await Sandbox.connect(taskMachine.sandboxId, connection)
  const content = await taskSandbox.files.read(`/home/mikka-runner/.mikka/worker/worktrees/${runId}/cloud-acceptance.txt`, { user: 'mikka-runner' })
  assert.ok(content.includes(marker), 'Real E2B worktree lacks the model-written marker')
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`
  const base = (await taskSandbox.commands.run(`git -C /home/mikka-runner/.mikka/worker/worktrees/${runId} merge-base HEAD ${quote(`origin/${baseBranch}`)}`, { user: 'mikka-runner', timeoutMs: 10_000 })).stdout.trim()
  assert.equal(base, metric.fixtureBaseCommit, 'The task must branch from the repository-declared default base commit')
  metric.runId = runId
  metric.status = done.status
  metric.actualDeepSeek = true
  metric.latencyIncludes = ['real model inference', 'restricted test reverse relay and fixture transport setup', 'application and worker startup']
  metric.normalAccountLease = true
  metric.productionDbWrites = false
  metric.testTransport = 'restricted HTTPS reverse relay; provider transport uses the test team E2B key'
  await writeFile(resolve(directory, 'result.json'), JSON.stringify(metric, null, 2), { mode: 0o600 })
  console.log(JSON.stringify(metric))
}

export async function verifyCloud(input = {}) {
  assert.equal(started, false, 'Use a fresh process for another cloud acceptance run')
  started = true
  options = input
  if (input.templateId) process.env.E2B_ACCEPTANCE_TEMPLATE = input.templateId
  if (input.workerHash) process.env.E2B_WORKER_SHA = input.workerHash
  if (input.apiKey) connection.apiKey = input.apiKey
  assert.ok(disposableDatabase(process.env), 'Cloud acceptance requires the owning isolated database environment')
  let failure
  try {
  input.signal?.throwIfAborted()
  if (!connection.apiKey) {
    // Reuse the configured existing Infisical identity. These response values
    // remain in memory; no key is printed, written to an env file or sent to a task.
    const endpoint = process.env.INFISICAL_API_URL ?? 'https://app.infisical.com'
    const authenticated = await send(`${endpoint}/api/v1/auth/universal-auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId: process.env.INFISICAL_CLIENT_ID, clientSecret: process.env.INFISICAL_CLIENT_SECRET }), signal: AbortSignal.timeout(20_000) })
    assert.ok(authenticated.ok, `Infisical authentication HTTP ${authenticated.status}`)
    const { accessToken } = await authenticated.json()
    const query = new URLSearchParams({ projectId: process.env.INFISICAL_PROJECT_ID, environment: 'prod', secretPath: '/vercel', viewSecretValue: 'true', includeImports: 'false' })
    const response = await send(`${endpoint}/api/v4/secrets/E2B_API_KEY?${query}`, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20_000) })
    assert.ok(response.ok, `Test-team E2B key HTTP ${response.status}`)
    connection.apiKey = (await response.json()).secret?.secretValue
  }
  timeout = setTimeout(() => abort.abort(Error('Cloud acceptance timeout')), 900_000)
  heartbeat = setInterval(() => { if (input.progress) void Promise.resolve(input.progress('item8-cloud-loop', 'heartbeat', stage)).catch(() => {}); else console.log(JSON.stringify({ stage, at: new Date().toISOString() })) }, 15_000)
  const cancelled = () => abort.abort(input.signal.reason)
  input.signal?.addEventListener('abort', cancelled, { once: true })
  input.signal?.throwIfAborted()
  await main()
  input.signal?.removeEventListener('abort', cancelled)
  }
  catch (error) {
    const code = typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : undefined
    const message = /^(Cloud task failed|Timed out at|Relay policy issuer|POST \/api|GET \/api)/.test(error.message) ? error.message : code ?? 'Cloud acceptance failed; retained metadata contains no credentials'
    metric.failedStage = stage
    metric.errorType = error.name
    metric.errorCode = code
    // Provider/SDK errors can contain response bodies or headers. The owning
    // harness receives a fixed scoped error, never those objects or secrets.
    failure = Error(`${stage}: ${message}`)
    console.error(JSON.stringify({ stage, errorType: error.name, message }))
  }
  finally {
  clearTimeout(timeout); clearInterval(heartbeat)
  if (pool && actor) {
    if (runId) await pool.query('UPDATE agent_runs SET "stopRequestedAt"=COALESCE("stopRequestedAt",now()) WHERE id=$1 AND "userId"=$2 AND status NOT IN (\'succeeded\',\'failed\',\'stopped\',\'cancelled\')', [runId, actor.userId]).catch(() => {})
    if (taskDevice) await pool.query('UPDATE device_tokens SET "revokedAt"=now() WHERE "boundDeviceId"=$1 AND "userId"=$2', [taskDevice, actor.userId]).catch(() => {})
    if (taskDevice) await pool.query('DELETE FROM mikka_test_accounts.cloud_relays WHERE device_id=$1 AND owner_id=$2', [taskDevice, actor.userId]).catch(() => {})
  }
  const cleanupFailures = []
  for (const sandboxId of sandboxIds) {
    try { await Sandbox.kill(sandboxId, connection) }
    catch { try { await Sandbox.kill(sandboxId, connection) } catch { cleanupFailures.push({ resource: 'sandbox', id: sandboxId }) } }
  }
  if (relay) await relay.stop()
  for (const snapshotId of snapshotIds) {
    try { await Sandbox.deleteSnapshot(snapshotId, connection) }
    catch { cleanupFailures.push({ resource: 'snapshot', id: snapshotId }) }
  }
  if (pool && actor) {
    // Remove only this invocation's resources, including when the owning
    // driver lends its lease and database pool for the cloud leg.
    if (runId) await pool.query('DELETE FROM agent_runs WHERE id=$1 AND "userId"=$2', [runId, actor.userId]).catch(() => {})
    if (botId) await pool.query('DELETE FROM bots WHERE id=$1 AND "ownerId"=$2', [botId, actor.userId]).catch(() => {})
    if (sourceSandboxId) await pool.query('DELETE FROM cloud_machines WHERE "workspaceId"=$1 AND "ownerId"=$2 AND "sandboxId"=$3', [actor.workspaceId, actor.userId, sourceSandboxId]).catch(() => {})
    if (sourceDevice || taskDevice) await pool.query('DELETE FROM agents WHERE "userId"=$1 AND "deviceId"=ANY($2::uuid[])', [actor.userId, [sourceDevice, taskDevice].filter(Boolean)]).catch(() => {})
    if (sourceDevice || taskDevice) await pool.query('DELETE FROM devices WHERE "ownerId"=$1 AND id=ANY($2::uuid[])', [actor.userId, [sourceDevice, taskDevice].filter(Boolean)]).catch(() => {})
  }
  // The normal pool quarantines accounts whose real model/task history was
  // changed. Retained evidence is never mislabelled as a clean reusable slot.
  if (ownsAccounts) await accounts?.release({ outcome: 'dirty' }).catch(() => {})
  if (ownsPool) await pool?.end()
  await localAgent.close(); await remoteAgent.close()
  connection.apiKey = undefined
  metric.cleanupConfirmed = cleanupFailures.length === 0
  if (cleanupFailures.length) console.error(JSON.stringify({ stage: 'cleanup', failures: cleanupFailures }))
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(resolve(directory, 'result.json'), JSON.stringify(metric, null, 2), { mode: 0o600 })
  await writeFile(resolve(directory, 'relay-requests.json'), JSON.stringify(observed, null, 2), { mode: 0o600 })
  if (cleanupFailures.length && !failure) failure = Error('Cloud acceptance resource cleanup failed')
  }
  if (failure) throw failure
  return metric
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await verifyCloud().catch(() => { process.exitCode = 1 })
}
