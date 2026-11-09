import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { readOptions, nativeCommand, nativeReceipt, productionCanaryPlan, runTaskSecretsAcceptance, safeFailure } from './task-secrets.mjs'
import { nativeScope, nativeGitProof, scanCanary, productionHttpProof } from './task-secrets-native.mjs'
import { buildFixtureBundles, createIsolatedFixture, cleanupIsolatedFixture } from './task-secrets-fixture.mjs'
import { createSecretBudget, createSecretEvidenceStore, readSecretJobStart, SECRET_BUDGET, writeSecretCheckpoint, readSecretJournal, secretMutation, secretJournal } from './task-secrets-journal.mjs'
import { collectTaskSecretEvidence } from './task-secrets-evidence.mjs'
import { cleanupTaskSecrets, exactCleanupClient } from './task-secrets-cleanup.mjs'
import { startFixture } from './task-secrets-fixture-runtime.mjs'
import { cleanupCase } from './cloud-startup.mjs'
import { canaryWindow, createOwnerIdleVerifier, createProductionCanary, productionDelivery } from './task-secrets-production-canary.mjs'
import { startTaskSecretBridge } from '../../packages/daemon/src/task-secret-bridge.ts'
import { issueEgressCapability } from '../../lib/secrets/egress-capability.ts'
import { executeEgressRequest } from '../../lib/secrets/egress-http.ts'
import { taskSecretEgressResponse } from '../../lib/secrets/egress-route.ts'

const hash = value => createHash('sha256').update(value).digest('hex')
const caseId = '11111111-1111-4111-8111-111111111111', runId = '22222222-2222-4222-8222-222222222222'
const config = { caseId, harness: 'codex', repository: 'alexj11324/Mikka-handoff', sourceCommit: 'a'.repeat(40),
  workerSha: 'b'.repeat(40), workerSourceCommit: 'c'.repeat(40), fixtureOrigin: 'https://8081-fixture.e2b.app',
  upstreamOrigin: 'https://8080-fixture.e2b.app', bootstrapToken: 'd'.repeat(64), canarySha256: 'e'.repeat(64), responseSha256: 'f'.repeat(64) }
const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: config.sourceCommit,
  GITHUB_REPOSITORY: 'alexj11324/Mikka', GITHUB_RUN_ID: '990', GITHUB_RUN_ATTEMPT: '1', TASK_SECRETS_JOB_STARTED_AT: new Date().toISOString(),
  TASK_SECRETS_JOB_ID: '991', TASK_SECRETS_JOB_START_SOURCE: 'github_actions_job.started_at',
  APPLICATION_SHA: config.sourceCommit, EXPECTED_WORKER_SHA: config.workerSha, EXPECTED_WORKER_SOURCE_SHA: config.workerSourceCommit,
  EXPECTED_CLAUDE_TEMPLATE: 'released-claude', EXPECTED_CODEX_TEMPLATE: 'released-codex' }

test('default is read-only preflight; execute requires exact main and worker/template pins', () => {
  assert.equal(readOptions([], env).execute, false)
  assert.equal(readOptions(['--execute'], env).execute, true)
  for (const patch of [{ GITHUB_ACTIONS: 'false' }, { GITHUB_EVENT_NAME: 'push' }, { GITHUB_REF: 'refs/heads/other' },
    { APPLICATION_SHA: 'e'.repeat(40) }, { EXPECTED_WORKER_SHA: '' }, { EXPECTED_CODEX_TEMPLATE: '' }, { TASK_SECRETS_MODEL_CASE: 'paid' }]) {
    assert.throws(() => readOptions(['--execute'], { ...env, ...patch }))
  }
  assert.throws(() => readOptions(['--execute', '--execute'], env))
  assert.throws(() => readOptions(['--allow-production'], env))
})

test('production canary requires explicit execute, a bounded reserved window and existing DB binding before account access', async () => {
  let touched = false
  assert.throws(() => readOptions(['--execute', '--production-canary'], env), /canary_window/)
  assert.throws(() => readOptions(['--production-canary'], env), /configuration/)
  const windowEnv = { TASK_SECRETS_WINDOW: JSON.stringify({ comment: 'https://github.com/alexj11324/Mikka/issues/1752#issuecomment-123',
    expiresAt: new Date(Date.now() + 20 * 60_000).toISOString() }) }
  const result = await runTaskSecretsAcceptance({ ...readOptions(['--execute', '--production-canary'], { ...env, ...windowEnv }) }, {
    env: {}, sessionClient: () => { touched = true; throw Error('unexpected') }, createFixture: () => { touched = true; throw Error('unexpected') },
  })
  assert.equal(touched, false)
  assert.equal(result.status, 'blocked')
  assert.equal(result.productionStoreMutated, false)
  assert.equal(result.failure, 'task_secrets_canary_database_unavailable')
  assert.deepEqual(result.productionCanary, productionCanaryPlan())
  assert.equal(result.productionCanary.executed, false)
  assert.ok(result.productionCanary.changes.includes('delete_only_created_fixture_ids'))
})

test('native scope fixes the repository, branch prefix, model harness and public fixture origin', () => {
  assert.equal(nativeScope(config).branch, `acceptance/1712/${caseId}/codex`)
  for (const patch of [{ repository: 'alexj11324/Mikka' }, { caseId: '../main' }, { harness: 'paid' },
    { fixtureOrigin: 'https://example.com' }, { fixtureOrigin: 'http://8081-fixture.e2b.app' },
    { fixtureOrigin: 'https://user:pass@8081-fixture.e2b.app' }, { upstreamOrigin: 'https://8080-fixture.e2b.app/private' },
    { workerSourceCommit: 'main' }, { bootstrapToken: 'short' }]) assert.throws(() => nativeScope({ ...config, ...patch }))
})

test('the exact native launcher verifies bundle bytes and never includes the synthetic canary or sealing key', () => {
  const command = nativeCommand(config, '7'.repeat(64))
  assert.match(command, /hashlib\.sha256\(source\)\.hexdigest\(\)/)
  assert.match(command, /TemporaryDirectory/)
  assert.match(command, /check=True, timeout=300/)
  assert.doesNotMatch(command, /WORKSPACE_SECRETS_KEY|SMOKE_OWNER_PASSWORD|mikka1712s_[a-f0-9]{64}/)
  assert.throws(() => nativeCommand({ ...config, fixtureOrigin: 'https://evil.example' }, '7'.repeat(64)))
})

function goodReceipt() {
  const scan = { matched: false, files: 10, bytes: 1000, unavailable: 0, truncated: false }
  return { version: 1, caseId, runId, harness: 'codex', status: 'passed', productionStoreMutated: false,
    runtime: { workerSha: config.workerSha, sourceCommit: config.workerSourceCommit, node: 'v24.0.0' }, before: scan, after: scan,
    github: { branch: `acceptance/1712/${caseId}/codex`, filename: `acceptance-1712-${caseId}.txt`, cleanup: true,
      commit: '1'.repeat(40), defaultBranchBefore: '2'.repeat(40), defaultBranchAfter: '2'.repeat(40), draftPrNumber: 3,
      fileSha256: '4'.repeat(64), fileBytes: 100, githubActorHash: '5'.repeat(16), times: { cloneMs: 1, fetchMs: 2, pushMs: 3, draftPrMs: 4 } },
    http: { scope: 'isolated_key_and_canary_real_egress_and_bridge_code', samples: 10, productionClaimTested: false,
      productionStoreRotationTested: false, direct: { p50Ms: 1, p95Ms: 2 }, protected: { p50Ms: 3, p95Ms: 4 },
      statuses: { method: 403, path: 403, echo: 502, redirect: 502, origin: 403, authOverride: 403, expired: 410, crossRun: 403, rotatedKey: 401 } } }
}
function toolPair(value, command) {
  return { chunks: [{ chunk: { type: 'tool-input-available', toolCallId: `${runId}:tool1`, toolName: 'bash', input: { command } } },
    { chunk: { type: 'tool-output-available', toolCallId: `${runId}:tool1`, output: `MIKKA_1712_NATIVE ${JSON.stringify(value)}\n` } }] }
}

test('only the exact native tool input/output pair can supply a receipt; model prose and other runs cannot', () => {
  const command = nativeCommand(config, '7'.repeat(64)), expected = { ...config, runId }
  const output = nativeReceipt(toolPair(goodReceipt(), command), expected, command)
  assert.equal(output.status, 'passed')
  assert.equal(output.github.cleanup, true)
  assert.equal(output.http.productionClaimTested, false)
  assert.equal(nativeReceipt({ chunks: [{ chunk: { type: 'text-delta', delta: `MIKKA_1712_NATIVE ${JSON.stringify(goodReceipt())}` } }] }, expected, command), null)
  assert.equal(nativeReceipt(toolPair(goodReceipt(), command + '\necho changed'), expected, command), null)
  const wrong = toolPair(goodReceipt(), command)
  wrong.chunks.forEach(item => { item.chunk.toolCallId = `${randomUUID()}:tool1` })
  assert.equal(nativeReceipt(wrong, expected, command), null)
})

test('receipt projection drops arbitrary credentials/URLs and refuses unconfirmed cleanup, leaked canaries and changed versions', () => {
  const command = nativeCommand(config, '7'.repeat(64)), expected = { ...config, runId }
  const value = goodReceipt()
  value.secret = 'DO_NOT_EXPORT'; value.runtime.env = 'DO_NOT_EXPORT'; value.github.token = 'DO_NOT_EXPORT'; value.http.url = 'DO_NOT_EXPORT'
  assert.doesNotMatch(JSON.stringify(nativeReceipt(toolPair(value, command), expected, command)), /DO_NOT_EXPORT/)
  for (const mutate of [value => { value.github.cleanup = false }, value => { value.before.matched = true },
    value => { value.runtime.workerSha = '0'.repeat(40) }, value => { value.github.defaultBranchAfter = '3'.repeat(40) },
    value => { value.http.productionClaimTested = true }, value => { value.http.statuses.echo = 200 }]) {
    const changed = goodReceipt(); mutate(changed)
    assert.throws(() => nativeReceipt(toolPair(changed, command), expected, command))
  }
})

/** Exercise the real driver and its observeChunks callback; only external
 * account/provider transports and the live delivery of one snapshot are fake. */
