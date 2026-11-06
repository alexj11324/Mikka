// HTTP acceptance only. Real app, Postgres, Workflow and daemon; synthetic model,
// GitHub and harness. This is not production, E2B or live-provider acceptance.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool } from 'pg'
import { assertMvpEnvironment, MVP_ORIGIN, MVP_SERVICES, REPOSITORY, REPOSITORY_KEY } from './isolated-env.mjs'
import { startMvpServices } from './services.mjs'
import { startTraceCollector } from './trace-collector.mjs'
import { seedMvpSubscription, seedMvpExecutionRule } from './subscription.mjs'
import { acquireTestAccounts, recordAuthenticationSecrets } from '../../scripts/test-accounts/session.mjs'
import { loadEnvironment } from '../../scripts/test-accounts/environment.mjs'
import { DESKTOP_RPC_VERSION, encode, decode } from '../../lib/desktop-rpc/wire.ts'
import { HostedUsageStore } from '../../lib/abuse/store.ts'

assertMvpEnvironment()
assert.equal(process.env.NODE_ENV, 'development', 'TRACE_ACCEPTANCE_REQUIRES_DEVELOPMENT_RUNTIME')
assert.equal(process.env.NEXT_PUBLIC_POSTHOG_KEY, 'phc_trace_fixture_1512')
assert.equal(process.env.MIKKA_TRACE_ENDPOINT, 'http://127.0.0.1:3196/i/v1/traces')
assert.equal(process.env.AI_GATEWAY_API_KEY, 'mvp-synthetic-decisions')
const root = resolve(import.meta.dirname, '../..')
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
assert.equal(process.env.MIKKA_TEST_DEPLOYMENT_SHA, revision)
const environment = await loadEnvironment()
assert.equal(environment.origin, MVP_ORIGIN)
const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 3, statement_timeout: 15_000 })
const directory = await mkdtemp(join(tmpdir(), 'mikka-trace-1512-'))
const evidenceDirectory = resolve(process.env.MIKKA_TRACE_EVIDENCE_DIR ?? join(root, '.cache/trace-acceptance', `${revision.slice(0, 12)}-${randomUUID()}`))
await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 })
const privateLogDirectory = join(evidenceDirectory, 'private-logs')
await mkdir(privateLogDirectory, { recursive: true, mode: 0o700 })
const children = [], results = [], collectors = []
let accounts, services, collector, phase = 'starting', failure, workflowHealth
const checkpoint = value => { phase = value; console.info(`trace-acceptance ${value}`) }
const child = (label, args, env) => {
  const job = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  // Keep bounded diagnostics privately: never copy these files into evidence
  // artifacts or print them. They can contain account and model fixture data.
  const log = createWriteStream(join(privateLogDirectory, `${label}.log`), { flags: 'wx', mode: 0o600 })
  job.label = label; job.logBytes = 0
  log.on('error', () => { job.logFailed = true })
  const capture = chunk => {
    if (job.logFailed) return
    const kept = chunk.subarray(0, Math.max(0, 8_000_000 - job.logBytes))
    job.logBytes += kept.length
    if (kept.length) log.write(kept)
  }
  job.stdout.on('data', capture); job.stderr.on('data', capture)
  job.once('close', () => log.end())
  job.on('error', () => { job.startFailed = true })
  children.push(job)
  return job
}
async function stop(job) {
  job.stopping = true
  if (job.exitCode !== null || job.signalCode !== null) return
  job.kill('SIGTERM')
  await Promise.race([new Promise(resolve => job.once('exit', resolve)), delay(5_000)])
  if (job.exitCode === null && job.signalCode === null) job.kill('SIGKILL')
}
async function until(read, timeout = 90_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    assert.ok(!children.some(job => job.startFailed), 'OWNED_PROCESS_START_FAILED')
    assert.ok(!children.some(job => !job.stopping && (job.exitCode !== null || job.signalCode !== null)), 'OWNED_PROCESS_EXITED')
    const value = await read()
    if (value) return value
    await delay(250)
  }
  throw new Error('TRACE_PHASE_TIMEOUT')
}
async function service(path, data) {
  const response = await fetch(`${MVP_SERVICES}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data), signal: AbortSignal.timeout(10_000) })
  assert.equal(response.status, 200, 'SYNTHETIC_SERVICE_REQUEST_FAILED')
  return response.json()
}

try {
  collector = await startTraceCollector(); collectors.push(collector)
  services = await startMvpServices()
  const workflowDirectory = join(directory, 'workflow')
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const preload = pathToFileURL(join(root, 'tests/mvp/trace-preload.mjs')).href
  const app = child('api', ['apps/api/scripts/dev.mjs', '--port', '3100', '--host', 'localhost'], {
    ...process.env, NODE_OPTIONS: `--import ${preload}`, WORKFLOW_TARGET_WORLD: 'local', WORKFLOW_TRACE_MODE: 'continuous',
    WORKFLOW_LOCAL_BASE_URL: MVP_ORIGIN, WORKFLOW_LOCAL_DATA_DIR: workflowDirectory,
    MIKKA_BYOS_ENABLED: '1', MIKKA_BYOS_WORKER_BINARY: join(root, 'tests/mvp/subscription-worker.mjs'),
    MIKKA_BYOS_INFISICAL_ORIGIN: MVP_SERVICES, MIKKA_BYOS_INFISICAL_PROJECT: 'mvp-synthetic', MIKKA_BYOS_INFISICAL_ENVIRONMENT: 'test',
    MIKKA_BYOS_INFISICAL_PATH: '/custody', MIKKA_BYOS_ACCESS_INFISICAL_PATH: '/access',
    MIKKA_BYOS_INFISICAL_TOKEN: 'mvp-synthetic-custody', MIKKA_BYOS_ACCESS_INFISICAL_TOKEN: 'mvp-synthetic-access', MIKKA_BYOS_VALIDATED_MODEL_ROUTES: 'codex_cpa',
    GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  })
  checkpoint('api-ready')
  await until(async () => {
    assert.equal(app.exitCode, null, 'API_PROCESS_EXITED')
    return fetch(`${MVP_ORIGIN}/mikka/api/version`, { signal: AbortSignal.timeout(2_000) }).then(async response => { const ok = response.ok; await response.body?.cancel(); return ok }, () => false)
  }, 240_000)
  checkpoint('workflow-ready')
  const health = await fetch(`${MVP_ORIGIN}/.well-known/workflow/v1/flow?__health`, { signal: AbortSignal.timeout(10_000) })
  const contentType = health.headers.get('content-type')?.split(';', 1)[0]
  workflowHealth = { status: health.status, contentType: ['application/json', 'text/plain', 'text/html'].includes(contentType) ? contentType : 'other', healthy: false }
  assert.equal(health.status, 200, 'WORKFLOW_ROUTE_UNAVAILABLE')
  workflowHealth.healthy = (await health.json()).healthy === true
  assert.equal(workflowHealth.healthy, true, 'WORKFLOW_ROUTE_UNAVAILABLE')
  checkpoint('account-lease')
  accounts = await acquireTestAccounts({ database: pool, environment, runId: randomUUID(), workerId: 'trace-1512', requestId: randomUUID() })
  const ownerId = accounts.owner.userId
  const subscription = await seedMvpSubscription(pool, ownerId)
  await new HostedUsageStore(pool).verify(subscription.workspaceId, `cus_trace_${ownerId}`, `card_trace_${ownerId}`)
  await pool.query('INSERT INTO issue_prefixes ("userId",prefix) VALUES ($1,$2) ON CONFLICT ("userId") DO UPDATE SET prefix=EXCLUDED.prefix', [ownerId, 'TRCE'])
  const githubAccountId = String(1_000_000 + Math.floor(Math.random() * 1_000_000))
  await pool.query('INSERT INTO account (id,"accountId","providerId","userId","createdAt","updatedAt") VALUES ($1,$2,\'github\',$3,now(),now())', [randomUUID(), githubAccountId, ownerId])
  await pool.query('INSERT INTO repository_settings ("userId","remoteKey","verifyCommand") VALUES ($1,$2,$3)', [ownerId, REPOSITORY_KEY, 'test -f MIKKA_MOCK.md'])

  for (const kind of ['success', 'failure']) {
    checkpoint(`${kind}-fixture`)
    const marker = `mvp-${randomUUID()}`, traceId = randomBytes(16).toString('hex'), sessionId = randomUUID()
    const traceparent = `00-${traceId}-${randomBytes(8).toString('hex')}-01`
    const privatePrompt = `trace-private-prompt-${randomUUID()}`, privateFailure = `trace-private-error-${randomUUID()}`
    collector.forbid(privatePrompt); collector.forbid(privateFailure)
    const scenario = await service('/scenario', { marker, title: `Trace ${kind}`, githubAccountId })
    const caseDirectory = join(directory, kind), fixtureDirectory = join(caseDirectory, 'fixtures'), daemonDirectory = join(caseDirectory, 'daemon')
    await mkdir(fixtureDirectory, { recursive: true, mode: 0o700 })
    if (kind === 'success') await copyFile(join(root, 'tests/mvp/fixtures/mvp-core-loop.jsonl'), join(fixtureDirectory, 'mvp-core-loop.jsonl'))
    else await writeFile(join(fixtureDirectory, 'mvp-core-loop.jsonl'), JSON.stringify({ t: 0, exit: { outcome: 'failed', error: privateFailure } }) + '\n', { mode: 0o600 })
    const credential = `orv_${randomBytes(32).toString('base64url')}`, tokenId = randomUUID()
    await recordAuthenticationSecrets([credential], { environment })
    await pool.query('INSERT INTO device_tokens (id,"userId",name,"tokenHash") VALUES ($1,$2,$3,$4)', [tokenId, ownerId, 'Trace acceptance daemon', createHash('sha256').update(credential).digest('hex')])
    const daemon = child(`daemon-${kind}`, ['--import', 'tsx', 'tests/mvp/start-trace-daemon.mts'], {
      ...process.env, NODE_OPTIONS: '', MIKKA_E2E_DEVICE_TOKEN: credential, MIKKA_E2E_DAEMON_DIR: daemonDirectory,
      MIKKA_TRACE_FIXTURES_DIR: fixtureDirectory, MIKKA_TRACE_FIXTURE_CONTEXT: JSON.stringify({ traceparent, sessionId, posthogDistinctId: ownerId }),
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: `url.${pathToFileURL(scenario.barePath).href}.insteadOf`, GIT_CONFIG_VALUE_0: REPOSITORY,
      GIT_CONFIG_KEY_1: 'protocol.file.allow', GIT_CONFIG_VALUE_1: 'always', GIT_TERMINAL_PROMPT: '0',
    })
    try {
      checkpoint(`${kind}-daemon-registration`)
      const device = await until(async () => {
        assert.equal(daemon.exitCode, null, 'DAEMON_PROCESS_EXITED')
        return (await pool.query('SELECT d.id FROM devices d JOIN device_token_devices t ON t."deviceId"=d.id WHERE t."tokenId"=$1 AND d."ownerId"=$2 AND d."lastSeenAt" IS NOT NULL', [tokenId, ownerId])).rows[0]
      })
      await until(async () => (await pool.query('SELECT id FROM agents WHERE "userId"=$1 AND "deviceId"=$2 AND harness=\'mock\'', [ownerId, device.id])).rows[0])
      await seedMvpExecutionRule(pool, ownerId, subscription.workspaceId, device.id)
      await service('/scenario/device', { deviceId: device.id })
      checkpoint(`${kind}-http-dispatch`)
      const response = await accounts.owner.request('/api/rpc', { method: 'POST', headers: {
        'content-type': 'application/json', accept: 'application/json', 'x-mikka-rpc': '1', traceparent,
        'x-posthog-session-id': sessionId, 'x-posthog-distinct-id': ownerId,
      }, body: JSON.stringify({ version: DESKTOP_RPC_VERSION, action: 'coordinator.sendCoordinatorMessage',
        args: encode([`Create the requested repository task. ${marker} ${privatePrompt}`, null, null, randomUUID(), { kind: 'device', deviceId: device.id }]) }) })
      assert.equal(response.status, 200, 'HTTP_DISPATCH_FAILED')
      const envelope = await response.json()
      assert.equal(envelope.ok, true, 'RPC_DISPATCH_FAILED')
      assert.deepEqual(decode(envelope.result), { queued: true })
      checkpoint(`${kind}-run-completion`)
      let execution
      const run = await until(async () => {
        // Factory starts an independent review after execution. Pin this
        // scenario's execute attempt once; a later run on the device is not it.
        if (!execution) {
          const { rows } = await pool.query(`SELECT r.id,a.id AS "attemptId",t.id AS "factoryTaskId" FROM agent_runs r
            JOIN factory_attempts a ON a."runId"=r.id AND a.stage='execute'
            JOIN factory_tasks t ON t.id=a."taskId" AND t."userId"=r."userId" AND t."issueId"=r."issueId"
            JOIN issues i ON i.id=r."issueId"
            WHERE r."userId"=$1 AND r."deviceId"=$2 AND position($3 in i.content::text)>0 LIMIT 2`, [ownerId, device.id, marker])
          assert.ok(rows.length <= 1, 'MULTIPLE_FIXTURE_EXECUTION_RUNS')
          execution = rows[0]
          if (!execution) return null
        }
        const row = (await pool.query('SELECT id,"issueId",status,"stopReason","agentDefinition"->\'traceContext\' AS carrier FROM agent_runs WHERE id=$1 AND "userId"=$2 AND "deviceId"=$3', [execution.id, ownerId, device.id])).rows[0]
        return row && ['succeeded', 'failed', 'stopped', 'cancelled'].includes(row.status) ? row : null
      }, 180_000)
      assert.equal(run.status, kind === 'success' ? 'succeeded' : 'failed', 'UNEXPECTED_RUN_OUTCOME')
      assert.equal(run.carrier?.traceparent?.slice(3, 35), traceId, 'DURABLE_RUN_LOST_TRACE')
      if (kind === 'success') {
        checkpoint(`${kind}-publication`)
        await until(async () => {
          const row = (await pool.query('SELECT status FROM run_publications WHERE "runId"=$1 AND "userId"=$2', [run.id, ownerId])).rows[0]
          if (row && ['blocked', 'skipped'].includes(row.status)) assert.fail('EXECUTION_PUBLICATION_FAILED')
          return row?.status === 'published'
        }, 60_000)
      }
      checkpoint(`${kind}-telemetry`)
      // The daemon flushes at run end; web spans/logs use their normal batch.
      // Wait for both services before checking the completed cross-service tree.
      const requiredStages = ['daemon.registration', 'daemon.run.repository', 'daemon.run.worktree', 'daemon.adapter.start']
      const postgresSpan = span => /(?:pg\.|postgresql)/i.test(span.name) || span.attributes['db.system'] === 'postgresql' || span.attributes['db.system.name'] === 'postgresql'
      await until(() => {
        const current = collector.evidence.spans.filter(span => span.traceId === traceId)
        const ids = new Set(current.map(span => span.spanId))
        const daemonRun = current.find(span => span.service === 'mikka-daemon' && span.name === 'daemon.run' && span.attributes['mikka.run_id'] === run.id)
        return daemonRun && requiredStages.every(name => current.some(span => span.name === name))
          && current.some(span => /workflow[.:]/.test(span.name))
          && current.some(span => span.service === 'mikka-web' && span.name.endsWith('/complete') && ids.has(span.parentSpanId))
          && current.some(postgresSpan)
          && collector.evidence.logs.some(log => log.spanId === daemonRun.spanId && log.traceId === traceId)
      }, 30_000)
      const spans = collector.evidence.spans.filter(span => span.traceId === traceId), ids = new Set(spans.map(span => span.spanId))
      const daemonRun = spans.find(span => span.service === 'mikka-daemon' && span.name === 'daemon.run' && span.attributes['mikka.run_id'] === run.id)
      assert.ok(daemonRun, 'DAEMON_TRACE_SPLIT')
      for (const name of requiredStages) assert.ok(spans.some(span => span.name === name), `MISSING_${name}`)
      assert.ok(spans.some(span => /workflow[.:]/.test(span.name)), 'MISSING_WORKFLOW_SPAN')
      assert.ok(spans.some(span => span.service === 'mikka-web' && span.name.endsWith('/complete') && ids.has(span.parentSpanId)), 'COMPLETION_HTTP_PARENT_MISSING')
      assert.ok(spans.some(postgresSpan), 'MISSING_POSTGRES_SPAN')
      const runLog = collector.evidence.logs.find(log => log.spanId === daemonRun.spanId && log.traceId === traceId)
      assert.ok(runLog, 'RUN_LOG_TRACE_LINK_MISSING')
      if (kind === 'failure') { assert.equal(daemonRun.status, 2, 'FAILED_RUN_SPAN_STATUS'); assert.equal(runLog.body, 'mikka.stage.failed'); assert.equal(runLog.severity, 17) }
      const generations = collector.evidence.generations.filter(event => event.properties.$ai_trace_id === traceId)
      results.push({ kind, runId: run.id, factoryTaskId: execution.factoryTaskId, attemptId: execution.attemptId, stage: 'execute', traceId, sessionId, status: run.status, spanCount: spans.length,
        syntheticGenerations: generations.length, realProviderGenerations: 0,
        spans, logs: collector.evidence.logs.filter(log => log.traceId === traceId), generations })
    } finally {
      await pool.query('UPDATE device_tokens SET "revokedAt"=now() WHERE id=$1', [tokenId])
      await stop(daemon)
    }
  }
  // Allow the web SDK's normal 10s batch to arrive; no flush-only test API is added.
  await until(() => results.every(result => collector.evidence.generations.some(event => event.properties.$ai_trace_id === result.traceId)), 20_000)
  for (const result of results) {
    result.spans = collector.evidence.spans.filter(span => span.traceId === result.traceId)
    result.generations = collector.evidence.generations.filter(event => event.properties.$ai_trace_id === result.traceId)
    result.syntheticGenerations = result.generations.length
    const ids = new Set(result.spans.map(span => span.spanId))
    for (const event of result.generations) {
      assert.ok(ids.has(event.properties.$ai_span_id), 'GENERATION_APM_LINK_MISSING')
      assert.equal(event.properties.$ai_session_id, result.sessionId, 'GENERATION_SESSION_LINK_MISSING')
    }
  }
  assert.equal(collector.evidence.privacyViolations, 0, 'PRIVATE_TEXT_EXPORTED')
  assert.equal(collector.evidence.malformed, 0, 'MALFORMED_TELEMETRY')
  assert.equal(collector.evidence.dropped, 0, 'COLLECTOR_CAPACITY_EXCEEDED')
  checkpoint('passed')
} catch (error) {
  const code = typeof error?.message === 'string' ? error.message.split('\n')[0] : ''
  failure = { phase, code: /^[A-Z0-9_.-]{1,100}$/.test(code) ? code : 'TRACE_ACCEPTANCE_FAILED' }
  process.exitCode = 1
} finally {
  if (accounts) await accounts.release({ outcome: 'dirty' }).catch(() => { process.exitCode = 1 })
  for (const job of children.reverse()) await stop(job)
  await services?.close()
  for (const current of collectors) await current.close()
  await pool.end()
  const evidence = { version: 1, revision, result: process.exitCode ? 'failed' : 'passed', failure, workflowHealth, cases: results,
    processes: children.map(job => ({ label: job.label, exitCode: job.exitCode, signal: job.signalCode,
      privateLogRetained: !job.logFailed, privateLogBytes: job.logBytes })),
    counts: collector ? { spans: collector.evidence.spans.length, logs: collector.evidence.logs.length,
      syntheticGenerations: collector.evidence.generations.length, realProviderGenerations: 0,
      privacyViolations: collector.evidence.privacyViolations, malformed: collector.evidence.malformed, dropped: collector.evidence.dropped } : {},
    boundaries: ['real development HTTP API, Postgres, WorkflowAgent/durable steps and source daemon',
      'synthetic model/subscription and GitHub API; real git clone/worktree/verify/commit/push',
      'existing test-only mock harness, no real CLI model generation', 'synthetic equivalent of cloud public trace bootstrap; no E2B VM was created',
      'no browser, production, Preview, real-provider, replay-UI or deployment acceptance'],
  }
  await writeFile(join(evidenceDirectory, 'trace-chain.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
  console.info(JSON.stringify({ traceAcceptance: evidence.result, revision, phase, cases: results.map(({ kind, runId, traceId, status }) => ({ kind, runId, traceId, status })), counts: evidence.counts, evidenceFile: join(evidenceDirectory, 'trace-chain.json'), ...(failure ? { failure } : {}) }))
}
