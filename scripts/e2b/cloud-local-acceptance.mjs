// Actual cloud-worker repository task through fake E2B HTTP + fake LiteLLM.
import { submitEveMessage } from '../acceptance/eve-session.mjs'
// New remote repository task on official E2B instances + real DeepSeek + local API.
// Run only after local acceptance, with the isolated server's database env:
// NODE_USE_ENV_PROXY=1 node --import ./tests/support/server-only.mjs --import tsx \
//   scripts/e2b/cloud-local-acceptance.mjs <environment.json>
// No provider credential is read. Worker source/digest match this checkout.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { Agent, fetch as proxyFetch } from 'undici'
import { Sandbox } from 'e2b'
import { remoteKey } from '@mikka/protocol/repository'
import { assertE2eTarget, disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { loadEnvironment } from '../test-accounts/environment.mjs'
import { acquireTestAccounts } from '../test-accounts/session.mjs'
import { preferredModel } from '../dev-local/seed-model-keys.ts'
import { ensureBotRuntime } from '../../lib/computer/bot-runtime.ts'
import { ensureThreadMachine } from '../../lib/cloud-computer/thread-machines.ts'
import { localGitOrigin } from '../../packages/daemon/src/agents/local-git-origin.ts'
import { startLoopbackCloudRelay } from './loopback-cloud-relay.mjs'
import { startLocalCloudImage } from './local-cloud-image.mjs'
import { LOCAL_E2B_KEY } from '../../tests/fakes/e2b.mjs'
import { cloudAcceptanceRelease } from './cloud-acceptance-release.mjs'
import { bootstrapOfficialInstance } from '../../lib/computer/official-runtime.ts'
import { computerTemplate, taskTemplate } from '../../lib/secrets/e2b-runtime.ts'

const id = randomUUID(), directory = resolve('.cache/dev-local', `cloud-${id}`), sandboxIds = new Set()
const localAgent = new Agent()
const abort = new AbortController()
let options = {}, timeout, heartbeat, started = false, release, tlsAgent, fakeProvider
const send = (url, options) => {
  const target = new URL(url)
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname), 'LOCAL_CLOUD_EXTERNAL_HTTP_REFUSED')
  return proxyFetch(url, { ...options, dispatcher: target.protocol === 'https:' ? tlsAgent : localAgent, redirect: 'error' })
}
let pool, accounts, relay, actor, botId, sourceDevice, sourceSandboxId, runId, taskDevice, stage = 'guard'
let ownsPool = false, ownsAccounts = false
const observed = [], metric = { id, scope: 'real cloud-worker repository task, fake E2B HTTP, fake LiteLLM, isolated local API/DB, run-bound MCP', networkBoundary: 'one owned network namespace; independent mount/PID/user execution environments' }
const connection = {}
const quote = value => `'${value.replaceAll("'", "'\\''")}'`
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
  const parentTemplate = computerTemplate(), codingTemplate = taskTemplate('claude_code')
  metric.officialTemplates = { parent: parentTemplate, task: codingTemplate }
  metric.workerSourceCommit = release.sourceCommit
  metric.workerHash = release.workerHash
  for (const name of ['CI', 'GITHUB_ACTIONS', 'RUNNER_ENVIRONMENT', 'GITHUB_RUN_ID']) assert.ok(!process.env[name], 'No CI impersonation')
  const environment = options.environment ?? await loadEnvironment({ ...process.env, MIKKA_TEST_ENVIRONMENT_FILE: process.argv[2] ?? process.env.MIKKA_TEST_ENVIRONMENT_FILE })
  const localOrigin = environment.origin
  assert.ok(['localhost', '127.0.0.1'].includes(new URL(localOrigin).hostname))
  const runtime = options.runtime ?? JSON.parse(await readFile(resolve('.cache/dev-local/runtime.json'), 'utf8'))
  assert.equal(new URL(runtime.server).origin, localOrigin)
  const barePath = localGitOrigin({ ...process.env, MIKKA_DEV_GIT_ORIGIN: runtime.scenario.barePath })
  assert.ok(barePath, 'Only the existing isolated dev:local Git fixture can be exposed')
  const repoToken = randomBytes(32).toString('base64url')
  relay = await startLoopbackCloudRelay({ localOrigin, barePath, repoToken, observe: value => { observed.push({ at: new Date().toISOString(), ...value }); if (value.type === 'claim') metric.policyIssuer = value.issuer } })
  const relayOrigin = relay.origin
  tlsAgent = new Agent({ connect: { ca: relay.ca } })
  stage = 'local-provider-image'
  fakeProvider = await startLocalCloudImage({ release, ca: relay.ca })
  Object.assign(connection, fakeProvider.e2bOptions)
  assert.equal(connection.apiKey, LOCAL_E2B_KEY, 'Only the synthetic local E2B credential is allowed')
  metric.workerCliSha256 = fakeProvider.worker.cliSha256
  metric.networkNamespace = fakeProvider.worker.networkNamespace
  process.env.MIKKA_CLOUD_WORKER_URL = `${relayOrigin}/mikka`
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
  const source = await Sandbox.create(parentTemplate, { ...connection, timeoutMs: 900_000, metadata: { purpose: 'isolated-cloud-source', acceptance: id } })
  sourceSandboxId = source.sandboxId
  sandboxIds.add(source.sandboxId)
  const sourceBootstrap = performance.now()
  await bootstrapOfficialInstance(source, parentTemplate)
  metric.ingressGuard = fakeProvider.guardEvidence
  metric.sourceInstanceBootstrapMs = Math.round(performance.now() - sourceBootstrap)
  assert.equal((await source.files.read('/opt/mikka/worker-source-sha', { user: 'root' })).trim(), release.workerHash)
  sourceDevice = randomUUID()
  // Disposable account-owned machine metadata. The source holds software and
  // a fixture repository only; no device credential is installed or snapshotted.
  await pool.query('INSERT INTO devices (id,"ownerId",name,kind,harnesses) VALUES ($1,$2,$3,\'cloud\',$4)', [sourceDevice, actor.userId, 'Cloud acceptance source', JSON.stringify([{ harness: 'claude_code', installed: true, subscriptionBroker: true, computerBroker: true }])])
  await pool.query('INSERT INTO cloud_machines ("workspaceId","ownerId","sandboxId","operationId","runtimeReady",state,"deviceId") VALUES ($1,$2,$3,$4,true,\'running\',$5)', [actor.workspaceId, actor.userId, source.sandboxId, randomUUID(), sourceDevice])
  await pool.query('INSERT INTO bot_desktops ("botId","workspaceId","ownerId",display) VALUES ($1,$2,$3,1)', [botId, actor.workspaceId, actor.userId])
  const sourceRuntimes = await ensureBotRuntime(pool, actor, botId, source, sourceDevice)
  stage = 'model-selection-via-fake-litellm'
  await wait(async () => {
    assert.ok((await send('http://127.0.0.1:3191/refresh', { method: 'POST', signal: abort.signal })).ok)
    const key = (await pool.query('SELECT models FROM model_api_keys WHERE "ownerId"=$1 AND provider=\'deepseek\'', [actor.userId])).rows[0]
    if (!key) return false
    metric.model = preferredModel(key.models)
    return Boolean(metric.model)
  })
  execFileSync(process.execPath, [resolve('scripts/assert-test-model.mjs'), metric.model], { stdio: 'ignore' })
  const marker = `cloud-acceptance-${id}`
  await submitEveMessage(accounts.owner, null, `请只创建一个个人任务，标题“${marker}”，描述“在当前仓库写入文件 cloud-acceptance.txt，内容为 ${marker}。完成后用 submit 工具提交报告，不推送、不创建PR。”。不要派发，不启动线程，不调用电脑。`, randomUUID(), { expectedOwnerId: actor.userId, expectedWorkspaceId: actor.workspaceId })
  const issue = await wait(async () => (await pool.query('SELECT id FROM issues WHERE "userId"=$1 AND title=$2', [actor.userId, marker])).rows[0])

  stage = 'restricted-https-relay'
  const baseBranch = runtime.scenario.baseBranch
  assert.equal(typeof baseBranch, 'string', 'The fixture must declare its actual default base branch')
  execFileSync('git', ['check-ref-format', '--branch', baseBranch], { stdio: 'ignore' })
  const repository = `${relayOrigin}/mikka/v1/git/core-loop.git`
  metric.fixtureBaseBranch = baseBranch
  metric.fixtureBaseCommit = execFileSync('git', ['--git-dir', barePath, 'rev-parse', `refs/heads/${baseBranch}`], { encoding: 'utf8' }).trim()
  const fixtureReadme = execFileSync('git', ['--git-dir', barePath, 'show', `${metric.fixtureBaseCommit}:README.md`], { encoding: 'utf8' })
  const verifyCommand = `node -e ${quote(`const fs = require('node:fs'), assert = require('node:assert/strict'); assert.equal(fs.readFileSync('cloud-acceptance.txt', 'utf8').trim(), ${JSON.stringify(marker)}); assert.equal(fs.readFileSync('README.md', 'utf8'), ${JSON.stringify(fixtureReadme)});`)}`
  for (const current of sourceRuntimes) await pool.query('UPDATE device_repos SET "repoPath"=$2,"remoteUrl"=$3,"baseBranch"=$4,"verifyCommand"=$6 WHERE id=$1 AND "userId"=$5', [current.repoId, remoteKey(repository), repository, baseBranch, actor.userId, verifyCommand])
  await wait(async () => { try { return (await send(`${relayOrigin}/mikka/v1/probe`, { signal: abort.signal })).status === 401 } catch { return false } })

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
  const queued = await api(`/api/bots/${botId}/computer/runs`, { issueId: issue.id, harness: 'claude_code', note: `Use the selected ${metric.model}. Write cloud-acceptance.txt with ${marker}, then submit. Do not push or open a PR.` })
  runId = queued.runId
  assert.ok(runId)
  const frozen = (await pool.query('SELECT r."agentDefinition",k.provider FROM agent_runs r JOIN model_api_keys k ON k.id=(r."agentDefinition"->\'apiKey\'->>\'keyId\')::uuid AND k."ownerId"=r."userId" WHERE r.id=$1 AND r."userId"=$2', [runId, actor.userId])).rows[0]
  assert.equal(frozen?.provider, 'deepseek', 'Cloud run must freeze the selected provider at the LiteLLM boundary')
  assert.equal(frozen.agentDefinition.modelSource, 'api_key')
  assert.equal(frozen.agentDefinition.model, metric.model)
  const provider = {
    create: async (template, operationId, metadata) => {
      assert.equal(template, codingTemplate, 'The actual E2B create must use the official coding template')
      metric.machineSource = 'official-template'
      metric.workspaceSnapshotsUsed = 0
      metric.createRequestedAt = new Date().toISOString()
      const began = performance.now()
      const sandbox = await Sandbox.create(template, { ...connection, idempotencyKey: operationId, timeoutMs: 900_000, metadata: { ...metadata, purpose: 'isolated-cloud-task', acceptance: id } })
      sandboxIds.add(sandbox.sandboxId)
      metric.e2bCreateMs = Math.round(performance.now() - began)
      const taskBootstrap = performance.now()
      await bootstrapOfficialInstance(sandbox, template)
      metric.taskInstanceBootstrapMs = Math.round(performance.now() - taskBootstrap)
      const fixtureStarted = performance.now()
      // This transport credential is a separate read-only capability for the
      // disposable fixture, never a device token. It stays under the daemon's
      // existing SRT denyRead path; the repository config and agent env omit it.
      const gitConfig = '/home/user/.mikka/worker/adapters/pids/fixture-git.config'
      // install sets ownership only on named directories, not implicit parents.
      await sandbox.commands.run('install -d -o user -g user -m 700 /home/user/.mikka/worker /home/user/.mikka/worker/adapters /home/user/.mikka/worker/adapters/pids', { user: 'root' })
      await sandbox.files.write(gitConfig, `[http "${repository}"]\n\tsslCAInfo = /opt/mikka/fixture-ca.pem\n\textraHeader =\n\textraHeader = Authorization: Bearer ${repoToken}\n`, { user: 'root' })
      await sandbox.files.write('/opt/mikka/runtime/harness-bin/git', `#!/bin/sh\nif test -r ${gitConfig}; then exec /usr/bin/git -c include.path=${gitConfig} "$@"; fi\nexec /usr/bin/git "$@"\n`, { user: 'root' })
      await sandbox.commands.run(`chown user:user ${gitConfig}; chmod 600 ${gitConfig}; chown root:root /opt/mikka/runtime/harness-bin/git; chmod 755 /opt/mikka/runtime/harness-bin/git`, { user: 'root' })
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
  assert.equal(done.report?.verify.status, 'passed', 'The cloud daemon must verify the generated file and unchanged README')
  assert.equal(done.report.verify.command, verifyCommand)
  assert.equal(metric.policyIssuer, `${relayOrigin}/mikka`)
  const taskMachine = (await pool.query('SELECT "sandboxId" FROM thread_machines WHERE "runId"=$1 AND "ownerId"=$2', [runId, actor.userId])).rows[0]
  assert.ok(taskMachine?.sandboxId && sandboxIds.has(taskMachine.sandboxId))
  const taskSandbox = await Sandbox.connect(taskMachine.sandboxId, connection)
  const content = await taskSandbox.files.read(`/home/user/.mikka/worker/worktrees/${runId}/cloud-acceptance.txt`, { user: 'user' })
  assert.ok(content.includes(marker), 'The actual isolated worker worktree lacks the model-written marker')
  const base = (await taskSandbox.commands.run(`git -C /home/user/.mikka/worker/worktrees/${runId} merge-base HEAD ${quote(`origin/${baseBranch}`)}`, { user: 'user', timeoutMs: 10_000 })).stdout.trim()
  assert.equal(base, metric.fixtureBaseCommit, 'The task must branch from the repository-declared default base commit')
  metric.runId = runId
  metric.status = done.status
  metric.modelTransport = 'fake-litellm'
  metric.verificationPassed = true
  metric.latencyIncludes = ['scripted LiteLLM response', 'restricted local TLS relay and fixture transport setup', 'actual application, native CLI and worker startup']
  metric.normalAccountLease = true
  metric.productionDbWrites = false
  metric.testTransport = 'loopback HTTPS relay; real E2B SDK to HTTP fake with a synthetic key'
  await writeFile(resolve(directory, 'result.json'), JSON.stringify(metric, null, 2), { mode: 0o600 })
  console.log(JSON.stringify(metric))
}

export async function verifyCloud(input = {}) {
  assert.equal(started, false, 'Use a fresh process for another cloud acceptance run')
  started = true
  options = input
  assert.ok(!input.apiKey, 'LOCAL_CLOUD_PROVIDER_KEY_REFUSED')
  assert.ok(disposableDatabase(process.env), 'Cloud acceptance requires the owning isolated database environment')
  let failure
  try {
  input.signal?.throwIfAborted()
  release = cloudAcceptanceRelease({ sourceCommit: input.sourceCommit, workerHash: input.workerHash })
  process.env.MIKKA_CLOUD_WORKER_SOURCE_COMMIT = release.sourceCommit
  process.env.MIKKA_CLOUD_WORKER_SHA = release.workerHash
  // Validate the normal official-template policy before allocating anything.
  computerTemplate(); taskTemplate('claude_code')
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
  await fakeProvider?.close()
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
  await localAgent.close(); await tlsAgent?.close()
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