async function normalCloudCase(changeDetail = () => {}, releaseAttestation, production = false, evidenceOptions = {}) {
  const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  const ownerId = 'synthetic-smoke-owner', adminId = 'synthetic-team-admin', workspaceId = uuid(1), botId = uuid(2)
  const deviceId = uuid(5), connectionId = uuid(6), privateSecretId = uuid(9)
  let profileId = uuid(3), issueId = uuid(4), actualRunId = runId, sequence = 0, active = false, privateSecret
  const email = 'acceptance+mikka-smoke@example.invalid', model = 'gpt-6-luna', digest = '6'.repeat(64)
  const source = { kind: 'subscription', connectionId }, calls = [], createdProfileIds = new Set()
  let profile, issue, bot, machineEnded = false, observed = false
  const workspace = { currentUserId: ownerId, workspace: { id: workspaceId, kind: 'team' }, role: 'member',
    choices: [{ id: workspaceId, kind: 'team' }],
    members: [{ userId: adminId, email: 'alex@acme.aspectlylabs.com', role: 'admin', status: 'active' }] }
  const client = {
    clear() {},
    async request(path) {
      calls.push(path)
      if (path === '/api/auth/sign-in/email' || path === '/api/auth/sign-out') return new Response('{}')
      assert.equal(path, `/api/coordinator/stream?botId=${botId}&wait=1`)
      return new Response([{ type: 'tool', name: 'dispatch_run', state: 'running', call: 'dispatch', input: issueId },
        { type: 'tool', name: 'dispatch_run', state: 'done', call: 'dispatch' }].map(item => JSON.stringify(item)).join('\n') + '\n',
      { headers: { 'content-type': 'application/x-ndjson' } })
    },
    async json(path, init) {
      calls.push(path)
      if (path === '/api/version') return { build: config.sourceCommit }
      if (path === '/api/auth/get-session') return { user: { id: ownerId, email } }
      if (path === '/api/workspace' || path === `/api/workspace?workspace=${workspaceId}`) return workspace
      if (path === '/api/rpc') {
        assert.deepEqual(JSON.parse(init.body), { version: 1, action: 'workspace.switchWorkspace', args: [workspaceId] })
        return { version: 1, ok: true, result: { ok: true, data: { workspaceId } } }
      }
      if (path === `/api/settings/api-keys?workspace=${workspaceId}`) return { apiKeyAfterQuota: false }
      if (path === '/api/integrations/github') return { viewerId: ownerId, connected: true, repositories: [{ fullName: config.repository }] }
      if (path.startsWith('/api/issues/search?')) return { items: [], truncated: false, nextCursor: null }
      if (path === `/api/bots/${botId}`) return bot
      if (path === '/api/factory/agent-profiles') {
        if (production) { sequence++; profileId = uuid(300 + sequence); issueId = uuid(400 + sequence); actualRunId = uuid(500 + sequence); machineEnded = false }
        profile = { ...JSON.parse(init.body).profile, id: profileId, version: 1, digest }
        createdProfileIds.add(profileId)
        return { profile }
      }
      if (path.startsWith('/api/factory/agent-profiles/') && createdProfileIds.has(path.split('/').at(-1))) { assert.equal(init.method, 'DELETE'); return {} }
      if (path === '/api/secrets/delivery?scope=personal') return { scope: 'personal', secrets: privateSecret ? [structuredClone(privateSecret)] : [] }
      if (path === '/api/secrets/delivery') {
        const command = JSON.parse(init.body); assert.equal(command.id, privateSecretId)
        privateSecret.delivery = command.delivery; return { scope: 'personal', secret: structuredClone(privateSecret) }
      }
      if (path === `/api/runs/${actualRunId}/evidence`) return { run: {
        id: actualRunId, issueId, harness: 'codex', model, credentialType: 'subscription', subscriptionRoute: 'codex_cli',
        agentProfile: { profileId, version: 1, digest, source: 'explicit' },
        executionIdentity: { version: 1, requester: ownerId, executionPrincipal: ownerId, botId, botOwner: ownerId,
          outputOwner: ownerId, workspaceId, personalResourcePolicy: 'requester_only',
          billingAccount: { model: { kind: 'subscription', ownerId: adminId, resourceId: connectionId },
            runtime: { kind: 'e2b', ownerId, resourceId: ownerId } },
          resourceBindings: [{ kind: 'device', id: deviceId, ownerId, access: 'owner' },
            { kind: 'subscription', id: connectionId, ownerId: adminId, access: 'workspace_share', revision: '1' }] },
      } }
      if (path === `/api/factory/tasks?issueId=${issueId}`) return { issueId, tasks: [] }
      if (path === `/api/threads/${actualRunId}/machine`) {
        evidenceOptions.events?.push({ kind: 'machine_end', runId: actualRunId })
        machineEnded = true; return { runId: actualRunId, state: 'ended' }
      }
      assert.fail(`unexpected json path: ${path}`)
    },
    async rpc(name, args) {
      calls.push(name)
      if (['task-runs.pollThreads', 'task-runs.pollTaskRuns'].includes(name)) return { items: [] }
      if (name === 'model-order.getModelOrder') return { candidates: [{ harness: 'codex', model, source, credentialOwnerId: adminId }] }
      if (name === 'bots.createBot') { bot = { ...args[0], id: botId }; return bot }
      const selected = { id: connectionId, provider: 'codex', modelId: model }
      if (name === 'execution-settings.getBotModelMenu') return { groups: [{ kind: 'subscription', provider: 'codex', owner: adminId, options: [selected] }] }
      if (name === 'execution-settings.chooseBotModel') return { current: { ...selected, kind: 'subscription', chosen: true, available: true } }
      if (name === 'issues.saveIssue') { issue = { ...args[0], id: issueId, revision: 1 }; return { issue } }
      if (name === 'coordinator.sendCoordinatorMessage') { active = true; return {} }
      if (['coordinator.stopCoordinatorTurn', 'issue-operations.setIssueDeleted'].includes(name)) return {}
      if (name === 'user-secrets.createMySecret') {
        privateSecret = { id: privateSecretId, name: args[0].name, note: args[0].note, kind: 'secret', delivery: { mode: 'protected' } }
        return { ok: true, data: structuredClone(privateSecret) }
      }
      if (name === 'user-secrets.replaceMySecret') { assert.equal(args[0].id, privateSecretId); active = false; return { ok: true, data: structuredClone(privateSecret) } }
      if (name === 'user-secrets.deleteMySecret') { assert.equal(args[0].id, privateSecretId); privateSecret = undefined; return { ok: true, data: { id: privateSecretId } } }
      if (name === 'agents.pollIssueThreads') return { threads: [{ id: actualRunId, ownedByCurrentUser: true }] }
      if (name === 'agents.getThreadMachine') return { kind: 'cloud', state: machineEnded ? 'ended' : 'running',
        cloud: machineEnded ? null : { template: env.EXPECTED_CODEX_TEMPLATE, sandboxId: 'synthetic-task-vm' } }
      if (name === 'agents.getIssueThread') return { thread: { id: actualRunId, status: 'stopped', attempts: [{ runId: actualRunId, status: 'stopped' }] } }
      if (name === 'issues.getIssue') return { issue }
      if (name === 'workspace.switchWorkspace') return { workspaceId }
      assert.fail(`unexpected rpc: ${name}`)
    },
  }
  const options = readOptions(production ? ['--execute', '--production-canary'] : ['--execute'], { ...env, TASK_SECRETS_MODEL_CASE: 'codex',
    ...(production ? { TASK_SECRETS_WINDOW: JSON.stringify(windowAt(Date.now())) } : {}) })
  const directory = await mkdtemp(join(tmpdir(), 'mikka-1712-driver-'))
  options.reportPath = join(directory, 'report.json')
  const productionCases = new Map()
  if (releaseAttestation) options.releaseAttestation = releaseAttestation
  const report = await runTaskSecretsAcceptance(options, {
    signal: evidenceOptions.abort?.signal,
    env: { SMOKE_OWNER_EMAIL: email, SMOKE_OWNER_PASSWORD: 'synthetic-test-password', ...(production ? { MIKKA_DATABASE_URL: 'synthetic-test-binding' } : {}) }, sessionClient: () => client,
    buildBundles: async () => ({ client: { sha256: '7'.repeat(64) } }),
    createFixture: async () => ({ evidence: { scope: 'synthetic-test-transport' }, fixtureOrigin: config.fixtureOrigin, upstreamOrigin: config.upstreamOrigin,
      createCase: async id => ({ caseId: id, bootstrapToken: config.bootstrapToken, canarySha256: config.canarySha256, responseSha256: config.responseSha256 }),
      createProductionCase: async (id, value) => {
        productionCases.set(id, { revocation: productionCases.size === 0 })
        return { caseId: id, canarySha256: hash(value), responseSha256: config.responseSha256, sdkResponseSha256: '6'.repeat(64) }
      },
      bind: async (_id, actualRun) => { assert.equal(actualRun, actualRunId) },
      waitForProtected: async id => ({ caseId: id, runId: actualRunId, protectedRequests: 1 }),
      receipt: async id => production ? { runId: actualRunId, mode: 'production_claim', issued: false, rotated: false,
        counts: productionCases.get(id).revocation ? { protected: 1, public: 1, echo: 0, redirect: 0, sdk: 0 } : { protected: 10, public: 10, echo: 1, redirect: 1, sdk: 1 } }
        : ({ runId: actualRunId, issued: true, rotated: true, counts: { protected: 10, public: 10, echo: 1, redirect: 1 } }),
      deleteCase: async () => {}, close: async () => ({ status: 'passed' }) }),
    createCanary: args => createProductionCanary(args, { verifierFactory: async () => ({
      assertIdle: async allowed => {
        assert.ok(!active || allowed.includes(actualRunId))
        return { ownedActiveCount: active ? 1 : 0, ownedStopRequestedCount: 0, foreignActiveCount: 0, atomicWithMutation: false }
      },
      assertRevoked: async actual => { assert.equal(actual, actualRunId); assert.equal(active, false); return { status: 'stopped', leaseExpired: true } },
      readRunEvidence: async (actual, control) => {
        assert.deepEqual(actual, { runId: actualRunId, issueId, workspaceId, botId })
        assert.ok(control.signal instanceof AbortSignal && control.timeoutMs <= 5000)
        return { ...actual, status: evidenceOptions.nonterminal || active ? 'running' : 'stopped', observedAt: new Date().toISOString(),
          persistedTrace: { status: 'missing', reason: 'synthetic_transport_has_no_database_trace' } }
      },
      collectObjects: async args => {
        assert.equal(machineEnded, false, 'server evidence precedes normal VM retirement')
        assert.deepEqual(args.scope, { ownerId, workspaceId, botId, issueId, runId: actualRunId })
        evidenceOptions.events?.push({ kind: 'collect', runId: actualRunId, generations: args.canaries.generations.length })
        const body = Buffer.from(JSON.stringify({ prompt: 'Synthetic persisted prompt', agentDefinition: {} }))
        const result = await collectTaskSecretEvidence({ ...args, saveObject: async object => {
          await args.saveObject(object)
          if (evidenceOptions.abort && object.inventoryStatus === 'pending_verification') evidenceOptions.abort.abort()
        }, query: async (sql, values, control) => {
          assert.deepEqual(values.slice(0, 5), [ownerId, workspaceId, botId, issueId, actualRunId])
          assert.ok(control.timeoutMs <= 5000 && !control.signal.aborted)
          if (sql.includes('task-secret-evidence:scope')) return { rows: [{ id: actualRunId, userId: ownerId,
            workspaceId, botId, issueId, status: 'stopped', updatedAt: '2026-11-09T00:00:00.000Z', readOnly: 'on',
            messageGaps: 0, checkpointGaps: 0, captureGaps: 0, captureStepGaps: 0, receiptGaps: 0, artifactGaps: 0 }] }
          if (sql.includes('task-secret-evidence:run_definition')) return { rows: values[5] ? [] : [{ id: actualRunId,
            cursor: actualRunId, attributes: {}, rawBytes: body.length, rawSha256: hash(body), body: values[7] ? body : null }] }
          return { rows: [] }
        } })
        evidenceOptions.results?.push(result)
        return result
      },
      close: async () => {},
    }) }),
    watch: async (_client, record, _timeout, _socket, now, _cleanupIds, hooks) => {
      observed = true
      const text = issue.content.content[0].content[0].text, command = text.slice(text.indexOf("python3 - <<'MIKKA_1712_PY'"))
      const receipt = goodReceipt(); receipt.caseId = record.caseId; receipt.runId = actualRunId; active = false
      receipt.github.branch = `acceptance/1712/${record.caseId}/codex`; receipt.github.filename = `acceptance-1712-${record.caseId}.txt`
      if (production) {
        receipt.productionStoreMutated = true
        Object.assign(receipt.http, { scope: 'production_store_actual_claim_inherited_bridge', productionClaimTested: true,
          productionStoreRotationTested: true, sdk: { ordinaryTransport: true, customFetch: false, retries: 0,
            responseSha256: '6'.repeat(64), finishReason: 'stop', inputTokens: 2, outputTokens: 3 } })
      }
      const pair = toolPair(receipt, command).chunks
      for (const { chunk } of pair) chunk.toolCallId = `${actualRunId}:tool1`
      const detail = { thread: { id: actualRunId, status: 'stopped' }, chunks: [
        { chunk: { type: 'data-run-stage', data: { stage: 'agent_start', ms: 10, ok: true } } },
        ...pair,
        { chunk: { type: 'text-delta', delta: `STARTUP_OK_${record.sampleId}` } },
      ] }
      changeDetail(detail, record, now())
      if (!await hooks.observe(detail)) throw Error('startup_ended_before_execution_proof')
    },
  })
  if (evidenceOptions.inspect) await evidenceOptions.inspect(directory, report)
  if (directory) await rm(directory, { recursive: true, force: true })
  assert.equal(observed, true, JSON.stringify(report))
  assert.equal(report.cleanup.errors.length, 0)
  assert.equal(report.cases[0].cleanup.status, 'passed')
  assert.ok(!calls.some(name => name.startsWith('workspace-secrets.')))
  if (!production) assert.ok(!calls.some(name => name.startsWith('user-secrets.')))
  else assert.equal(privateSecret, undefined)
  return report
}

test('normal cloud execution completes without opt-in diagnostic receipts and keeps its native proofs', async () => {
  const report = await normalCloudCase()
  assert.equal(report.status, 'scoped_external_acceptance_passed', JSON.stringify(report))
  const sample = report.cases[0]
  assert.equal(sample.native.github.cleanup, true)
  assert.equal(sample.native.http.samples, 10)
  assert.equal(sample.execution.credentialType, 'subscription')
  assert.equal(sample.machine.template, env.EXPECTED_CODEX_TEMPLATE)
  assert.equal(sample.lastStatus, 'stopped')
  assert.equal(sample.runtimeTiming, undefined)
  assert.deepEqual(sample.runtimeDiagnostics, { enabledByDriver: false, required: false, executionGateUsed: false, authorizationCensusUsed: false, status: 'not_observed' })
  assert.deepEqual(report.authorizationCensus, { source: 'unavailable', reason: 'release_attestation_not_supplied', taskCases: 'not_measured' })
})

test('manual production orchestration revokes the active owned run, verifies a fresh claim, then removes its one private entry', async () => {
  const report = await normalCloudCase(undefined, undefined, true)
  assert.equal(report.status, 'scoped_external_acceptance_passed', JSON.stringify(report))
  assert.equal(report.productionStoreMutated, true)
  assert.equal(report.productionCanary.cleanup.deleted, true)
  assert.deepEqual(report.cases.map(record => record.phase), ['revocation', 'fresh_claim'])
  assert.equal(report.cases[0].revocation.leaseExpired, true)
  assert.equal(report.cases[0].revocation.rawCapabilityReplayTested, false)
  assert.equal(report.cases[0].remoteCleanupTarget.status, 'no_git_write_in_revocation_phase')
  assert.equal(report.cases[1].native.http.productionClaimTested, true)
  assert.equal(report.cases[1].native.http.sdk.ordinaryTransport, true)
  assert.notEqual(report.cases[0].runId, report.cases[1].runId)
  assert.ok(report.externalEvidenceStillRequired.includes('raw_capability_expiry_replay'))
  assert.doesNotMatch(JSON.stringify(report), /mikka1712s_|synthetic-test-password|synthetic-test-binding/)
})

test('production object evidence uses the authenticated original owner before each VM end and writes only bounded metadata', async () => {
  const events = []
  const report = await normalCloudCase(undefined, undefined, true, { events, inspect: async (directory, value) => {
    for (const record of value.cases) {
      const evidence = record.objectEvidence
      assert.equal(evidence.serverStatus, 'complete_text_scan')
      assert.equal(evidence.fullNegativeEvidence, false)
      assert.equal(evidence.coveredCategories.length, 7)
      assert.equal(evidence.metadata.files, 1)
      assert.equal(evidence.metadata.complete, true)
      const path = join(directory, evidence.metadata.directory, `run_definition-${record.runId}.json`)
      const text = await readFile(path, 'utf8'), object = JSON.parse(text)
      assert.equal(object.object.inventoryStatus, 'verified')
      assert.equal(object.scope.runId, record.runId)
      assert.equal(object.scope.ownerHash, value.ownerHash)
      assert.equal((await lstat(path)).mode & 0o777, 0o600)
      assert.doesNotMatch(text, /Synthetic persisted prompt|synthetic-smoke-owner|"body"|mikka1712s_/)
      assert.ok(Buffer.byteLength(JSON.stringify(evidence)) < 16 * 1024)
      assert.ok(!Object.hasOwn(evidence, 'objects'))
    }
    const journal = JSON.parse(await readFile(join(directory, 'canary-journal.json'), 'utf8'))
    assert.equal(journal.objectEvidence.persistedObjects, 'see_bounded_case_receipts')
    assert.equal(journal.objectEvidence.fullNegativeEvidence, false)
    assert.ok(journal.cases.every(record => record.objectEvidence.metadata.files === 1))
  } })
  assert.equal(report.status, 'scoped_external_acceptance_passed')
  for (const record of report.cases) {
    const collect = events.findIndex(item => item.kind === 'collect' && item.runId === record.runId)
    const end = events.findIndex(item => item.kind === 'machine_end' && item.runId === record.runId)
    assert.ok(collect >= 0 && end > collect)
    assert.equal(record.objectEvidence.generationCoverage, 'all_generated_at_collection')
    assert.ok(record.objectEvidence.coveredGenerations.length > 0)
  }
})

