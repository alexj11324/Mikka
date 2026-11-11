import { nativeCall, eveResponse } from '../../tests/support/eve-acceptance.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { readOptions, nativeCommand, nativeReceipt, productionCanaryPlan, runTaskSecretsAcceptance, safeFailure } from './task-secrets.mjs'
import { nativeScope, nativeGitProof, scanCanary, productionHttpProof } from './task-secrets-native.mjs'
import { buildFixtureBundles, createIsolatedFixture } from './task-secrets-fixture.mjs'
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
    { chunk: { type: 'tool-output-available', toolCallId: `${runId}:tool1`,
      output: { exitCode: 0, output: `MIKKA_1712_NATIVE ${JSON.stringify(value)}\n` } } }] }
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
async function normalCloudCase(changeDetail = () => {}, releaseAttestation, production = false) {
  const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  const ownerId = 'synthetic-smoke-owner', adminId = 'synthetic-team-admin', workspaceId = uuid(1), botId = uuid(2)
  const deviceId = uuid(5), connectionId = uuid(6), privateSecretId = uuid(9)
  let profileId = uuid(3), issueId = uuid(4), actualRunId = runId, sequence = 0, active = false, privateSecret
  const email = 'acceptance+mikka-smoke@example.invalid', model = 'gpt-6-luna', digest = '6'.repeat(64)
  const source = { kind: 'subscription', connectionId }, calls = [], createdProfileIds = new Set()
  let dispatchInput, profile, issue, bot, machineEnded = false, observed = false
  const workspace = { currentUserId: ownerId, workspace: { id: workspaceId, kind: 'team' }, role: 'member',
    choices: [{ id: workspaceId, kind: 'team' }],
    members: [{ userId: adminId, email: 'alex@acme.aspectlylabs.com', role: 'admin', status: 'active' }] }
  const client = {
    clear() {},
    async request(path) {
      calls.push(path)
      if (path === '/api/auth/sign-in/email' || path === '/api/auth/sign-out') return new Response('{}')
      if (path === `/api/agents/eve/v1/session?botId=${botId}`) return Response.json({ ok: true, sessionId: 'wrun_secrets' })
      assert.equal(path, `/api/agents/eve/v1/session/wrun_secrets/stream?botId=${botId}&startIndex=0`)
      return eveResponse(nativeCall('dispatch', dispatchInput, { runId: actualRunId ?? runId }))
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
      if (path === `/api/threads/${actualRunId}/machine`) { machineEnded = true; return { runId: actualRunId, state: 'ended' } }
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
      if (name === 'coordinator.sendCoordinatorMessage') { dispatchInput = JSON.parse(args[0].match(/参数：(.*)。使用/)[1]); active = true; return {} }
      if (['coordinator.stopCoordinatorTurn', 'issue-operations.setIssueDeleted'].includes(name)) return {}
      if (name === 'user-secrets.createMySecret') {
        privateSecret = { id: privateSecretId, name: args[0].name, note: args[0].note, kind: 'secret', delivery: { mode: 'protected' } }
        return { ok: true, data: structuredClone(privateSecret) }
      }
      if (name === 'user-secrets.replaceMySecret') { assert.equal(args[0].id, privateSecretId); active = false; return { ok: true, data: structuredClone(privateSecret) } }
      if (name === 'user-secrets.deleteMySecret') { assert.equal(args[0].id, privateSecretId); privateSecret = undefined; return { ok: true, data: { id: privateSecretId } } }
      if (name === 'agents.pollIssueThreads') return { threads: [{ id: actualRunId ?? runId, ownedByCurrentUser: true }] }
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
  const directory = production ? await mkdtemp(join(tmpdir(), 'mikka-1712-driver-')) : null
  if (directory) options.reportPath = join(directory, 'report.json')
  const productionCases = new Map()
  if (releaseAttestation) options.releaseAttestation = releaseAttestation
  const report = await runTaskSecretsAcceptance(options, {
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

test('a protected request plus stopped run cannot replace the exact native command in revocation evidence', async () => {
  const report = await normalCloudCase((detail, record) => {
    if (record.phase === 'revocation') detail.chunks.find(({ chunk }) => chunk.type === 'tool-input-available').chunk.input.command += '\necho changed'
  }, undefined, true)
  assert.equal(report.status, 'blocked')
  assert.equal(report.cases[0].failure, 'task_secrets_canary_revocation')
  assert.equal(report.productionCanary.cleanup.deleted, true)
})

test('optional diagnostics cannot replace a successful native tool, post-tool reply, matching terminal run or external proof', async () => {
  const changes = {
    missingTool: detail => { detail.chunks = detail.chunks.filter(item => !item.chunk.type.startsWith('tool-')) },
    failedNativeExit: detail => { detail.chunks.find(item => item.chunk.type === 'tool-output-available').chunk.output.exitCode = 1 },
    unknownNativeExit: detail => { detail.chunks.find(item => item.chunk.type === 'tool-output-available').chunk.output.exitCode = null },
    missingNativeExit: detail => { delete detail.chunks.find(item => item.chunk.type === 'tool-output-available').chunk.output.exitCode },
    stringNativeExit: detail => { detail.chunks.find(item => item.chunk.type === 'tool-output-available').chunk.output.exitCode = '0' },
    missingReply: detail => { detail.chunks = detail.chunks.filter(item => item.chunk.type !== 'text-delta') },
    replyBeforeTool: detail => { detail.chunks.splice(1, 0, detail.chunks.pop()) },
    notTerminal: detail => { detail.thread.status = 'running' },
    failed: detail => { detail.thread.status = 'failed' },
    cancelled: detail => { detail.thread.status = 'cancelled' },
    succeeded: detail => { detail.thread.status = 'succeeded' },
    completed: detail => { detail.thread.status = 'completed' },
    foreignTerminal: detail => { detail.thread.id = caseId },
    missingNativeProof: detail => { detail.chunks.find(item => item.chunk.type === 'tool-output-available').chunk.output = { exitCode: 0, output: 'done' } },
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
      query: async (sql, params) => {
        statements.push(sql); if (params) parameters.push(params)
        if (sql.startsWith('WITH active')) return { rows: [{ ...state }] }
        return { rows: [] }
      },
      release: () => { state.released++ },
    } }
    async end() { state.ended = true }
  }
  const verifier = await createOwnerIdleVerifier({ connectionString: 'postgres://synthetic-private-db', ownerId: 'synthetic-owner',
    email: 'owner@example.invalid', window: windowAt(now), sourceCommit: config.sourceCommit, fixtureId: caseId }, { Pool, now: () => now })
  const proof = await verifier.assertIdle([])
  assert.equal(proof.foreignActiveCount, 0); assert.equal(proof.atomicWithMutation, false)
  assert.equal(proof.scope, 'all_owner_runs_all_workspaces_without_time_or_row_limit')
  assert.equal(settings[0].options, '-c default_transaction_read_only=on')
  assert.match(statements[0], /BEGIN.*READ ONLY/)
  const query = statements.find(sql => sql.startsWith('WITH active'))
  assert.doesNotMatch(query, /LIMIT|createdAt|workspaceId|UPDATE|INSERT|DELETE/i)
  assert.deepEqual(parameters[0][4], ['queued', 'preparing', 'running', 'paused', 'waiting_input', 'finishing'])
  state.unfinishedCount = state.foreignCount = 1
  await assert.rejects(verifier.assertIdle([]), /canary_idle_unverified/)
  state.foreignCount = 0
  assert.equal((await verifier.assertIdle([runId])).ownedActiveCount, 1)
  for (const change of [{ ownerMatches: 0 }, { unknownStatusCount: 1 }, { readOnly: 'off' }]) {
    const before = { ...state }; Object.assign(state, change)
    await assert.rejects(verifier.assertIdle([runId]), /canary_idle_unverified/); Object.assign(state, before)
  }
  assert.ok(statements.includes('ROLLBACK'))
  assert.doesNotMatch(JSON.stringify(proof), /synthetic-owner|owner@example|synthetic-private-db/)
  await verifier.close(); assert.equal(state.ended, true)
})

async function canaryStoreHarness({ lostCreate = false } = {}) {
  const id = randomUUID(), oldId = randomUUID(), now = Date.now(), calls = [], persisted = [], values = new Map()
  const old = { id: oldId, name: 'UNRELATED_PRIVATE_ENTRY', kind: 'secret', note: 'not a fixture', delivery: { mode: 'protected' } }
  const rows = new Map([[oldId, old]])
  let busy = false, closed = false
  const verifier = {
    async assertIdle(allowed) {
      calls.push({ operation: 'idle', allowed: [...allowed] })
      if (busy) throw Error('task_secrets_canary_idle_unverified')
      return { ownedActiveCount: allowed.length, ownedStopRequestedCount: 0, foreignActiveCount: 0, atomicWithMutation: false }
    },
    async assertRevoked(actual, requestedAt) { assert.equal(actual, runId); return { status: 'stopped', requestedAt, leaseExpired: true } },
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
      } else {
        assert.equal(name, 'user-secrets.deleteMySecret'); assert.equal(input.id, id)
        calls.push({ operation: 'delete', id }); rows.delete(id); values.delete(id)
        return { ok: true, data: { id } }
      }
      return { ok: true, data: structuredClone(rows.get(id)) }
    },
  }
  const canary = await createProductionCanary({ client, ownerId: 'synthetic-owner', email: 'owner@example.invalid',
    workspaceId: runId, fixtureId: caseId, sourceCommit: config.sourceCommit, window: windowAt(now), connectionString: 'synthetic-connection',
    pin: async () => { calls.push({ operation: 'pin' }) }, persist: async value => { persisted.push(value) } },
  { verifierFactory: async () => verifier, now: () => now })
  const fixture = { upstreamOrigin: config.upstreamOrigin, createProductionCase: async (actualCase, canaryValue) => {
    assert.equal(canaryValue, values.get(id)); return { caseId: actualCase, canarySha256: hash(canaryValue), responseSha256: config.responseSha256, sdkResponseSha256: '6'.repeat(64) }
  } }
  return { canary, fixture, calls, persisted, rows, values, id, oldId, old, busy: () => { busy = true }, closed: () => closed }
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