test('a nonterminal proof or evidence cutoff never prevents exact normal machine cleanup', async () => {
  const nonterminalEvents = []
  const nonterminal = await normalCloudCase(undefined, undefined, true, { nonterminal: true, events: nonterminalEvents })
  assert.equal(nonterminal.status, 'blocked')
  assert.ok(!nonterminalEvents.some(event => event.kind === 'collect'))
  assert.ok(nonterminalEvents.some(event => event.kind === 'machine_end'))
  assert.ok(nonterminal.cases.every(record => record.cleanup.taskRetained && record.objectEvidence.reasons.includes('run_not_ended')))
  const events = [], abort = new AbortController()
  const interrupted = await normalCloudCase(undefined, undefined, true, { abort, events, inspect: async (directory, value) => {
    const record = value.cases.find(item => item.runId), path = join(directory, 'object-evidence', record.caseId, `run_definition-${record.runId}.json`)
    const saved = JSON.parse(await readFile(path, 'utf8'))
    assert.equal(saved.object.inventoryStatus, 'incomplete')
    assert.equal(record.objectEvidence.metadata.files, 1)
    assert.equal(record.objectEvidence.serverStatus, 'incomplete')
  } })
  assert.equal(interrupted.status, 'blocked')
  assert.ok(events.some(event => event.kind === 'machine_end'))
  assert.equal(interrupted.productionCanary.cleanup.deleted, true)
  assert.equal(interrupted.cleanup.sessionClosed, true)
})

test('per-object metadata uses one bounded fixed path for pending and verified receipts and discards arbitrary content', async () => {
  const ownerId = 'synthetic-private-owner', writes = [], material = 'mikka1712s_' + 'a'.repeat(64)
  const store = createSecretEvidenceStore({ reportPath: '/synthetic-report/report.json', sourceCommit: config.sourceCommit,
    fixtureId: randomUUID(), caseId, ownerId, workspaceId: randomUUID(), botId: randomUUID(), issueId: randomUUID(), runId,
    generations: [{ format: 'synthetic_task_secret_v1', byteLength: 75, encodings: ['utf8'],
      generation: 1, sha256: hash(material), state: 'acknowledged' }] },
  { writeCheckpoint: async (path, value) => { writes.push({ path, value }) } })
  const object = { category: 'chunks', id: randomUUID(), cursor: '0', attributes: { seq: 0, content: material }, bytes: 128,
    sha256: 'a'.repeat(64), inventoryStable: false, inventoryStatus: 'pending_verification', body: material,
    url: 'https://synthetic-private-origin.invalid/?key=private', scan: { status: 'no_match_in_text', matchedGenerations: [], reasons: [] } }
  await store.saveObject(object)
  await store.saveObject({ ...object, inventoryStable: true, inventoryStatus: 'verified' })
  assert.equal(writes.length, 2); assert.equal(writes[0].path, writes[1].path)
  assert.equal(writes[0].path, `/synthetic-report/object-evidence/${caseId}/chunks-${object.id}.json`)
  assert.deepEqual(writes.map(item => item.value.object.inventoryStatus), ['pending_verification', 'verified'])
  for (const { value } of writes) {
    const text = JSON.stringify(value)
    assert.ok(Buffer.byteLength(text) < 16 * 1024)
    assert.doesNotMatch(text, /mikka1712s_|synthetic-private-owner|synthetic-private-origin|"body"|"url"/)
    assert.deepEqual(value.object.attributes, { seq: 0 })
  }
  await assert.rejects(store.saveObject({ ...object, category: '../outside' }), /journal/)
  await assert.rejects(store.saveObject({ ...object, scan: { ...object.scan, reasons: ['unknown-private-value'] } }), /journal/)
  assert.equal(writes.length, 2)
})

test('a protected request plus stopped run cannot replace the exact native command in revocation evidence', async () => {
  const report = await normalCloudCase((detail, record) => {
    if (record.phase === 'revocation') detail.chunks.find(({ chunk }) => chunk.type === 'tool-input-available').chunk.input.command += '\necho changed'
  }, undefined, true)
  assert.equal(report.status, 'blocked')
  assert.equal(report.cases[0].failure, 'task_secrets_canary_revocation')
  assert.equal(report.productionCanary.cleanup.deleted, true)
})

test('optional diagnostics cannot replace the native tool, post-tool reply, matching terminal run or external proof', async () => {
  const changes = {
    missingTool: detail => { detail.chunks = detail.chunks.filter(item => !item.chunk.type.startsWith('tool-')) },
    missingReply: detail => { detail.chunks = detail.chunks.filter(item => item.chunk.type !== 'text-delta') },
    replyBeforeTool: detail => { detail.chunks.splice(1, 0, detail.chunks.pop()) },
    notTerminal: detail => { detail.thread.status = 'running' },
    failed: detail => { detail.thread.status = 'failed' },
    cancelled: detail => { detail.thread.status = 'cancelled' },
    succeeded: detail => { detail.thread.status = 'succeeded' },
    completed: detail => { detail.thread.status = 'completed' },
    foreignTerminal: detail => { detail.thread.id = caseId },
    missingNativeProof: detail => { detail.chunks.find(item => item.chunk.type === 'tool-output-available').chunk.output = 'done' },
    missingAgentStart: detail => { detail.chunks.shift() },
  }
  for (const [name, change] of Object.entries(changes)) {
    const report = await normalCloudCase(change)
    assert.equal(report.status, 'blocked', name)
    assert.equal(report.cases[0].failure, 'startup_ended_before_execution_proof', name)
    assert.equal(report.authorizationCensus.source, 'unavailable', name)
  }
})

test('invalid, truncated and failed optional runtime diagnostics never supply an authorization census', async () => {
  for (const kind of ['invalid', 'truncated', 'failed']) {
    const report = await normalCloudCase((detail, record, now) => {
      const timing = kind === 'invalid' ? { complete: true, extraRemoteCalls: 0 } : {
        version: 1, source: 'http_server_link', window: 'run_launch_to_agent_exit', scope: 'daemon_http_server_link_and_task_fetch',
        allFirstPartyHttpComplete: false, runIdHash: record.runIdHash, harness: record.harness,
        startedAt: now - 100, endedAt: now, ms: 100, executionStartMs: 10, executionEndMs: 90,
        agentAccepted: { kind: 'codex_turn_start_ack', at: now - 90, ms: 10 }, complete: true, truncated: kind === 'truncated',
        requests: kind === 'failed' ? [{ sequence: 1, endpoint: 'provider_proxy', phase: 'executing', method: 'POST', shared: false,
          startMs: 20, endMs: 30, ms: 10, outcome: 'ok' }] : [],
        counts: kind === 'failed' ? [{ endpoint: 'provider_proxy', phase: 'executing', shared: false, started: 1, completed: 1, errors: 0, ms: 10 }] : [],
        providerOutputChunks: 1, toolCallsStarted: 1, toolCallsCompleted: 1, toolCallsFailed: 0,
      }
      detail.chunks.push({ chunk: { type: 'finish', messageMetadata: { mikkaRuntimeTiming: timing } } })
    })
    const sample = report.cases[0]
    assert.equal(sample.runtimeDiagnostics.status, 'unusable', kind)
    assert.equal(sample.runtimeDiagnostics.authorizationCensusUsed, false, kind)
    assert.equal(sample.runtimeEvidence, undefined, kind)
    assert.equal(report.authorizationCensus.source, 'unavailable', kind)
    assert.equal(report.authorizationCensus.extraRemoteCalls, undefined, kind)
  }
})

test('only an official release attestation references its candidate census, without claiming measurements for native cases', async () => {
  // readOptions/assertDriverAttestation verify this controlled object before
  // the production entry point; here exercise its report attribution only.
  const release = { sourceCommit: config.sourceCommit, upstream: { runId: 123, runAttempt: 1, workflowId: 456 },
    artifact: { id: 789, sha256: 'a'.repeat(64) }, reportSha256: 'b'.repeat(64) }
  const report = await normalCloudCase(undefined, release)
  assert.deepEqual(report.authorizationCensus, { source: 'pinned_official_release', scope: 'candidate_subscription_execution',
    samplesPerHarness: 1, taskCases: 'not_measured', sourceCommit: release.sourceCommit, upstream: release.upstream,
    artifactId: release.artifact.id, reportSha256: release.reportSha256 })
  assert.equal(report.authorizationCensus.extraRemoteCalls, undefined)
  assert.equal(report.cases[0].runtimeDiagnostics.authorizationCensusUsed, false)
})

test('the finite canary scan returns counts and booleans, never matching or unrelated file/environment values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mikka-1712-scan-test-'))
  try {
    const canary = `mikka1712s_${'9'.repeat(64)}`
    await writeFile(join(root, 'synthetic.txt'), `before ${canary} after`)
    const found = await scanCanary(hash(canary), { environment: { OTHER_PRIVATE: 'PRIVATE_VALUE' }, home: root, cwd: root })
    assert.equal(found.matched, true)
    assert.doesNotMatch(JSON.stringify(found), /mikka1712s_|PRIVATE_VALUE|synthetic.txt/)
    await rm(join(root, 'synthetic.txt'))
    assert.equal((await scanCanary(hash(canary), { environment: {}, home: root, cwd: root })).matched, false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

async function githubFake({ ambiguousCreate = false, tamperedHead = false, tamperedActor = false, oldPr = false } = {}) {
  const calls = [], commit = '1'.repeat(40), base = '2'.repeat(40), branch = `acceptance/1712/${caseId}/codex`
  let pushed = false, prCreated = false, prClosed = false, deleted = false, worktree, cleanupRead = false
  const pr = () => ({ number: 3, title: `测试 #1712 ${caseId}`, state: prClosed ? 'closed' : 'open', draft: true, merged: false, merged_at: null,
    created_at: oldPr ? '2020-01-01T00:00:00Z' : new Date().toISOString(),
    head: { ref: branch, sha: commit, repo: { full_name: config.repository } }, base: { ref: 'main', repo: { full_name: config.repository } }, user: { id: 7 } })
  const execute = async (command, args, options) => {
    calls.push({ command, args })
    const result = value => ({ stdout: typeof value === 'string' ? value : JSON.stringify(value) })
    if (command === 'git') {
      if (args[0] === 'ls-remote') {
        if (args[2] === 'refs/heads/main') return result(base + '\trefs/heads/main')
        return result(pushed && !deleted ? `${tamperedHead && prCreated ? '9'.repeat(40) : commit}\trefs/heads/${branch}` : '')
      }
      if (args[0] === 'clone') { worktree = args.at(-1); await mkdir(worktree); return result('') }
      if (args[0] === 'rev-parse') return result(commit)
      if (args[0] === 'diff-tree') return result(`acceptance-1712-${caseId}.txt`)
      if (args[0] === 'push') {
        assert.equal(args[1], 'origin')
        if (args[2] === `HEAD:refs/heads/${branch}`) pushed = true
        else if (args[2] === `:refs/heads/${branch}`) deleted = true
        else assert.fail('write outside the unique branch')
      }
      return result('')
    }
    assert.equal(command, 'gh')
    if (args[0] === 'api') {
      const path = args[1]
      if (path === 'user') assert.fail('installation tokens do not require /user')
      if (path === `repos/${config.repository}`) return result({ full_name: config.repository, default_branch: 'main', permissions: { push: true } })
      if (path.includes('/pulls?')) { cleanupRead = true; return result(prCreated ? [{ ...pr(), ...(tamperedActor ? { user: { id: 8 } } : {}) }] : []) }
      if (path.endsWith('/pulls/3')) return result({ ...pr(), ...(tamperedActor && cleanupRead ? { user: { id: 8 } } : {}) })
      if (path.includes('/contents/')) return result({ type: 'file', path: `acceptance-1712-${caseId}.txt`, encoding: 'base64',
        content: (await readFile(join(worktree, `acceptance-1712-${caseId}.txt`))).toString('base64') })
      assert.fail('unexpected GitHub path')
    }
    if (args[0] === 'pr' && args[1] === 'create') {
      assert.ok(args.includes('--draft')); assert.ok(args.includes('--body-file'))
      assert.equal(options.cwd, worktree); prCreated = true
      if (ambiguousCreate) throw Error('network response lost after write')
      return result(`https://github.com/${config.repository}/pull/3`)
    }
    if (args[0] === 'pr' && args[1] === 'close') { prClosed = true; return result('') }
    assert.fail('unexpected native command')
  }
  return { execute, calls, state: () => ({ pushed, prCreated, prClosed, deleted }) }
}

test('native Git exercises clone/fetch/push/draft-PR and verifies close/delete without a main write', async () => {
  const fake = await githubFake(), result = await nativeGitProof(config, fake)
  assert.equal(result.cleanup, true); assert.equal(result.draftPrNumber, 3)
  assert.deepEqual(fake.state(), { pushed: true, prCreated: true, prClosed: true, deleted: true })
  assert.ok(fake.calls.some(call => call.command === 'git' && call.args[0] === 'clone'))
  assert.ok(fake.calls.some(call => call.command === 'git' && call.args[0] === 'fetch'))
  assert.ok(!fake.calls.some(call => call.args.includes('--force') || call.args.includes('merge')))
})

test('ambiguous PR creation preserves remote evidence; changed heads or actors never authorize cleanup', async () => {
  const lost = await githubFake({ ambiguousCreate: true })
  await assert.rejects(nativeGitProof(config, lost), /cleanup_actor_unconfirmed/)
  assert.deepEqual(lost.state(), { pushed: true, prCreated: true, prClosed: false, deleted: false })
  const changed = await githubFake({ tamperedHead: true })
  await assert.rejects(nativeGitProof(config, changed), /cleanup_branch_changed/)
  assert.equal(changed.state().deleted, false)
  const actor = await githubFake({ tamperedActor: true })
  await assert.rejects(nativeGitProof(config, actor), /cleanup_pr_scope/)
  assert.equal(actor.state().prClosed, false)
  assert.equal(actor.state().deleted, false)
  const old = await githubFake({ oldPr: true })
  await assert.rejects(nativeGitProof(config, old), /cleanup_actor_unconfirmed/)
  assert.equal(old.state().prClosed, false)
  assert.equal(old.state().deleted, false)
})

test('normal task cleanup preserves the issue when external Git cleanup needs recovery, without changing its default', async () => {
  for (const preserveIssue of [false, true]) {
    const calls = [], record = { issueId: caseId, title: 'own test task' }
    const client = {
      json: async path => { assert.equal(path, `/api/factory/tasks?issueId=${caseId}`); return { issueId: caseId, tasks: [] } },
      rpc: async (name, args) => {
        calls.push(name)
        if (name === 'issues.getIssue') return { issue: { id: caseId, title: record.title, revision: 1 } }
        assert.equal(name, 'issue-operations.setIssueDeleted'); assert.equal(args[0].id, caseId); return null
      },
    }
    await cleanupCase(client, record, 'cloud', { preserveIssue })
    assert.equal(record.cleanup.status, 'passed')
    assert.equal(calls.includes('issue-operations.setIssueDeleted'), !preserveIssue)
    if (preserveIssue) assert.deepEqual(record.cleanup.retainedFixture, { issueId: caseId, runIds: [] })
  }
})

test('the bundled real egress and bridge source resolves without SQL/auth dependencies or secret configuration', async () => {
  const bundles = await buildFixtureBundles()
  assert.ok(bundles.server.bytes > 10000 && bundles.client.bytes > 10000 && bundles.client.bytes < 4 * 1024 * 1024)
  assert.equal(bundles.server.sha256, hash(bundles.server.source))
  assert.equal(bundles.client.sha256, hash(bundles.client.source))
  assert.doesNotMatch(bundles.server.source, /from ["'](?:pg|postgres|drizzle-orm)["']/)
})

test('the real local fixture binds one run, returns only sealed grants, and rejects expired, wrong-policy and rotated capabilities', async () => {
  const controlToken = '8'.repeat(64)
  const fixture = await startFixture({ fixtureId: caseId, controlToken, upstreamOrigin: config.upstreamOrigin,
    egressOrigin: config.fixtureOrigin }, '// synthetic reviewed test client', { listenHost: '127.0.0.1', upstreamPort: 0, egressPort: 0 })
  const local = `http://127.0.0.1:${fixture.egressAddress.port}`, upstream = `http://127.0.0.1:${fixture.upstreamAddress.port}`
  const post = (path, value, authorization) => fetch(local + path, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
    body: JSON.stringify(value), signal: AbortSignal.timeout(2000) })
  const control = value => post('/control', { caseId, ...value }, `Bearer ${controlToken}`)
  try {
    assert.equal((await post('/control', { action: 'create', caseId, bootstrapToken: config.bootstrapToken })).status, 401)
    const created = await (await control({ action: 'create', bootstrapToken: config.bootstrapToken })).json()
    assert.match(created.canarySha256, /^[a-f0-9]{64}$/)
    assert.doesNotMatch(JSON.stringify(created), /mikka1712s_|WORKSPACE_SECRETS_KEY|bootstrapToken/)
    assert.equal((await post(`/grant/${caseId}`, { runId, bootstrapToken: 'wrong' })).status, 403)
    // The grant can reach the server before the trusted control-plane bind.
    const earlyGrant = post(`/grant/${caseId}`, { runId, bootstrapToken: config.bootstrapToken })
    assert.equal((await control({ action: 'bind', runId })).status, 200)
    const response = await earlyGrant
    assert.equal(response.status, 200)
    const granted = await response.json()
    assert.equal(granted.grants.length, 1)
    assert.equal(granted.endpoint, `${config.fixtureOrigin}/egress/${runId}`)
    assert.doesNotMatch(JSON.stringify(granted), /mikka1712s_|WORKSPACE_SECRETS_KEY|bootstrapToken/)
    assert.equal((await post(`/grant/${caseId}`, { runId, bootstrapToken: config.bootstrapToken })).status, 409)
    assert.equal((await control({ action: 'bind', runId: randomUUID() })).status, 409)
    assert.equal((await fetch(`${upstream}/v1/protected/${caseId}`)).status, 401)
    const publicResponse = await fetch(`${upstream}/v1/public/${caseId}`)
    assert.equal(publicResponse.status, 200)
    assert.equal(hash(await publicResponse.text()), created.responseSha256)
    const envelope = capability => ({ capability, method: 'GET', path: `/v1/protected/${caseId}`, headers: [] })
    assert.equal((await post(`/egress/${runId}`, envelope(granted.expiredCapability))).status, 410)
    assert.equal((await post(`/egress/${runId}`, { ...envelope(granted.grants[0].capability), method: 'POST' })).status, 403)
    assert.equal((await post(`/egress/${randomUUID()}`, envelope(granted.grants[0].capability))).status, 403)
    assert.equal((await post(`/rotate/${caseId}`, { runId, bootstrapToken: config.bootstrapToken })).status, 200)
    assert.equal((await post(`/egress/${runId}`, envelope(granted.grants[0].capability))).status, 401)
    const receipt = await (await control({ action: 'receipt' })).json()
    assert.deepEqual(receipt.counts, { public: 1, protected: 0, echo: 0, redirect: 0 })
    assert.equal(receipt.rotated, true)
    assert.equal((await control({ action: 'delete' })).status, 200)
    assert.equal((await post(`/grant/${caseId}`, { runId, bootstrapToken: config.bootstrapToken })).status, 403)
  } finally { await fixture.close() }
})

test('fixture cleanup refuses a mismatched provider identity, and setup failure attempts cleanup on its own VM only', async () => {
  let killed = 0, evidence
  const sandbox = { sandboxId: 'fixture-owned', getHost: port => `${port}-fixture.e2b.app`,
    commands: { run: async command => {
      if (command.startsWith('install')) return {}
      throw Error('fixture failed')
    } }, files: { write: async () => {} },
    getInfo: async () => ({ sandboxId: 'fixture-owned', metadata: { application: 'foreign', acceptance: randomUUID() } }),
    kill: async () => { killed++; return true } }
  await assert.rejects(createIsolatedFixture({ fixtureId: caseId, sourceCommit: config.sourceCommit, apiKey: 'synthetic-key',
    bundles: { server: { source: '' }, client: { source: '' } } }, { sandboxFactory: async () => sandbox, onEvidence: value => { evidence = value } }))
  assert.equal(killed, 0)
  assert.equal(evidence.cleanup.outcome, 'unconfirmed')
  assert.equal(evidence.fixtureId, caseId)
  assert.equal(evidence.maximumLifetimeMs, 1_200_000)
  assert.doesNotMatch(JSON.stringify(evidence), /synthetic-key|controlToken|WORKSPACE_SECRETS_KEY/)
  sandbox.getInfo = async () => ({ sandboxId: 'fixture-owned', metadata: {
    application: 'mikka-1712-secret-fixture', acceptance: caseId, sourceCommit: config.sourceCommit } })
  await assert.rejects(createIsolatedFixture({ fixtureId: caseId, sourceCommit: config.sourceCommit, apiKey: 'synthetic-key',
    bundles: { server: { source: '' }, client: { source: '' } } }, { sandboxFactory: async () => sandbox, onEvidence: value => { evidence = value } }))
  assert.equal(killed, 1)
  assert.equal(evidence.cleanup.stopped, true)
  assert.equal(evidence.cleanup.outcome, 'provider_kill_acknowledged')
})

test('workflow retains ordinary automatic mode and enables production canary only through explicit manual selection', async () => {
  const source = await readFile(new URL('../../.github/workflows/task-secret-acceptance.yml', import.meta.url), 'utf8')
  assert.match(source, /group: production-smoke-owner-acceptance/)
  assert.match(source, /identity-id: 2cf9fa19-b9db-4c08-8ca0-b31859f2cbac/)
  assert.match(source, /secret-name: SMOKE_OWNER_EMAIL/)
  assert.match(source, /secret-name: SMOKE_OWNER_PASSWORD/)
  assert.match(source, /secret-name: E2B_API_KEY/)
  assert.doesNotMatch(source, /contents: write|pull-requests: write|issues: write|WORKSPACE_SECRETS_KEY|VERCEL_TEAM_TOKEN/)
  assert.match(source, /production_canary:\s+description:[^\n]+\s+type: boolean\s+default: false/)
  assert.match(source, /PRODUCTION_CANARY: \$\{\{ github.event_name == 'workflow_dispatch' && inputs.production_canary && 'true' \|\| 'false' \}\}/)
  assert.match(source, /canary-journal\.json/)
  assert.match(source, /persist-credentials: false/)
  assert.ok(source.indexOf('before credentials') < source.indexOf('Infisical/secrets-action'))
  assert.match(source, /timeout-minutes: 35/)
  assert.match(source, /Execute only selected bounded acceptance mode\s+if: env\.ACCEPTANCE_MODE != 'workspace-review'\s+timeout-minutes: 24/)
  assert.match(source, /Recover only exact journaled Task Secret fixtures\s+if: always\(\) && env\.ACCEPTANCE_MODE == 'execute'\s+timeout-minutes: 5/)
  assert.match(source, /task-secrets\.mjs --cleanup/)
  assert.ok(source.indexOf('TASK_SECRETS_JOB_STARTED_AT=') < source.indexOf('Install exact source-only dependencies'))
})

test('failures remain closed codes even when an exception carries a credential in message or cause', () => {
  assert.equal(safeFailure(Error('task_secrets_paid_fallback_enabled')), 'task_secrets_paid_fallback_enabled')
  assert.doesNotMatch(JSON.stringify(safeFailure(Error('PRIVATE_URL?token=PRIVATE_VALUE', { cause: Error('PRIVATE_CREDENTIAL') }))), /PRIVATE/)
})

const windowAt = now => ({ comment: 'https://github.com/alexj11324/Mikka/issues/1752#issuecomment-123',
  expiresAt: new Date(now + 20 * 60_000).toISOString() })

test('production window refuses missing, expired, unbounded and unrelated review references', () => {
  const now = Date.now(), window = windowAt(now)
  assert.deepEqual(canaryWindow({ TASK_SECRETS_WINDOW: JSON.stringify(window) }, now), window)
  const pullWindow = { ...window, comment: window.comment.replace('/issues/1752', '/pull/1752') }
  assert.deepEqual(canaryWindow({ TASK_SECRETS_WINDOW: JSON.stringify(pullWindow) }, now), pullWindow)
  for (const value of [null, {}, { ...window, extra: true }, { ...window, comment: 'https://example.invalid' },
    { ...pullWindow, comment: pullWindow.comment.replace('/pull/1752', '/pull/1751') },
    { ...window, expiresAt: 'not-a-date' }, { ...window, expiresAt: new Date(now).toISOString() },
    { ...window, expiresAt: new Date(now + 60 * 60_000).toISOString() }]) {
    assert.throws(() => canaryWindow({ TASK_SECRETS_WINDOW: JSON.stringify(value) }, now), /canary_window/)
  }
})

test('full-owner idle verifier uses read-only transactions without a workspace, row or age limit and fails closed', async () => {
  const now = Date.now(), statements = [], parameters = [], settings = [], state = {
    ownerMatches: 1, unfinishedCount: 0, foreignCount: 0, unknownStatusCount: 0, ownedStopRequestedCount: 0, readOnly: 'on', released: 0, ended: false,
  }
  class Pool {
    constructor(options) { settings.push(options) }
    async connect() { return {
      query: async ({ text: sql, values: params, query_timeout: timeout }) => {
        assert.ok(timeout > 0 && timeout <= 5000)
        statements.push(sql); if (sql.startsWith('WITH active')) parameters.push(params)
        if (sql.startsWith('WITH active')) return { rows: [{ ...state }] }
        return { rows: [] }
      },
      release: () => { state.released++ },
    } }
    async end() { state.ended = true }
  }
  const verifier = await createOwnerIdleVerifier({ connectionString: 'postgres://synthetic-private-db', ownerId: 'synthetic-owner',
    email: 'owner@example.invalid', window: windowAt(now), sourceCommit: config.sourceCommit, fixtureId: caseId }, { Pool, now: () => now })
  const control = { signal: new AbortController().signal, timeoutMs: 5000 }
  const proof = await verifier.assertIdle([], control)
  assert.equal(proof.foreignActiveCount, 0); assert.equal(proof.atomicWithMutation, false)
  assert.equal(proof.scope, 'all_owner_runs_all_workspaces_without_time_or_row_limit')
  assert.equal(settings[0].options, '-c default_transaction_read_only=on')
  assert.match(statements[0], /BEGIN.*READ ONLY/)
  const query = statements.find(sql => sql.startsWith('WITH active'))
  assert.doesNotMatch(query, /LIMIT|createdAt|workspaceId|UPDATE|INSERT|DELETE/i)
  assert.deepEqual(parameters[0][4], ['queued', 'preparing', 'running', 'paused', 'waiting_input', 'finishing'])
  state.unfinishedCount = state.foreignCount = 1
  await assert.rejects(verifier.assertIdle([], control), /canary_idle_unverified/)
  state.foreignCount = 0
  assert.equal((await verifier.assertIdle([runId], control)).ownedActiveCount, 1)
  for (const change of [{ ownerMatches: 0 }, { unknownStatusCount: 1 }, { readOnly: 'off' }]) {
    const before = { ...state }; Object.assign(state, change)
    await assert.rejects(verifier.assertIdle([runId], control), /canary_idle_unverified/); Object.assign(state, before)
  }
  assert.ok(statements.includes('COMMIT'))
  assert.doesNotMatch(JSON.stringify(proof), /synthetic-owner|owner@example|synthetic-private-db/)
  await verifier.close(); assert.equal(state.ended, true)
})

async function canaryStoreHarness({ lostCreate = false, lostRotate = false, failUnknownPersistence = false,
  budget = { signal: () => new AbortController().signal, remaining: () => 5000 }, verifierFactory } = {}) {
  const id = randomUUID(), oldId = randomUUID(), now = Date.now(), calls = [], persisted = [], values = new Map()
  const old = { id: oldId, name: 'UNRELATED_PRIVATE_ENTRY', kind: 'secret', note: 'not a fixture', delivery: { mode: 'protected' } }
  const rows = new Map([[oldId, old]])
  let busy = false, closed = false
  const rotationError = Error('synthetic rotation reply lost after write'), objectCalls = []
  const verifier = {
    async assertIdle(allowed) {
      calls.push({ operation: 'idle', allowed: [...allowed] })
      if (busy) throw Error('task_secrets_canary_idle_unverified')
      return { ownedActiveCount: allowed.length, ownedStopRequestedCount: 0, foreignActiveCount: 0, atomicWithMutation: false }
    },
    async assertRevoked(actual, requestedAt) { assert.equal(actual, runId); return { status: 'stopped', requestedAt, leaseExpired: true } },
    async readRunEvidence(actual) { return { ...actual, status: 'stopped', observedAt: new Date(now).toISOString() } },
    async collectObjects(args) { objectCalls.push(args); return { testOnly: true } },
    async close() { closed = true },
  }
  const client = {
    async json(path, init) {
      if (path === '/api/secrets/delivery?scope=personal') return { scope: 'personal', secrets: structuredClone([...rows.values()]) }
      assert.equal(path, '/api/secrets/delivery'); assert.equal(init.method, 'PATCH')
      const input = JSON.parse(init.body); assert.equal(input.id, id)
      calls.push({ operation: 'policy', id }); rows.get(id).delivery = input.delivery
      return { scope: 'personal', secret: structuredClone(rows.get(id)) }
    },
    async rpc(name, [input]) {
      if (name === 'user-secrets.createMySecret') {
        calls.push({ operation: 'create' })
        rows.set(id, { id, name: input.name, kind: input.kind, note: input.note, delivery: { mode: 'protected' } })
        values.set(id, input.value)
        if (lostCreate) throw Error('synthetic reply lost after write')
      } else if (name === 'user-secrets.replaceMySecret') {
        assert.equal(input.id, id); calls.push({ operation: 'rotate', id }); values.set(id, input.value)
        if (lostRotate) throw rotationError
      } else {
        assert.equal(name, 'user-secrets.deleteMySecret'); assert.equal(input.id, id)
        calls.push({ operation: 'delete', id }); rows.delete(id); values.delete(id)
        return { ok: true, data: { id } }
      }
      return { ok: true, data: structuredClone(rows.get(id)) }
    },
  }
  const canaryOptions = { client, ownerId: 'synthetic-owner', email: 'owner@example.invalid', budget,
    workspaceId: runId, fixtureId: caseId, sourceCommit: config.sourceCommit, window: windowAt(now), connectionString: 'synthetic-connection',
    pin: async () => { calls.push({ operation: 'pin' }) }, persist: async value => {
      if (failUnknownPersistence && value.generations.some(item => item.state === 'outcome_unknown')) throw Error('synthetic private journal failure')
      persisted.push(value)
    } }
  const verifierOptions = { verifierFactory: verifierFactory ?? (async () => verifier), now: () => now }
  const canary = await createProductionCanary(canaryOptions, verifierOptions)
  const fixture = { upstreamOrigin: config.upstreamOrigin, createProductionCase: async (actualCase, canaryValue) => {
    assert.equal(canaryValue, values.get(id)); return { caseId: actualCase, canarySha256: hash(canaryValue), responseSha256: config.responseSha256, sdkResponseSha256: '6'.repeat(64) }
  } }
  return { canary, fixture, calls, persisted, rows, values, id, oldId, old, rotationError, objectCalls,
    allowPersistence: () => { failUnknownPersistence = false }, busy: () => { busy = true }, closed: () => closed,
    recover: recovery => createProductionCanary({ ...canaryOptions, recovery }, verifierOptions) }
}

test('production canary writes and removes only its single new private ID, with a fresh owner check before every mutation', async () => {
  const state = await canaryStoreHarness()
  await state.canary.preflight(); await state.canary.open()
  const first = await state.canary.prepareCase(state.fixture, caseId, 'revocation')
  assert.equal(first.bootstrapToken, undefined)
  assert.equal(first.deliveryMode, 'production_claim')
  const rotation = await state.canary.rotate(runId)
  const fresh = await state.canary.prepareCase(state.fixture, randomUUID(), 'fresh_claim')
  assert.equal(rotation.previousCanarySha256, first.canarySha256)
  assert.equal(rotation.newCanarySha256, fresh.canarySha256)
  assert.notEqual(first.canarySha256, fresh.canarySha256)
  const result = await state.canary.close()
  assert.equal(result.deleted, true); assert.equal(result.id, state.id); assert.equal(state.closed(), true)
  assert.deepEqual([...state.rows.values()], [state.old])
  assert.deepEqual(state.calls.filter(call => ['create', 'policy', 'rotate', 'delete'].includes(call.operation)).map(call => call.operation),
    ['create', 'policy', 'rotate', 'policy', 'delete'])
  for (const [index, call] of state.calls.entries()) if (['create', 'policy', 'rotate', 'delete'].includes(call.operation)) {
    assert.equal(state.calls[index - 1].operation, 'idle')
    assert.deepEqual(state.calls[index - 1].allowed, call.operation === 'rotate' ? [runId] : [])
  }
  assert.doesNotMatch(JSON.stringify(state.persisted), /mikka1712s_|synthetic-connection|owner@example|UNRELATED_PRIVATE_ENTRY/)
})

test('a canary idle query interrupted before rotation refuses the write and cleanup uses its separate bounded PG phase', async t => {
  const time = Date.now(), abort = new AbortController(), releases = [], statements = []
  const budget = createSecretBudget({ jobStartedAt: new Date(time).toISOString(), startedAt: new Date(time).toISOString(), window: windowAt(time) }, { signal: abort.signal })
  t.after(() => budget.close())
  let stall = false, markStarted, pending
  const started = new Promise(resolve => { markStarted = resolve })
  class Pool {
    async connect() { return {
      query(command) {
        const sql = typeof command === 'string' ? command : command.text
        statements.push({ sql, timeout: command.query_timeout })
        if (sql.startsWith('WITH active')) {
          const allowed = command.values[2]
          const result = { rows: [{ readOnly: 'on', ownerMatches: 1, unfinishedCount: allowed.length,
            foreignCount: 0, unknownStatusCount: 0, ownedStopRequestedCount: 0 }] }
          if (stall) {
            markStarted(); return new Promise((resolve, reject) => { pending = { resolve: () => resolve(result), reject } })
          }
          return Promise.resolve(result)
        }
        if (sql.startsWith('SELECT status')) return Promise.resolve({ rows: [{ status: 'stopped', stopRequestedAt: new Date(time), leaseExpiresAt: new Date(time) }] })
        return Promise.resolve({ rows: [] })
      },
      release(destroy) { releases.push(destroy); if (destroy) pending?.reject(Error('synthetic connection closed')) },
    } }
    async end() {}
  }
  const state = await canaryStoreHarness({ budget, verifierFactory: (args, options) => createOwnerIdleVerifier(args, { ...options, Pool }) })
  await state.canary.preflight(); await state.canary.open()
  assert.equal((await state.canary.verifyRevoked(runId, new Date(time).toISOString())).leaseExpired, true)
  const original = state.values.get(state.id)
  stall = true
  const rotation = state.canary.rotate(runId)
  const rejected = assert.rejects(rotation, /canary_idle_unverified/)
  await started; abort.abort(); pending.resolve(); await rejected
  assert.equal(state.calls.some(call => call.operation === 'rotate'), false)
  assert.equal(state.values.get(state.id), original)
  assert.ok(releases.includes(true))
  stall = false; budget.phase('cleanup')
  assert.equal((await state.canary.close()).deleted, true)
  assert.equal(state.calls.filter(call => call.operation === 'delete').length, 1)
  assert.deepEqual([...state.rows.values()], [state.old])
  assert.ok(statements.every(item => item.timeout > 0 && item.timeout <= 5000), 'preflight, revocation and delete never use a bare PG query')
  assert.ok(statements.some(item => item.sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'))
})

test('a lost create reply is reconciled by unique fixture metadata; a new foreign run defers exact-ID deletion', async () => {
  const lost = await canaryStoreHarness({ lostCreate: true })
  await assert.rejects(lost.canary.open(), /canary_create/)
  assert.equal(lost.canary.evidence.id, lost.id)
  assert.equal((await lost.canary.close()).deleted, true)
  assert.deepEqual([...lost.rows.values()], [lost.old])
  const occupied = await canaryStoreHarness()
  await occupied.canary.open(); occupied.busy()
  await assert.rejects(occupied.canary.close(), /canary_cleanup/)
  assert.equal(occupied.rows.has(occupied.id), true)
  assert.equal(occupied.canary.evidence.cleanup.outcome, 'deferred_requires_reserved_owner_window')
  assert.equal(occupied.canary.evidence.cleanup.id, occupied.id)
  assert.equal(occupied.calls.some(call => call.operation === 'delete'), false)
  assert.equal(occupied.closed(), true)
})

test('metadata replaced under the fixture ID cannot authorize a rotation or deletion', async () => {
  const state = await canaryStoreHarness()
  await state.canary.open(); state.rows.get(state.id).note = 'someone else changed this entry'
  await assert.rejects(state.canary.rotate(runId), /canary_scope/)
  await assert.rejects(state.canary.close(), /canary_cleanup/)
  assert.equal(state.calls.some(call => ['rotate', 'delete'].includes(call.operation)), false)
  assert.equal(state.rows.has(state.id), true)
})

test('durable synthetic generations survive rotation and deletion without retaining their values', async () => {
  const state = await canaryStoreHarness()
  await state.canary.open()
  const original = state.values.get(state.id), before = hash(original)
  await state.canary.prepareCase(state.fixture, caseId, 'revocation')
  const rotation = await state.canary.rotate(runId)
  const replacement = state.values.get(state.id)
  await state.canary.close()
  const saved = state.persisted.at(-1)
  assert.equal(saved.generations.length, 2)
  assert.deepEqual(saved.generations.map(item => item.sha256), [before, hash(replacement)])
  assert.equal(saved.generations[0].state, 'acknowledged')
  assert.equal(saved.generations[1].state, 'acknowledged')
  assert.equal(saved.generations[1].runId, runId)
  assert.equal(saved.generations[1].sha256, rotation.newCanarySha256)
  assert.equal(saved.cases[0].caseId, caseId)
  assert.equal(saved.cases[0].sha256, before)
  assert.ok(state.persisted.some(item => item.generations?.[0]?.state === 'requested'))
  assert.ok(state.persisted.some(item => item.generations?.[1]?.state === 'requested'))
  assert.ok(!JSON.stringify(saved).includes(original) && !JSON.stringify(saved).includes(replacement))
})

test('a lost rotation reply preserves both match digests and an unknown write before exact cleanup', async () => {
  const state = await canaryStoreHarness({ lostRotate: true })
  await state.canary.open()
  const before = hash(state.values.get(state.id))
  await assert.rejects(state.canary.rotate(runId), /synthetic rotation reply lost/)
  const after = hash(state.values.get(state.id)), saved = state.persisted.at(-1)
  assert.notEqual(before, after)
  assert.deepEqual(saved.generations.map(item => item.sha256), [before, after])
  assert.equal(saved.generations[1].state, 'outcome_unknown')
  assert.equal(saved.writes.at(-1).acknowledged, false)
  assert.equal(saved.generations[1].byteLength, 75)
  assert.equal((await state.canary.close()).deleted, true)
  assert.equal(state.persisted.at(-1).generations[1].state, 'outcome_unknown')
})

test('object collection forwards every generated digest, including an unknown rotation, under the original authenticated owner', async () => {
  const state = await canaryStoreHarness({ lostRotate: true })
  const record = { caseId, runId, issueId: randomUUID(), botId: randomUUID() }
  const signal = new AbortController().signal, budget = { signal: () => signal, remaining: () => 5000 }
  await state.canary.open(); await state.canary.prepareCase(state.fixture, caseId, 'revocation')
  await assert.rejects(state.canary.rotate(runId), cause => cause === state.rotationError)
  const generations = structuredClone(state.canary.evidence.generations)
  await state.canary.observeRun(record, { budget })
  await state.canary.collectObjects(record, { budget, saveObject: async () => {} })
  const [args] = state.objectCalls
  assert.equal(args.scope.ownerId, 'synthetic-owner')
  assert.deepEqual(args.scope, { ownerId: 'synthetic-owner', workspaceId: runId, botId: record.botId, issueId: record.issueId, runId })
  assert.deepEqual(args.canaries.generations, generations)
  assert.deepEqual(args.canaries.generations.map(item => item.state), ['acknowledged', 'outcome_unknown'])
  assert.equal((await state.canary.close()).deleted, true)
})

test('a failed mutation plus a failed journal preserves the business cause and a closed persistence failure', async () => {
  const record = {}, business = Error('synthetic business rejection'), disk = Error('synthetic disk rejection')
  let saves = 0
  await assert.rejects(secretMutation(record, 'dispatch', async () => { throw business }, () => {}, async () => {
    if (++saves > 1) throw disk
  }), cause => {
    assert.ok(cause instanceof AggregateError)
    assert.equal(cause.cause, business); assert.deepEqual(cause.errors, [business, disk])
    assert.equal(safeFailure(cause), 'task_secrets_journal'); return true
  })
  assert.equal(record.intents[0].state, 'outcome_unknown'); assert.equal(record.intents[0].journalFailed, true)
  const state = await canaryStoreHarness({ lostRotate: true, failUnknownPersistence: true })
  await state.canary.open()
  await assert.rejects(state.canary.rotate(runId), cause => {
    assert.ok(cause instanceof AggregateError); assert.equal(cause.cause, state.rotationError)
    assert.equal(cause.errors[0], state.rotationError); assert.equal(cause.errors.length, 2)
    assert.equal(safeFailure(cause), 'task_secrets_journal'); return true
  })
  assert.equal(state.canary.evidence.writes.at(-1).journalFailed, true)
  assert.equal(state.canary.evidence.generations.at(-1).state, 'outcome_unknown')
  state.allowPersistence(); assert.equal((await state.canary.close()).deleted, true)
})

test('an independent canary recovery uses only its recorded ID and hashes, never generates or rotates another value', async () => {
  const state = await canaryStoreHarness()
  await state.canary.open(); await state.canary.rotate(runId)
  const generations = structuredClone(state.canary.evidence.generations)
  const recovery = await state.recover(structuredClone(state.canary.evidence))
  await assert.rejects(recovery.open(), /canary_scope/)
  await assert.rejects(recovery.rotate(runId), /canary_scope/)
  assert.equal((await recovery.close()).deleted, true)
  assert.deepEqual(recovery.evidence.generations, generations)
  assert.equal(state.calls.filter(item => item.operation === 'create').length, 1)
  assert.equal(state.calls.filter(item => item.operation === 'rotate').length, 1)
  assert.equal(state.rows.has(state.id), false); assert.deepEqual(state.rows.get(state.oldId), state.old)
  assert.doesNotMatch(JSON.stringify(recovery.evidence), /mikka1712s_[a-f0-9]{64}/)
})

function durableFixture() {
  const options = readOptions(['--cleanup'], env), fixtureId = randomUUID(), workspaceId = randomUUID(), ownerId = 'synthetic-journal-owner'
  const record = { caseId, harness: 'codex', requestedModel: 'gpt-6-luna', title: `测试 1712 ${caseId} codex`,
    sourceCommit: config.sourceCommit, workerSha: config.workerSha, workerSourceCommit: config.workerSourceCommit,
    createdAt: new Date().toISOString(), phase: 'fresh_claim', status: 'running', intents: [], cleanup: { status: 'running', errors: [] } }
  const report = { version: 1, sourceCommit: config.sourceCommit, fixtureId, driver: options.driver, jobStartSource: options.jobStartSource,
    mode: 'production_canary', startedAt: new Date().toISOString(), checkpointAt: new Date().toISOString(),
    ownerHash: hash(ownerId).slice(0, 16), workspaceId, budget: { jobStartedAt: options.jobStartedAt },
    resources: { intents: [] }, productionCanary: { journal: null }, cleanup: { errors: [] }, cases: [record] }
  return { options, report, record, ownerId, workspaceId }
}

test('an interrupted write retains its exact intent in a private atomic journal; unbound and symlink journals are refused', async t => {
  const f = durableFixture(), directory = await mkdtemp(join(tmpdir(), 'mikka-1712-journal-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  f.options.reportPath = join(directory, 'report.json')
  const path = join(directory, 'canary-journal.json'), checkpoint = () => writeSecretCheckpoint(path, secretJournal(f.report))
  await assert.rejects(secretMutation(f.record, 'issue_create', async () => {
    const observed = await readSecretJournal(f.options)
    assert.equal(observed.cases[0].intents[0].state, 'requested')
    throw Error('synthetic response lost')
  }, () => assert.fail('no response exists'), checkpoint), /synthetic response lost/)
  const saved = await readSecretJournal(f.options)
  assert.equal(saved.cases[0].intents[0].state, 'outcome_unknown')
  assert.equal(saved.objectEvidence.status, 'needs_collection')
  assert.equal(saved.objectEvidence.fullNegativeEvidence, false)
  assert.equal((await lstat(path)).mode & 0o777, 0o600)
  assert.equal((await lstat(directory)).mode & 0o777, 0o700)
  for (const patch of [{ sourceCommit: 'f'.repeat(40) }, { driver: { runId: 991, runAttempt: 1 } }, { driver: { runId: 990, runAttempt: 2 } }])
    await assert.rejects(readSecretJournal({ ...f.options, ...patch }), /journal/)
  await chmod(path, 0o644); await assert.rejects(readSecretJournal(f.options), /journal/)
  await rm(path); await symlink(f.options.reportPath, path)
  await assert.rejects(readSecretJournal(f.options), /journal/)
  await assert.rejects(writeSecretCheckpoint(join(directory, 'unsafe.json'), { value: 'mikka1712s_' + '1'.repeat(64) }), /journal/)
})

test('job budget reads the actual unique running job in this attempt and refuses incomplete or foreign metadata', async () => {
  const startedAt = new Date(Date.now() - 10 * 60_000).toISOString()
  const options = { ...env, GITHUB_JOB: 'acceptance', GITHUB_TOKEN: 'synthetic-github-read-token' }
  const job = { id: 991, name: 'acceptance', run_id: 990, run_attempt: 1, head_sha: env.GITHUB_SHA,
    status: 'in_progress', conclusion: null, started_at: startedAt }
  const request = (payload, headers = {}) => async (url, init) => {
    assert.equal(url, 'https://api.github.com/repos/alexj11324/Mikka/actions/runs/990/attempts/1/jobs?per_page=100')
    assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal)
    assert.equal(init.headers.authorization, 'Bearer synthetic-github-read-token')
    return Response.json(payload, { headers })
  }
  assert.deepEqual(await readSecretJobStart(options, { fetchImpl: request({ jobs: [job], total_count: 1 }) }),
    { id: 991, startedAt, source: 'github_actions_job.started_at' })
  for (const patch of [{ run_id: 989 }, { run_attempt: 2 }, { head_sha: 'f'.repeat(40) }, { status: 'completed' },
    { started_at: null }, { started_at: new Date(Date.now() + 60_000).toISOString() }, { name: 'other' }])
    await assert.rejects(readSecretJobStart(options, { fetchImpl: request({ jobs: [{ ...job, ...patch }], total_count: 1 }) }), /budget/)
  for (const payload of [{ jobs: [job], total_count: 2 }, { jobs: [job, job], total_count: 2 }, { jobs: [], total_count: 0 }])
    await assert.rejects(readSecretJobStart(options, { fetchImpl: request(payload) }), /budget/)
  await assert.rejects(readSecretJobStart(options, { fetchImpl: request({ jobs: [job], total_count: 1 }, { link: '<https://api.github.com/next>; rel="next"' }) }), /budget/)
  await assert.rejects(readSecretJobStart(options, { fetchImpl: async () => new Response('{}', { status: 403 }) }), /budget/)
})

test('Factory obtains its own actual job provenance before the shared execute guard', async () => {
  const options = { ...env, GITHUB_JOB: 'factory', GITHUB_TOKEN: 'synthetic-github-read-token' }
  for (const name of ['TASK_SECRETS_JOB_ID', 'TASK_SECRETS_JOB_STARTED_AT', 'TASK_SECRETS_JOB_START_SOURCE']) delete options[name]
  assert.throws(() => readOptions(['--execute'], options), /task_secrets_configuration/)
  const startedAt = new Date(Date.now() - 60_000).toISOString()
  const job = { id: 992, name: 'factory', run_id: 990, run_attempt: 1, head_sha: env.GITHUB_SHA,
    status: 'in_progress', conclusion: null, started_at: startedAt }
  const earlierJobs = ['authorize', 'acceptance'].map((name, index) => ({ ...job, id: 989 + index, name,
    started_at: new Date(Date.parse(startedAt) - 600_000).toISOString() }))
  const request = (factory = job) => async (url, init) => {
    assert.equal(url, 'https://api.github.com/repos/alexj11324/Mikka/actions/runs/990/attempts/1/jobs?per_page=100')
    assert.equal(init.headers.authorization, 'Bearer synthetic-github-read-token')
    return Response.json({ jobs: [...earlierJobs, factory], total_count: 3 })
  }
  const actual = await readSecretJobStart(options, { expectedJob: 'factory', fetchImpl: request() })
  assert.deepEqual(actual, { id: 992, startedAt, source: 'github_actions_job.started_at' })
  const complete = { ...options, TASK_SECRETS_JOB_ID: String(actual.id), TASK_SECRETS_JOB_STARTED_AT: actual.startedAt,
    TASK_SECRETS_JOB_START_SOURCE: actual.source }
  const selected = readOptions(['--execute'], complete)
  assert.equal(selected.driver.jobId, job.id)
  assert.equal(selected.jobStartedAt, job.started_at)
  for (const name of ['TASK_SECRETS_JOB_ID', 'TASK_SECRETS_JOB_STARTED_AT', 'TASK_SECRETS_JOB_START_SOURCE']) {
    const incomplete = { ...complete }; delete incomplete[name]
    assert.throws(() => readOptions(['--execute'], incomplete), /task_secrets_(?:configuration|budget)/)
  }
  for (const patch of [{ id: 0 }, { name: 'acceptance' }, { name: 'authorize' }, { run_id: 989 }, { run_attempt: 2 },
    { head_sha: 'f'.repeat(40) }, { started_at: null }, { started_at: new Date(Date.now() + 60_000).toISOString() }])
    await assert.rejects(readSecretJobStart(options, { expectedJob: 'factory', fetchImpl: request({ ...job, ...patch }) }), /budget/)
  for (const expectedJob of ['authorize', 'other', '', null])
    await assert.rejects(readSecretJobStart(options, { expectedJob, fetchImpl: () => assert.fail('unsupported job must not read the API') }), /budget/)
  await assert.rejects(readSecretJobStart(options, { fetchImpl: () => assert.fail('factory must be explicitly selected') }), /budget/)
  await assert.rejects(readSecretJobStart({ ...options, GITHUB_JOB: 'acceptance' }, {
    expectedJob: 'factory', fetchImpl: () => assert.fail('another job cannot select Factory provenance'),
  }), /budget/)
})

test('the earliest fixed job/window/fixture deadline preserves evidence and cleanup time without renewing any limit', () => {
  let time = Date.now()
  const start = new Date(time).toISOString(), window = { ...windowAt(time), expiresAt: new Date(time + 45 * 60_000).toISOString() }
  const budget = createSecretBudget({ jobStartedAt: start, startedAt: start, window }, { now: () => time })
  try {
    const beforeFixture = budget.signal()
    budget.bindFixture(start)
    assert.equal(budget.signal(), beforeFixture, 'earlier in-flight work retains the shortened deadline signal')
    const observed = budget.snapshot()
    assert.equal(Date.parse(observed.fixtureDeadlineAt), time + 20 * 60_000)
    assert.equal(Date.parse(observed.cleanupDeadlineAt), Date.parse(observed.fixtureDeadlineAt))
    assert.equal(Date.parse(observed.cleanupDeadlineAt) - Date.parse(observed.evidenceDeadlineAt), SECRET_BUDGET.cleanupMs)
    assert.equal(Date.parse(observed.evidenceDeadlineAt) - Date.parse(observed.executionDeadlineAt), SECRET_BUDGET.evidenceMs)
    assert.equal(observed.hardJobCancellationRecoveryGuaranteed, false)
    time = Date.parse(observed.executionDeadlineAt)
    assert.throws(() => budget.remaining('execution'), /budget/)
    assert.ok(budget.remaining('evidence') > 0 && budget.remaining('cleanup') > 0)
    assert.throws(() => budget.bindFixture(new Date(time).toISOString()), /budget/)
    time = Date.parse(observed.cleanupDeadlineAt)
    assert.throws(() => budget.remaining('cleanup'), /budget/)
  } finally { budget.close() }
  assert.equal(SECRET_BUDGET.jobMs, 35 * 60_000)
  assert.equal(SECRET_BUDGET.fixtureMs, 20 * 60_000)
  const jobStart = Date.now(), later = jobStart + 15 * 60_000
  const lateSetup = createSecretBudget({ jobStartedAt: new Date(jobStart).toISOString(), startedAt: new Date(later).toISOString() }, { now: () => later })
  try {
    assert.equal(Date.parse(lateSetup.snapshot().cleanupDeadlineAt), jobStart + 29 * 60_000)
    assert.equal(Date.parse(lateSetup.snapshot().recoveryReservedUntilAt), jobStart + 34 * 60_000)
  } finally { lateSetup.close() }
})

test('execution interruption aborts its real fetch signal while a separate finite cleanup phase remains usable', async () => {
  const now = Date.now(), abort = new AbortController(), budget = createSecretBudget({
    jobStartedAt: new Date(now).toISOString(), startedAt: new Date(now).toISOString(), window: windowAt(now),
  }, { now: () => now, signal: abort.signal })
  const received = [], request = budget.fetch(async (_url, init) => { received.push(init.signal); return new Response('{}') })
  try {
    await request('https://example.invalid'); abort.abort()
    assert.equal(received[0].aborted, true)
    assert.throws(() => request('https://example.invalid'), /budget/)
    budget.phase('cleanup'); await request('https://example.invalid')
    assert.equal(received[1].aborted, false)
  } finally { budget.close() }
})

test('a budget interruption also aborts a response body that has already sent headers', async t => {
  const abort = new AbortController(), time = Date.now()
  const budget = createSecretBudget({ jobStartedAt: new Date(time).toISOString(), startedAt: new Date(time).toISOString() }, { signal: abort.signal })
  const server = createServer((_request, response) => { response.writeHead(200); response.write('partial-body') })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { budget.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const response = await budget.fetch(fetch)(`http://127.0.0.1:${server.address().port}`)
  const body = response.text(); abort.abort()
  await assert.rejects(body, { name: 'AbortError' })
})

test('persisted run lookup reads only exact tenant/owner/task provenance and never substitutes the request trace', async () => {
  const now = Date.now(), statements = [], workspaceId = randomUUID(), traceId = '1'.repeat(32)
  let available = true, rollback = 0, released = 0
  const row = { id: runId, issueId: caseId, workspaceId, botId: randomUUID(), status: 'stopped', sessionId: 'native-session',
    createdAt: new Date(now - 1000), startedAt: new Date(now - 900), finishedAt: new Date(now), stopRequestedAt: new Date(now - 100),
    trace: { traceparent: `00-${traceId}-${'2'.repeat(16)}-01`, runId, taskId: caseId, threadId: runId, workflowRunId: 'workflow-1712',
      posthogDistinctId: 'unrelated-private-value', arbitrary: 'private-field' } }
  class Pool {
    async connect() { return { query: async command => {
      const { text: sql, values, query_timeout: timeout } = command
      assert.ok(timeout > 0 && timeout <= 5000)
      statements.push(sql)
      if (sql === 'ROLLBACK') rollback++
      if (sql.startsWith('SELECT r.id')) {
        assert.deepEqual(values, [runId, 'synthetic-owner', caseId, workspaceId, row.botId])
        assert.match(sql, /r\."userId"=\$2/); assert.match(sql, /r\."workspaceId"=\$4/)
        assert.match(sql, /i\."userId"=\$2/); assert.match(sql, /i\."ownershipState"='bound'/)
        return { rows: available ? [structuredClone(row)] : [] }
      }
      return { rows: [] }
    }, release: () => { released++ } } }
    async end() {}
  }
  const verifier = await createOwnerIdleVerifier({ connectionString: 'synthetic-local-pg', ownerId: 'synthetic-owner',
    email: 'owner@example.invalid', window: windowAt(now), sourceCommit: config.sourceCommit, fixtureId: caseId }, { Pool, now: () => now })
  try {
    const scope = { runId, issueId: caseId, workspaceId, botId: row.botId }
    const control = { signal: new AbortController().signal, timeoutMs: 5000 }
    const evidence = await verifier.readRunEvidence(scope, control)
    assert.equal(evidence.persistedTrace.traceId, traceId)
    assert.equal(evidence.persistedTrace.workflowRunId, 'workflow-1712')
    // The fake row deliberately includes fields the SQL projection excludes;
    // the returned projection must still not propagate them.
    assert.doesNotMatch(JSON.stringify(evidence), /unrelated-private-value|private-field/)
    row.trace = null
    assert.equal((await verifier.readRunEvidence(scope, control)).persistedTrace.status, 'missing')
    available = false
    await assert.rejects(verifier.readRunEvidence(scope, control), /run_evidence/)
    // The readonly SELECT is already committed/released before projection
    // validation rejects a missing row; no HTTP sits in that transaction.
    assert.equal(rollback, 0); assert.equal(released, 3)
    assert.ok(statements.includes('BEGIN READ ONLY'))
  } finally { await verifier.close() }
})

test('every readonly evidence phase is interruptible, destroys its connection, and leaves cleanup able to read', async t => {
  for (const stoppedAt of ['acquire', 'BEGIN READ ONLY', 'SELECT set_config', 'SELECT r.id', 'COMMIT', 'ROLLBACK']) await t.test(stoppedAt, async () => {
    const time = Date.now(), workspaceId = randomUUID(), botId = randomUUID()
    const row = { id: runId, issueId: caseId, workspaceId, botId, status: 'stopped', sessionId: null,
      createdAt: new Date(time), startedAt: null, finishedAt: new Date(time), stopRequestedAt: null, trace: null }
    const scope = { runId, issueId: caseId, workspaceId, botId }, releases = [], statements = []
    let hanging = true, resolveAcquire, rejectQuery, markStarted
    const started = new Promise(resolve => { markStarted = resolve })
    const connection = () => ({
      query(command) {
        assert.ok(command.query_timeout > 0 && command.query_timeout <= 5000)
        statements.push(command.text)
        if (hanging && stoppedAt === 'ROLLBACK' && command.text.startsWith('SELECT r.id'))
          return Promise.reject(Error('synthetic SELECT failure'))
        if (hanging && command.text.startsWith(stoppedAt)) {
          markStarted(); return new Promise((_, reject) => { rejectQuery = reject })
        }
        return Promise.resolve({ rows: command.text.startsWith('SELECT r.id') ? [row] : [] })
      },
      release(destroy) { releases.push(destroy); rejectQuery?.(Error('synthetic connection destroyed')); rejectQuery = null },
    })
    class Pool {
      constructor(options) { assert.equal(options.max, 1); assert.equal(options.connectionTimeoutMillis, 5000) }
      connect() {
        if (hanging && stoppedAt === 'acquire') {
          markStarted(); return new Promise(resolve => { resolveAcquire = resolve })
        }
        return Promise.resolve(connection())
      }
      async end() {}
    }
    const verifier = await createOwnerIdleVerifier({ connectionString: 'synthetic-local-pg', ownerId: 'synthetic-owner',
      email: 'owner@example.invalid', window: windowAt(time), sourceCommit: config.sourceCommit, fixtureId: caseId }, { Pool })
    try {
      const abort = new AbortController()
      const rejected = assert.rejects(verifier.readRunEvidence(scope, { signal: abort.signal, timeoutMs: 5000 }), /canary_run_evidence/)
      await started; abort.abort(); await rejected
      hanging = false
      if (resolveAcquire) {
        resolveAcquire(connection()); await new Promise(resolve => setImmediate(resolve))
        assert.deepEqual(statements, [], 'a late pool acquisition must be destroyed without executing SQL')
      }
      assert.deepEqual(releases, [true])
      const cleanupSignal = new AbortController().signal
      assert.equal((await verifier.readRunEvidence(scope, { signal: cleanupSignal, timeoutMs: 5000 })).status, 'stopped')
      assert.deepEqual(releases, [true, false])
    } finally { await verifier.close() }
  })
})

test('fixture recovery cannot adopt a foreign VM, accepts only complete exact-metadata discovery and verifies actual absence', async () => {
  const metadata = { application: 'mikka-1712-secret-fixture', acceptance: caseId, sourceCommit: config.sourceCommit,
    driverRunId: '990', driverRunAttempt: '1' }, target = { sandboxId: 'owned-fixture', metadata }
  class Missing extends Error {}
  let foreign = true, exists = true, killed = 0, partial = false, listed = 0
  const provider = {
    missing: cause => cause instanceof Missing,
    getInfo: async id => {
      assert.equal(id, target.sandboxId)
      if (!exists) throw new Missing()
      return { sandboxId: id, metadata: foreign ? { ...metadata, driverRunAttempt: '2' } : metadata }
    },
    kill: async id => { assert.equal(id, target.sandboxId); killed++; exists = false; return true },
    list: options => {
      assert.deepEqual(options.query, { metadata }); listed++
      return { hasNext: partial, nextItems: async () => [{ sandboxId: target.sandboxId }] }
    },
  }
  await assert.rejects(cleanupIsolatedFixture(target, 'synthetic-provider-key', { provider }), /scope/)
  assert.equal(killed, 0)
  foreign = false; partial = true
  await assert.rejects(cleanupIsolatedFixture({ metadata }, 'synthetic-provider-key', { provider }), /scope/)
  assert.equal(killed, 0)
  partial = false
  const result = await cleanupIsolatedFixture({ metadata }, 'synthetic-provider-key', { provider })
  assert.equal(killed, 1); assert.equal(listed, 2)
  assert.equal(result.outcome, 'provider_kill_and_absence_verified')
  assert.equal((await cleanupIsolatedFixture(target, 'synthetic-provider-key', { provider })).outcome, 'provider_absence_verified')
  provider.getInfo = async () => { throw Error('synthetic network failure') }
  await assert.rejects(cleanupIsolatedFixture(target, 'synthetic-provider-key', { provider }), /unconfirmed/)
  assert.equal(killed, 1)
})

test('recovery requires the actual owner and exact workspace/task before retiring a run, and never deletes uncollected Tasks', async t => {
  for (const mismatch of [null, 'owner', 'workspace', 'title', 'run_owner']) await t.test(mismatch ?? 'owned', async t => {
    const f = durableFixture(), directory = await mkdtemp(join(tmpdir(), 'mikka-1712-recovery-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    f.options.reportPath = join(directory, 'report.json')
    const issueId = randomUUID(), botId = randomUUID(), profileId = randomUUID(), calls = []
    Object.assign(f.record, { issueId, runId, profileId, profileVersion: 1, profileName: `测试1712 ${caseId} codex` })
    f.record.native = { github: { cleanup: true } }
    Object.assign(f.report.resources, { botId, botName: `测试1712 ${f.report.fixtureId.slice(0, 8)}` })
    await writeSecretCheckpoint(join(directory, 'canary-journal.json'), secretJournal(f.report))
    const email = 'acceptance+mikka-smoke@example.invalid'
    const client = {
      clear() {},
      request: async path => { calls.push(path); assert.ok(['/api/auth/sign-in/email', '/api/auth/sign-out'].includes(path)); return new Response('{}') },
      json: async (path, init) => {
        if (path === '/api/auth/get-session') return { user: { id: mismatch === 'owner' ? 'foreign' : f.ownerId, email } }
        if (path === `/api/bots/${botId}`) return { id: botId, name: f.report.resources.botName }
        if (path === `/api/factory/agent-profiles/${profileId}?workspaceId=${f.workspaceId}`)
          return { profile: { id: profileId, name: f.record.profileName, harness: 'codex', version: 1 } }
        assert.equal(path, `/api/factory/agent-profiles/${profileId}`); assert.equal(init.method, 'DELETE')
        calls.push('profile_archive'); return { profile: { id: profileId, archivedAt: new Date().toISOString(), enabled: false } }
      },
      rpc: async (name, args) => {
        calls.push(name)
        if (name === 'coordinator.stopCoordinatorTurn') { assert.deepEqual(args, [botId]); return {} }
        if (name === 'issues.getIssue') return { issue: { id: issueId, userId: f.ownerId,
          workspaceId: mismatch === 'workspace' ? randomUUID() : f.workspaceId,
          title: mismatch === 'title' ? 'not this fixture' : f.record.title, ownershipState: 'bound' } }
        if (name === 'agents.pollIssueThreads') return { threads: [{ id: runId, ownedByCurrentUser: true }] }
        if (name === 'agents.getIssueThread') return {
          thread: { id: runId, ownedByCurrentUser: mismatch !== 'run_owner', attempts: [{ runId, status: 'stopped' }] },
          live: { issueWorkspaceId: f.workspaceId, runs: [{ id: runId, workspaceId: f.workspaceId }] },
        }
        assert.fail('unexpected mutation in recovery')
      },
    }
    const result = await cleanupTaskSecrets(f.options, { env: { SMOKE_OWNER_EMAIL: email, SMOKE_OWNER_PASSWORD: 'synthetic-password' },
      sessionClient: () => client, selectTeam: async (_client, requested) => {
        assert.deepEqual(requested, { ownerId: f.ownerId, workspace: f.workspaceId }); return { ownerId: f.ownerId, workspaceId: f.workspaceId }
      }, cleanup: async (_client, record, target, options) => {
        assert.equal(mismatch, null); assert.equal(record.runId, runId); assert.equal(record.issueId, issueId)
        assert.equal(target, 'cloud'); assert.equal(options.preserveIssue, true)
        calls.push('owned_run_retired'); record.cleanup = { status: 'passed', errors: [], taskRetained: true }
      } })
    assert.equal(result.status, 'unconfirmed')
    if (!mismatch) assert.ok(result.retained.some(item => item.issueId === issueId && item.reason === 'task_objects_need_collection'))
    assert.equal(calls.includes('owned_run_retired'), !mismatch)
    assert.ok(!calls.includes('issue-operations.setIssueDeleted'))
    const saved = await readSecretJournal(f.options)
    assert.equal(saved.recovery.status, result.status)
    assert.equal(saved.objectEvidence.fullNegativeEvidence, false)
  })
})

test('recovery retains a PG evidence failure but still performs the already authorized exact stop and machine readback', async t => {
  const f = durableFixture(), directory = await mkdtemp(join(tmpdir(), 'mikka-1712-recovery-evidence-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  f.options.reportPath = join(directory, 'report.json')
  const issueId = randomUUID(), botId = randomUUID(), calls = [], email = 'acceptance+mikka-smoke@example.invalid'
  Object.assign(f.record, { issueId, runId, botId })
  Object.assign(f.report.resources, { botId, botName: `测试1712 ${f.report.fixtureId.slice(0, 8)}` })
  f.report.productionCanary.journal = { fixtureId: f.report.fixtureId, sourceCommit: config.sourceCommit,
    ownerHash: f.report.ownerHash, name: `ACCEPTANCE_1712_${f.report.fixtureId.replaceAll('-', '').toUpperCase()}`,
    generations: [], cases: [], writes: [{ operation: 'create' }], window: windowAt(Date.now()), cleanup: { deleted: false } }
  await writeSecretCheckpoint(join(directory, 'canary-journal.json'), secretJournal(f.report))
  let stopped = false, machineEnded = false
  const client = {
    clear() {},
    request: async path => { assert.ok(['/api/auth/sign-in/email', '/api/auth/sign-out'].includes(path)); return new Response('{}') },
    async json(path, init) {
      if (path === '/api/auth/get-session') return { user: { id: f.ownerId, email } }
      if (path === `/api/bots/${botId}`) return { id: botId, name: f.report.resources.botName }
      if (path === `/api/factory/tasks?issueId=${issueId}`) return { issueId, tasks: [] }
      assert.equal(path, `/api/threads/${runId}/machine`)
      assert.equal(init.method, 'POST'); assert.deepEqual(JSON.parse(init.body), { action: 'end' }); assert.equal(stopped, true)
      calls.push('machine_end'); machineEnded = true; return { runId, state: 'ended' }
    },
    async rpc(name, args) {
      calls.push(name)
      if (name === 'coordinator.stopCoordinatorTurn') { assert.deepEqual(args, [botId]); return {} }
      if (name === 'issues.getIssue') return { issue: { id: issueId, userId: f.ownerId,
        workspaceId: f.workspaceId, title: f.record.title, ownershipState: 'bound' } }
      if (name === 'agents.pollIssueThreads') return { threads: [{ id: runId, ownedByCurrentUser: true }] }
      if (name === 'agents.stopRun') { assert.deepEqual(args, [runId]); stopped = true; return {} }
      assert.deepEqual(args, [issueId, runId])
      if (name === 'agents.getThreadMachine') { assert.equal(machineEnded, true); return { kind: 'cloud', state: 'ended', cloud: null } }
      assert.equal(name, 'agents.getIssueThread')
      return { thread: { id: runId, ownedByCurrentUser: true, attempts: [{ runId, status: stopped ? 'stopped' : 'running' }] },
        live: { issueWorkspaceId: f.workspaceId, runs: [{ id: runId, workspaceId: f.workspaceId }] } }
    },
  }
  const result = await cleanupTaskSecrets(f.options, { env: { SMOKE_OWNER_EMAIL: email, SMOKE_OWNER_PASSWORD: 'synthetic-password' },
    sessionClient: () => client, selectTeam: async () => ({ ownerId: f.ownerId, workspaceId: f.workspaceId }),
    createCanary: async args => ({
      async observeRun(record, { budget, phase }) {
        assert.equal(record.runId, runId); assert.equal(phase, 'cleanup'); assert.ok(budget.remaining('cleanup', 5000) > 0)
        calls.push('pg_evidence_failed'); throw Error('task_secrets_canary_run_evidence')
      },
      async close() { const cleanup = { deleted: true }; await args.persist({ ...args.recovery, cleanup }); return cleanup },
    }),
  })
  assert.equal(result.status, 'unconfirmed')
  assert.ok(result.errors.some(item => item.step === 'persisted_run_evidence' && item.code === 'task_secrets_canary_run_evidence'))
  assert.ok(calls.indexOf('pg_evidence_failed') < calls.indexOf('agents.stopRun'))
  assert.ok(calls.indexOf('agents.stopRun') < calls.indexOf('machine_end'))
  assert.ok(calls.indexOf('machine_end') < calls.indexOf('agents.getThreadMachine'))
  assert.ok(!calls.includes('issue-operations.setIssueDeleted'))
  const saved = await readSecretJournal(f.options)
  assert.equal(saved.cases[0].cleanup.status, 'passed'); assert.equal(saved.cases[0].cleanup.taskRetained, true)
  assert.equal(saved.recovery.status, 'unconfirmed')
})

test('no journal means no credential or provider access, and a missing creation identity remains unconfirmed', async t => {
  const f = durableFixture(), directory = await mkdtemp(join(tmpdir(), 'mikka-1712-empty-recovery-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  f.options.reportPath = join(directory, 'report.json')
  const untouched = () => assert.fail('no account/provider access without a journal')
  const missing = await cleanupTaskSecrets(f.options, { sessionClient: untouched, cleanupFixture: untouched })
  assert.equal(missing.status, 'not_started')
  f.report.cases = []
  f.report.resources.intents.push({ id: randomUUID(), kind: 'bot_create', state: 'outcome_unknown' })
  await writeSecretCheckpoint(join(directory, 'canary-journal.json'), secretJournal(f.report))
  const result = await cleanupTaskSecrets(f.options, { env: {}, sessionClient: () => ({ clear() {}, request: untouched, json: untouched, rpc: untouched }) })
  assert.equal(result.status, 'unconfirmed')
  assert.ok(result.retained.some(item => item.reason === 'unresolved_resource_creation'))
})

test('exact cleanup refuses unrelated Factory runs, retries and mutating endpoints before forwarding them', async () => {
  const ownerId = 'synthetic-owner', workspaceId = randomUUID(), foreignRunId = randomUUID(), forwarded = []
  const client = {
    json: async path => { forwarded.push(path); return { issueId: caseId, tasks: [{ id: randomUUID(), issueId: caseId }] } },
    rpc: async name => { forwarded.push(name); return { thread: { id: runId, ownedByCurrentUser: true,
      attempts: [{ runId, status: 'running' }, { runId: foreignRunId, status: 'running' }] },
    live: { issueWorkspaceId: workspaceId, runs: [{ id: runId, workspaceId }] } } },
  }
  const exact = exactCleanupClient(client, { issueId: caseId, runId }, { ownerId, workspaceId })
  await assert.rejects(exact.json(`/api/factory/tasks?issueId=${caseId}`), /cleanup/)
  await assert.rejects(exact.rpc('agents.getIssueThread', [caseId, runId]), /cleanup/)
  const readCount = forwarded.length
  await assert.rejects(exact.rpc('agents.stopRun', [foreignRunId]), /cleanup/)
  await assert.rejects(exact.rpc('issue-operations.setIssueDeleted', [{ id: caseId }]), /cleanup/)
  await assert.rejects(exact.json(`/api/threads/${foreignRunId}/machine`, { method: 'POST', body: '{"action":"end"}' }), /cleanup/)
  await assert.rejects(exact.json('/api/factory/tasks/foreign', { method: 'POST', body: '{}' }), /cleanup/)
  assert.equal(forwarded.length, readCount)
})

test('the real public thread projection reaches exact stop and provider retirement without invented owner fields', async () => {
  const ownerId = 'synthetic-owner', workspaceId = randomUUID(), calls = []
  const record = { issueId: caseId, runId, title: 'synthetic acceptance task' }
  let stopped = false, machineEnded = false
  const client = {
    async rpc(name, args) {
      calls.push(name)
      if (name === 'issues.getIssue') {
        assert.deepEqual(args, [caseId])
        return { issue: { id: caseId, userId: ownerId, workspaceId, ownershipState: 'bound', title: record.title } }
      }
      if (name === 'agents.stopRun') { assert.deepEqual(args, [runId]); stopped = true; return {} }
      assert.deepEqual(args, [caseId, runId])
      if (name === 'agents.getThreadMachine') {
        assert.equal(machineEnded, true); return { kind: 'cloud', state: 'ended', cloud: null }
      }
      assert.equal(name, 'agents.getIssueThread')
      // Exactly the normal product projection: no thread.userId or issueId.
      return { thread: { id: runId, ownedByCurrentUser: true, attempts: [{ runId, status: stopped ? 'stopped' : 'running' }] },
        live: { issueWorkspaceId: workspaceId, runs: [{ id: runId, workspaceId }] } }
    },
    async json(path, init) {
      if (path === `/api/factory/tasks?issueId=${caseId}`) return { issueId: caseId, tasks: [] }
      assert.equal(path, `/api/threads/${runId}/machine`)
      assert.equal(init.method, 'POST'); assert.deepEqual(JSON.parse(init.body), { action: 'end' })
      assert.equal(stopped, true); machineEnded = true; calls.push('machine_end')
      return { runId, state: 'ended' }
    },
  }
  const { issue } = await client.rpc('issues.getIssue', [caseId])
  assert.equal(issue.userId, ownerId); assert.equal(issue.workspaceId, workspaceId); assert.equal(issue.ownershipState, 'bound')
  await cleanupCase(exactCleanupClient(client, record, { ownerId, workspaceId }), record, 'cloud', { preserveIssue: true })
  assert.equal(record.cleanup.status, 'passed'); assert.equal(record.cleanup.taskRetained, true)
  assert.equal(record.cleanup.machines[0].outcome, 'ended')
  assert.ok(calls.indexOf('agents.stopRun') < calls.indexOf('machine_end'))
  assert.ok(calls.indexOf('machine_end') < calls.indexOf('agents.getThreadMachine'))
  assert.ok(!calls.includes('issue-operations.setIssueDeleted'))
})

test('journal persistence failure cannot skip exact fixture retirement, and remains an unconfirmed cleanup', async t => {
  const f = durableFixture(), directory = await mkdtemp(join(tmpdir(), 'mikka-1712-recovery-disk-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  f.options.reportPath = join(directory, 'report.json'); f.report.cases = []
  f.report.resources.fixture = { sandboxId: 'owned-exact-fixture', metadata: {
    application: 'mikka-1712-secret-fixture', acceptance: f.report.fixtureId, sourceCommit: f.report.sourceCommit,
    driverRunId: String(f.options.driver.runId), driverRunAttempt: String(f.options.driver.runAttempt),
  } }
  await writeSecretCheckpoint(join(directory, 'canary-journal.json'), secretJournal(f.report))
  let retired = false
  const result = await cleanupTaskSecrets(f.options, { env: { E2B_API_KEY: 'synthetic-private-key' },
    sessionClient: () => ({ clear() {} }), writeCheckpoint: async () => { throw Error('synthetic-disk-error') },
    cleanupFixture: async (target, _key, options) => {
      assert.deepEqual(target, f.report.resources.fixture); assert.ok(options.signal instanceof AbortSignal)
      retired = true; return { stopped: true, outcome: 'provider_kill_and_absence_verified' }
    } })
  assert.equal(retired, true); assert.equal(result.fixtureStopped, true); assert.equal(result.status, 'unconfirmed')
  assert.ok(result.errors.some(item => item.step === 'journal'))
})

test('production native scope requires the inherited endpoint and cannot accept an isolated fixture grant as evidence', () => {
  const production = { ...config, deliveryMode: 'production_claim', phase: 'fresh_claim',
    secretName: 'ACCEPTANCE_1712_' + 'A'.repeat(32), sdkResponseSha256: '6'.repeat(64) }
  assert.throws(() => nativeScope(production), /configuration/)
  delete production.bootstrapToken
  assert.equal(nativeScope(production).phase, 'fresh_claim')
  const command = nativeCommand(production, '7'.repeat(64)), receipt = goodReceipt()
  assert.throws(() => nativeReceipt(toolPair(receipt, command), { ...production, runId }, command), /receipt/)
  receipt.productionStoreMutated = true
  Object.assign(receipt.http, { scope: 'production_store_actual_claim_inherited_bridge', productionClaimTested: true,
    productionStoreRotationTested: true, sdk: { ordinaryTransport: true, customFetch: false, retries: 0,
      responseSha256: production.sdkResponseSha256, finishReason: 'stop', inputTokens: 2, outputTokens: 3 } })
  const projected = nativeReceipt(toolPair(receipt, command), { ...production, runId }, command)
  assert.equal(projected.http.productionClaimTested, true)
  assert.equal(projected.http.statuses.rotatedKey, undefined)
  receipt.http.sdk.responseSha256 = '9'.repeat(64)
  assert.throws(() => nativeReceipt(toolPair(receipt, command), { ...production, runId }, command), /receipt/)
})

test('bundled production probe uses a real inherited bridge and ordinary SDK over TCP; production fixtures cannot self-mint grants', { timeout: 20_000 }, async t => {
  const controlToken = '8'.repeat(64), canary = 'mikka1712s_' + '9'.repeat(64), secretName = 'ACCEPTANCE_1712_' + 'A'.repeat(32)
  const fixture = await startFixture({ fixtureId: caseId, controlToken, upstreamOrigin: config.upstreamOrigin,
    egressOrigin: config.fixtureOrigin }, '// reviewed client', { listenHost: '127.0.0.1', upstreamPort: 0, egressPort: 0 })
  t.after(() => fixture.close())
  const local = `http://127.0.0.1:${fixture.egressAddress.port}`, upstream = `http://127.0.0.1:${fixture.upstreamAddress.port}`
  const post = (path, value, authorization) => fetch(local + path, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) }, body: JSON.stringify(value) })
  const control = value => post('/control', { caseId, ...value }, `Bearer ${controlToken}`)
  const state = await (await control({ action: 'create_production', canary })).json()
  assert.equal(state.canarySha256, hash(canary)); assert.doesNotMatch(JSON.stringify(state), /mikka1712s_/)
  assert.equal((await control({ action: 'bind', runId })).status, 200)
  for (const operation of ['grant', 'rotate']) assert.equal((await post(`/${operation}/${caseId}`, { runId, bootstrapToken: config.bootstrapToken })).status, 403)
  const wait = control({ action: 'wait_protected' })
  const key = '4'.repeat(64), http = productionDelivery(config.upstreamOrigin, caseId).http
  const grant = issueEgressCapability({ ownerId: 'synthetic-owner', workspaceId: null, repository: config.repository,
    runId, deviceId: caseId, deviceTokenId: caseId, attempt: 1, name: secretName, secretId: caseId,
    revision: '3'.repeat(64), secret: canary, leaseExpiresAt: Date.now() + 90_000, http }, Date.now(), { WORKSPACE_SECRETS_KEY: key })
  const errors = [], egress = createServer((request, response) => {
    void (async () => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk)
      const input = new Request(`http://localhost${request.url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.concat(chunks) })
      const result = await taskSecretEgressResponse(input, runId, (envelope, expected, options) => executeEgressRequest(envelope, expected, {
        ...options, env: { WORKSPACE_SECRETS_KEY: key }, resolve: async () => [{ address: '8.8.8.8', family: 4 }],
        // Isolated component test: the production public-DNS policy still
        // runs, while only its final HTTPS transport is sent to this local TCP fixture.
        transport: async target => {
          const result = await fetch(`${upstream}${target.url.pathname}`, { method: target.method, headers: target.headers,
            body: target.body.length ? target.body : undefined, redirect: 'manual' })
          return { status: result.status, headers: [...result.headers], body: Buffer.from(await result.arrayBuffer()) }
        },
      }))
      response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(Buffer.from(await result.arrayBuffer()))
    })().catch(error => { errors.push(error); response.destroy() })
  })
  await new Promise(resolve => egress.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { egress.closeAllConnections(); egress.close(resolve) }))
  const abort = new AbortController(), bridge = await startTaskSecretBridge({ signal: abort.signal,
    current: () => ({ version: 1, endpoint: `http://127.0.0.1:${egress.address().port}/egress/${runId}`, grants: [grant], unavailable: [] }) })
  t.after(() => { abort.abort(); bridge.close() })
  const bundles = await buildFixtureBundles(), directory = await mkdtemp(join(tmpdir(), 'mikka-1712-bundled-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'client.mjs'); await writeFile(file, bundles.client.source)
  const bundled = await import(pathToFileURL(file).href)
  const input = { ...config, ...state, deliveryMode: 'production_claim', secretName, phase: 'fresh_claim' }; delete input.bootstrapToken
  const result = await bundled.productionHttpProof(input, { environment: bridge.env,
    fetchImpl: (url, options) => fetch(url.startsWith(config.upstreamOrigin) ? url.replace(config.upstreamOrigin, upstream) : url, options) })
  assert.equal(result.productionClaimTested, true); assert.equal(result.sdk.ordinaryTransport, true)
  assert.deepEqual(result.statuses, { method: 502, path: 502, echo: 502, redirect: 502, origin: 403, authOverride: 403 })
  assert.equal((await (await wait).json()).runId, runId)
  const receipt = await (await control({ action: 'receipt' })).json()
  assert.deepEqual(receipt.counts, { public: 10, protected: 10, echo: 1, redirect: 1, sdk: 1 })
  assert.equal(receipt.issued, false); assert.equal(receipt.mode, 'production_claim')
  assert.equal(errors.length, 0)
  assert.doesNotMatch(JSON.stringify({ result, receipt, env: bridge.env }), /mikka1712s_|WORKSPACE_SECRETS_KEY/)
  await assert.rejects(productionHttpProof(input, { environment: { ...bridge.env, [secretName]: canary } }), /secret_environment_visible/)
})
