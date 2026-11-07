import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { cleanupLifecycleCase, createProviderObserver, isExactNativeCommand, lifecycleHash, MODELS, nativeEvidence, nativeSnapshotCommand,
  readOptions, runLifecycleCase, runThreadLifecycle, safeError } from './thread-lifecycle.mjs'
import { watchRun } from './cloud-startup.mjs'

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const SOURCE = 'a'.repeat(40), DIGEST = 'b'.repeat(64), SOURCE_FILE = { path: 'lib/cloud-computer/thread-lifecycle.ts', sha256: DIGEST, excerpt: 'export function decision() {}' }
const OWNER = 'PRIVATE_SMOKE_USER', ADMIN = 'PRIVATE_TEAM_ADMIN', workspaceId = id(2), personalWorkspace = id(3), botId = id(4)
const epoch = Date.parse('2026-11-07T12:00:00Z'), now = () => epoch
const sha = value => createHash('sha256').update(value).digest('hex')
const env = { GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_run', EXPECTED_SOURCE_SHA: SOURCE,
  RUNNER_TEMP: '/tmp/runner', SMOKE_OWNER_EMAIL: 'acceptance+mikka-smoke@example.invalid', SMOKE_OWNER_PASSWORD: 'PRIVATE_PASSWORD', E2B_API_KEY: 'PRIVATE_PROVIDER_KEY' }
const scope = { ownerId: OWNER, adminId: ADMIN, workspaceId, botId, evidence: { teamWorkspaceHash: DIGEST } }
const profile = { id: id(5), version: 1, digest: DIGEST, harness: 'claude_code',
  model: { mode: 'fixed', harness: 'claude_code', model: MODELS.claude_code, source: { kind: 'subscription', connectionId: id(6) } } }
const fixture = () => {
  const record = { caseId: id(10), sourceCommit: SOURCE, markerValue: 'c'.repeat(32), runId: id(11), continuationRunId: id(12),
    issueId: id(13), taskId: id(14), sandboxId: 'owned-case-vm', correlation: {}, provider: {} }
  const body = JSON.stringify({ caseId: record.caseId, sourceCommit: SOURCE, markerValue: record.markerValue }) + '\n'
  return { ...record, markerSha256: sha(body), markerBytes: Buffer.byteLength(body) }
}
const markerProof = (record, phase) => {
  const reportText = `# #1593 ${SOURCE}\nowner_choice=provider-receipts\n## Evidence\nNative CLI exit and actual same session must be independently observed.\n## Risks\nA lost pause response is ambiguous; a database paused state cannot prove provider pause.\n## Limits\nNo final automatic review or arbitrary Markdown download was authorized. Check the owned provider metadata and preserve the uploaded checkpoint before cleanup.\n`
  return { caseId: record.caseId, phase, head: 'd'.repeat(40), rootSha256: DIGEST, trackedSha256: DIGEST, statusSha256: DIGEST,
    markerSha256: record.markerSha256, markerBytes: record.markerBytes, reportSha256: sha(reportText), reportBytes: Buffer.byteLength(reportText),
    ...(phase === 'delivery' ? { reportText } : {}) }
}
const nativePair = (callId, toolName, input, output, offset = 0) => [
  { at: new Date(epoch + offset).toISOString(), chunk: { type: 'tool-input-available', toolCallId: callId, toolName, input } },
  { at: new Date(epoch + offset + 1).toISOString(), chunk: { type: 'tool-output-available', toolCallId: callId, output } },
]
const proofChunks = (record, phase, codex = false) => {
  const output = 'MIKKA_1593_NATIVE ' + JSON.stringify(markerProof(record, phase))
  return nativePair(`${record.runId}:${phase}`, 'bash', { command: nativeSnapshotCommand(record, phase) }, codex ? { exitCode: 0, output } : output)
}

test('entry requires main workflow, exact source, runner temp, and the existing smoke identity', () => {
  assert.equal(readOptions(env).reportPath, '/tmp/runner/thread-lifecycle-acceptance/report.json')
  for (const change of [{ GITHUB_ACTIONS: 'false' }, { GITHUB_REF: 'refs/pull/1/merge' }, { GITHUB_EVENT_NAME: 'workflow_dispatch' },
    { EXPECTED_SOURCE_SHA: 'latest' }, { RUNNER_TEMP: '.' }, { SMOKE_OWNER_EMAIL: 'different-owner@example.invalid' }]) {
    assert.throws(() => readOptions({ ...env, ...change }), /(?:lifecycle|startup)_/)
  }
  assert.deepEqual(MODELS, { claude_code: 'claude-haiku-5-5', codex: 'gpt-6-luna' })
})

test('Owner RPC action literals belong to the real registry and argument-schema closed sets', () => {
  const actionNames = path => new Set([...readFileSync(new URL(path, import.meta.url), 'utf8')
    .matchAll(/^  '([^']+)':/gm)].map(match => match[1]))
  const registry = actionNames('../../lib/desktop-rpc/registry.ts')
  const schemas = actionNames('../../lib/desktop-rpc/schemas.ts')
  const source = readFileSync(new URL('./thread-lifecycle.mjs', import.meta.url), 'utf8')
  const used = new Set([...source.matchAll(/\.rpc\(\s*['"]([^'"]+)['"]/g)].map(match => match[1]))
  assert.ok(used.size > 0 && registry.size > 0 && schemas.size > 0)
  for (const action of used) {
    assert.ok(registry.has(action), `${action} is absent from the real RPC registry`)
    assert.ok(schemas.has(action), `${action} is absent from the real RPC argument schemas`)
  }
})

test('unknown errors and secret response bodies never become public error strings', () => {
  assert.equal(safeError(new Error('PRIVATE_PASSWORD cookie=PRIVATE_COOKIE')), 'lifecycle_failed')
  assert.equal(safeError(new Error('lifecycle_source_pin_required')), 'lifecycle_source_pin_required')
  assert.equal(lifecycleHash('run', id(1)), sha(`run:${id(1)}`).slice(0, 12))
})

test('provider 404 before positive ownership is blocked, not pause or cleanup proof', async () => {
  let calls = 0
  const observe = createProviderObserver({ apiKey: 'PRIVATE_KEY', now, getInfo: async () => { calls++; throw { status: 404, body: 'PRIVATE_RESPONSE' } } })
  const proof = await observe({ sandboxId: 'owned-case-vm', workspaceId, originRunId: id(11) })
  assert.equal(calls, 1)
  assert.deepEqual(proof, { requestedAt: new Date(epoch).toISOString(), observedAt: new Date(epoch).toISOString(), vmHash: lifecycleHash('vm', 'owned-case-vm'),
    status: 'blocked', reason: 'account_mapping_unproven_404', ownershipVerified: false })
  assert.doesNotMatch(JSON.stringify(proof), /PRIVATE/)
})

test('provider requires exact application/workspace/creation-run metadata and accepts missing only after positive mapping', async () => {
  let next = { sandboxId: 'owned-case-vm', state: 'paused', metadata: { application: 'mikka-thread', workspaceId, runId: id(11), operationId: id(20) } }
  const observe = createProviderObserver({ apiKey: 'PRIVATE_KEY', now, getInfo: async (sandboxId, options) => {
    assert.equal(sandboxId, 'owned-case-vm'); assert.equal(options.requestTimeoutMs, 15000)
    if (!next) throw { name: 'SandboxNotFoundError' }
    return next
  } })
  const target = { sandboxId: 'owned-case-vm', workspaceId, originRunId: id(11) }
  assert.equal((await observe(target)).state, 'paused')
  next = null
  assert.equal((await observe(target)).state, 'missing')
  assert.equal((await observe({ ...target, originRunId: id(12) })).reason, 'account_mapping_unproven_404')
  next = { sandboxId: 'owned-case-vm', state: 'paused', metadata: { application: 'mikka-thread', workspaceId, runId: id(12), operationId: id(20) } }
  assert.equal((await observe(target)).reason, 'provider_metadata_mismatch')
})

test('provider observation times distinguish request start from successful, missing and failed responses', async () => {
  let clock = epoch, outcome = 'paused'
  const observe = createProviderObserver({ now: () => clock, apiKey: 'PRIVATE_KEY', getInfo: async () => {
    clock += 250
    if (outcome === 'missing') throw { status: 404 }
    if (outcome === 'failed') throw new Error('PRIVATE_PROVIDER_RESPONSE')
    return { sandboxId: 'owned-case-vm', state: outcome,
      metadata: { application: 'mikka-thread', workspaceId, runId: id(11), operationId: id(20) } }
  } })
  for (const state of ['paused', 'missing', 'failed']) {
    outcome = state
    const requestedAt = new Date(clock).toISOString(), observedAt = new Date(clock + 250).toISOString()
    const result = await observe({ sandboxId: 'owned-case-vm', workspaceId, originRunId: id(11) })
    assert.equal(result.observedAt, observedAt)
    assert.equal(result.requestedAt, requestedAt)
    assert.equal(result.status, state === 'failed' ? 'blocked' : 'observed')
    assert.equal(result.ownershipVerified, true)
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/)
  }
})

test('no observation key does not contact E2B or substitute the CI key into product settings', async () => {
  const observe = createProviderObserver({ now, getInfo: async () => assert.fail('must not call E2B') })
  assert.equal((await observe({ sandboxId: 'owned-case-vm', workspaceId, originRunId: id(11) })).reason, 'observation_key_unavailable')
})

test('native commands are valid Python and never create another repository, read credentials, or use provider exec', () => {
  for (const phase of ['before_question', 'after_answer', 'delivery']) {
    const command = nativeSnapshotCommand(fixture(), phase)
    const python = command.split('\n').slice(1, -1).join('\n')
    execFileSync('python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: python, stdio: ['pipe', 'pipe', 'pipe'] })
    assert.doesNotMatch(command, /os\.environ|HOME|git.*init|git.*push|\.ssh|\.env|\.connect\(/)
    assert.equal(command.includes("marker.open('xb')"), phase === 'before_question')
  }
})

test('only the full literal expected native program or a literal shell wrapper is accepted', () => {
  const expected = nativeSnapshotCommand(fixture(), 'before_question')
  const quoted = `'${expected.replaceAll("'", "'\\''")}'`
  assert.equal(isExactNativeCommand(`/bin/bash -lc ${quoted}`, expected), true)
  assert.equal(isExactNativeCommand(`/bin/bash -lc ${quoted}; echo forged`, expected), false)
  assert.equal(isExactNativeCommand('python3 -c "print(\'hashlib.sha256 subprocess.check_output\')"', expected), false)
  const record = fixture(), forged = proofChunks(record, 'before_question')
  forged[0].chunk.input.command = `python3 -c 'print("hashlib.sha256 subprocess.check_output ${record.caseId}")'`
  assert.throws(() => nativeEvidence({ chunks: forged }, record), /native_command_mismatch/)

  // A real Codex case prepended a report heredoc to the complete expected script.
  // Even authentic-looking marker output cannot make that combined call exact.
  const combined = proofChunks(record, 'before_question', true)
  const reportWrite = `cat > issue-1593-${record.caseId}.md <<'REPORT'\n# #1593 fixture report\nREPORT\n`
  const command = reportWrite + expected
  combined[0].chunk.input.command = `/bin/bash -lc '${command.replaceAll("'", "'\\''")}'`
  assert.equal(isExactNativeCommand(combined[0].chunk.input.command, expected), false)
  assert.throws(() => nativeEvidence({ chunks: combined }, record), /native_command_mismatch/)
})

test('only real paired native outputs count; Claude strings and Codex command objects both work', () => {
  const record = fixture()
  for (const codex of [false, true]) {
    const proof = nativeEvidence({ chunks: proofChunks(record, 'before_question', codex) }, record)
    assert.equal(proof.snapshots.before_question.markerSha256, record.markerSha256)
    assert.equal(proof.snapshots.before_question.head, 'd'.repeat(40))
  }
  assert.deepEqual(nativeEvidence({ chunks: [{ chunk: { type: 'text-delta', delta: 'MIKKA_1593_NATIVE ' + JSON.stringify(markerProof(record, 'before_question')) } }] }, record).snapshots, {})
  const broken = proofChunks(record, 'before_question', true)
  broken[1].chunk.output.exitCode = 1
  assert.deepEqual(nativeEvidence({ chunks: broken }, record).snapshots, {})
})

test('cross-run tool prefixes, unpaired output, corrupted marker and final submit cannot satisfy native proof', () => {
  const record = fixture(), foreign = proofChunks({ ...record, runId: id(90) }, 'before_question')
  assert.deepEqual(nativeEvidence({ chunks: foreign }, record).snapshots, {})
  assert.deepEqual(nativeEvidence({ chunks: proofChunks(record, 'before_question').slice(1) }, record).snapshots, {})
  const bad = proofChunks(record, 'before_question')
  bad[1].chunk.output = bad[1].chunk.output.replace(record.markerSha256, 'e'.repeat(64))
  assert.throws(() => nativeEvidence({ chunks: bad }, record), /native_snapshot_mismatch/)
  assert.throws(() => nativeEvidence({ chunks: nativePair('submit', 'mcp__mikka__submit', {}, 'ok') }, record), /unexpected_final_submission/)
})

test('final native report bytes are verified but only their hash and size enter the public proof', () => {
  const record = fixture()
  const proof = nativeEvidence({ chunks: proofChunks(record, 'delivery') }, record)
  assert.equal(proof.snapshots.delivery.reportSha256, markerProof(record, 'delivery').reportSha256)
  assert.doesNotMatch(JSON.stringify(proof.snapshots), /reportText|owner_choice|ambiguous/)
  const truncated = proofChunks(record, 'delivery')
  truncated[1].chunk.output = truncated[1].chunk.output.slice(-30)
  assert.deepEqual(nativeEvidence({ chunks: truncated }, record).snapshots, {})
})

function mainClient({ configured = true, errorOnArchive = false, loseFirstProfileResponse = false } = {}) {
  let selected = personalWorkspace, nextBot = 100
  const calls = [], botNames = new Map(), profiles = []
  const choices = [{ id: workspaceId, kind: 'team' }, { id: personalWorkspace, kind: 'personal' }]
  const workspace = current => ({ currentUserId: OWNER, workspace: { id: current, kind: current === workspaceId ? 'team' : 'personal' },
    role: 'member', choices, members: current === workspaceId ? [{ userId: ADMIN, email: 'alex@acme.aspectlylabs.com', role: 'admin', status: 'active' }] : [] })
  const identity = { user: { id: OWNER, email: env.SMOKE_OWNER_EMAIL } }
  const client = {
    request: async (path, init) => {
      calls.push({ path, method: init?.method })
      if (path.startsWith('/api/factory/agent-profiles/')) {
        const profile = profiles.find(item => item.id === path.split('/').at(-1).split('?')[0])
        return profile ? { ok: true, status: 200, json: async () => ({ profile }) } : { ok: false, status: 404 }
      }
      return { ok: true, status: 200 }
    },
    clear: () => calls.push({ action: 'clear' }),
    json: async (path, init) => {
      calls.push({ path, method: init?.method })
      if (path === '/api/version') return { build: SOURCE }
      if (path === '/api/auth/get-session') return identity
      if (path === '/api/workspace') return workspace(selected)
      if (path === `/api/workspace?workspace=${workspaceId}`) return workspace(workspaceId)
      if (path === '/api/rpc') {
        const body = JSON.parse(init.body); assert.equal(body.action, 'workspace.switchWorkspace'); selected = body.args[0]
        return { version: 1, ok: true, result: { ok: true, data: { workspaceId: selected } } }
      }
      if (path.startsWith('/api/bots/')) { const bot = path.split('/').at(-1); return { id: bot, name: botNames.get(bot) } }
      if (path === '/api/factory/agent-profiles') {
        const body = JSON.parse(init.body), profile = { ...body.profile, id: body.requestId, version: 1, digest: DIGEST }
        profiles.push(profile)
        if (loseFirstProfileResponse && profiles.length === 1) throw new Error('PRIVATE_LOST_CREATE_RESPONSE')
        return { profile }
      }
      if (path.startsWith('/api/factory/agent-profiles/') && init?.method === 'DELETE') {
        if (errorOnArchive) throw new Error('PRIVATE_ARCHIVE_ERROR')
        return { profile: { id: path.split('/').at(-1), archivedAt: new Date(epoch).toISOString() } }
      }
      assert.fail(`unhandled JSON ${path}`)
    },
    rpc: async (action, args) => {
      calls.push({ action, args })
      if (action === 'model-order.getModelOrder') return { candidates: Object.entries(MODELS).map(([harness, model], index) => ({
        harness, model, credentialOwnerId: ADMIN, source: { kind: 'subscription', connectionId: id(50 + index) } })) }
      if (action === 'workspace-secrets.getE2BKeyCapability') return { canEdit: true, configured, byoEnabled: true, lastErrorCode: null, lastErrorAt: null }
      if (action === 'execution-settings.getBotModelMenu') return { groups: Object.entries(MODELS).map(([harness, modelId], index) => ({
        kind: 'subscription', provider: harness === 'codex' ? 'codex' : 'claude', owner: 'Shared member', options: [{ id: id(70 + index), modelId, provider: harness === 'codex' ? 'codex' : 'claude' }] })) }
      if (action === 'execution-settings.chooseBotModel') {
        const codex = args[1] === id(71)
        assert.ok(botNames.has(args[0]), 'only a Bot created by this case may receive a preference')
        return { current: { kind: 'subscription', chosen: true, id: args[1], available: true,
          provider: codex ? 'codex' : 'claude', modelId: codex ? MODELS.codex : MODELS.claude_code } }
      }
      if (action === 'bots.createBot') { const bot = id(nextBot++); botNames.set(bot, args[0].name); return { id: bot } }
      if (action === 'workspace.switchWorkspace') { selected = args[0]; return { workspaceId: selected } }
      if (action === 'coordinator.stopCoordinatorTurn') return { stopped: true }
      assert.fail(`unhandled RPC ${action}`)
    },
  }
  return { client, calls, profiles }
}

test('missing Owner cloud key records both fixed subscription preconditions without allocating Bot/Profile/VM', async () => {
  const f = mainClient({ configured: false })
  const report = await runThreadLifecycle(readOptions(env), { env, createClient: () => f.client, now, readSource: async () => SOURCE_FILE,
    runCase: async () => assert.fail('cloud case must not run'), WebSocketImpl: class {} })
  assert.equal(report.status, 'blocked')
  assert.equal(report.ownerCloud.configured, false)
  assert.equal(report.cases.length, 2)
  assert.ok(report.cases.every(item => item.subscription.available && item.error === 'lifecycle_owner_cloud_key_not_configured'))
  assert.ok(!f.calls.some(call => call.action === 'bots.createBot' || call.path === '/api/factory/agent-profiles'))
  assert.equal(report.cleanup.status, 'passed')
  assert.ok(f.calls.some(call => call.path === '/api/auth/sign-out'))
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_|acceptance\+|apiKey|cookie|password/i)
})

test('preflight HTTP failures retain their closed phase on the report and both unallocated legs', async () => {
  for (const [action, phase, code] of [
    ['model-order.getModelOrder', 'subscription_catalogue', 'startup_http_502'],
    ['workspace-secrets.getE2BKeyCapability', 'owner_cloud_capability', 'startup_http_404'],
  ]) {
    const f = mainClient(), original = f.client.rpc
    f.client.rpc = (name, args) => {
      if (name === action) throw new Error(code, { cause: new Error('PRIVATE_RESPONSE_BODY https://private.invalid') })
      return original(name, args)
    }
    const report = await runThreadLifecycle(readOptions(env), { env, createClient: () => f.client, now, readSource: async () => SOURCE_FILE,
      WebSocketImpl: class {}, runCase: async () => assert.fail('must not allocate') })
    assert.deepEqual(report.failure, { phase, code })
    assert.equal(report.error, code)
    assert.ok(report.cases.every(item => item.status === 'blocked' && item.failure.phase === phase && item.failure.code === code))
    assert.ok(!f.calls.some(call => call.action === 'bots.createBot'))
    assert.equal(report.cleanup.workspaceRestored, true)
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_RESPONSE_BODY|private\.invalid|cause/)
  }
})

test('a failed first leg still runs the second fixed model; the account and profiles are cleaned', async () => {
  const f = mainClient(), legs = []
  const report = await runThreadLifecycle(readOptions(env), { env, createClient: () => f.client, now, readSource: async () => SOURCE_FILE,
    WebSocketImpl: class {}, runCase: async input => {
      legs.push(input.harness)
      assert.equal(input.profile.model.model, MODELS[input.harness]); assert.equal(input.profile.model.source.kind, 'subscription')
      assert.equal(input.scope.ownerId, OWNER); assert.equal(input.scope.adminId, ADMIN)
      return { harness: input.harness, status: legs.length === 1 ? 'failed' : 'partial', cleanup: { status: 'passed', errors: [] } }
    } })
  assert.deepEqual(legs, ['claude_code', 'codex'])
  assert.equal(report.status, 'failed')
  assert.equal(f.profiles.length, 2)
  assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 2)
  assert.ok(!f.calls.some(call => /saveE2BKey|model-order.set/.test(call.action ?? '')))
  assert.equal(f.calls.filter(call => call.action === 'execution-settings.chooseBotModel').length, 2)
  assert.equal(report.cleanup.workspaceRestored, true)
})

test('global source drift blocks new cases but never blocks profile archive, workspace restore, or logout', async () => {
  const f = mainClient(), originalJson = f.client.json
  let changed = false, cases = 0
  f.client.json = (path, init) => path === '/api/version' && changed ? { build: 'e'.repeat(40) } : originalJson(path, init)
  const report = await runThreadLifecycle(readOptions(env), { env, createClient: () => f.client, now, readSource: async () => SOURCE_FILE,
    WebSocketImpl: class {}, runCase: async input => {
      cases++; changed = true
      return { harness: input.harness, status: 'partial', cleanup: { status: 'passed', errors: [] } }
    } })
  assert.equal(cases, 1)
  assert.equal(report.cases[1].error, 'lifecycle_production_source_mismatch')
  assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 1)
  assert.equal(report.cleanup.workspaceRestored, true)
  assert.ok(f.calls.some(call => call.path === '/api/auth/sign-out'))
})

test('cleanup failure is explicit and makes the overall result fail', async () => {
  const f = mainClient({ errorOnArchive: true })
  const report = await runThreadLifecycle(readOptions(env), { env, createClient: () => f.client, now, readSource: async () => SOURCE_FILE,
    WebSocketImpl: class {}, runCase: async input => ({ harness: input.harness, status: 'partial', cleanup: { status: 'passed', errors: [] } }) })
  assert.equal(report.status, 'failed'); assert.equal(report.cleanup.status, 'failed')
  assert.ok(report.cleanup.errors.every(error => error.code === 'lifecycle_failed'))
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_ARCHIVE_ERROR/)
})

test('a failed case entry preserves its owned Bot and marks absent cleanup receipt as failed', async () => {
  const f = mainClient()
  const report = await runThreadLifecycle(readOptions(env), { env, createClient: () => f.client, now, readSource: async () => SOURCE_FILE,
    WebSocketImpl: class {}, runCase: async () => { throw new Error('PRIVATE_ENTRY_ERROR') } })
  assert.ok(report.cases[0].bot.id && report.cases[0].profileId && report.cases[0].cleanup.status === 'failed'
    && report.cases[0].cleanup.errors[0].code === 'lifecycle_cleanup_receipt_missing')
  assert.equal(report.cases[1].error, 'lifecycle_previous_cleanup_unconfirmed')
  assert.equal(report.cases[1].bot, undefined)
  assert.equal(report.status, 'failed')
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_ENTRY_ERROR/)
})

test('a lost dispatch response and empty discovery leave cleanup unconfirmed and block a second allocation', async () => {
  const f = mainClient(), originalJson = f.client.json, originalRpc = f.client.rpc
  let dispatches = 0
  f.client.json = async (path, init) => {
    if (path.endsWith('/computer/runs')) { dispatches++; throw new Error('PRIVATE_DISPATCH_CONNECTION_LOST') }
    if (path.startsWith('/api/factory/tasks?')) return { issueId: id(13), tasks: [] }
    return originalJson(path, init)
  }
  f.client.rpc = async (action, args) => {
    if (action === 'issues.saveIssue') return { issue: { id: id(13) } }
    if (action === 'agents.pollIssueThreads') return { threads: [] }
    return originalRpc(action, args)
  }
  const report = await runThreadLifecycle(readOptions(env), { env, createClient: () => f.client, now, readSource: async () => SOURCE_FILE,
    WebSocketImpl: class {} })
  assert.equal(dispatches, 1)
  assert.equal(report.cases[0].dispatchAttempted, true)
  assert.equal(report.cases[0].runId, undefined)
  assert.equal(report.cases[0].cleanup.status, 'failed')
  assert.deepEqual(report.cases[0].cleanup.errors, [{ step: 'dispatch_reconciliation', code: 'lifecycle_cleanup_dispatch_unconfirmed' }])
  assert.equal(report.cases[1].error, 'lifecycle_previous_cleanup_unconfirmed')
  assert.equal(f.calls.filter(call => call.action === 'bots.createBot').length, 1)
  assert.equal(f.profiles.length, 1)
  assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 1)
  assert.equal(report.cleanup.workspaceRestored, true)
  assert.equal(report.status, 'failed')
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_DISPATCH_CONNECTION_LOST/)
})

test('lost Profile create response is recovered by its exact request ID and archived before the other leg', async () => {
  const f = mainClient({ loseFirstProfileResponse: true }), legs = []
  const report = await runThreadLifecycle(readOptions(env), { env, createClient: () => f.client, now, readSource: async () => SOURCE_FILE,
    WebSocketImpl: class {}, runCase: async input => {
      legs.push(input.harness)
      assert.ok(f.calls.some(call => call.path === `/api/factory/agent-profiles/${f.profiles[0].id}` && call.method === 'DELETE'))
      return { harness: input.harness, status: 'partial', cleanup: { status: 'passed', errors: [] } }
    } })
  assert.deepEqual(legs, ['codex'])
  assert.equal(report.cases[0].status, 'blocked'); assert.equal(report.cases[0].cleanup.status, 'passed')
  assert.equal(report.cases[0].profileId, f.profiles[0].id)
  assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 2)
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_LOST_CREATE_RESPONSE/)
})

function cleanupClient({ endFails = false } = {}) {
  const calls = []
  return { calls, client: {
    json: async (path, init) => {
      calls.push({ path, body: init?.body })
      if (path.startsWith('/api/factory/tasks?')) return { issueId: id(13), tasks: [{ id: id(14), issueId: id(13) }] }
      if (path === `/api/factory/tasks/${id(14)}`) return init ? {} : { task: { id: id(14), issueId: id(13), status: 'waiting', revision: 3 }, attempts: [{ runId: id(11) }, { runId: id(12) }] }
      if (path.endsWith('/machine')) { if (endFails) throw new Error('PRIVATE_END_ERROR'); return { runId: path.split('/')[3], state: 'ended' } }
      assert.fail(path)
    },
    rpc: async (action, args) => {
      calls.push({ action, args })
      if (action === 'agents.pollIssueThreads') return { threads: [{ id: id(11), ownedByCurrentUser: true }] }
      if (action === 'agents.getIssueThread') return { thread: { id: args[1], status: 'stopped' } }
      if (action === 'agents.getThreadMachine') return { kind: 'cloud', state: 'ended' }
      assert.fail(action)
    },
  } }
}

test('normal cleanup ends only owned case runs and retains task/audit history without deleting the issue', async () => {
  const record = fixture(), f = cleanupClient()
  await cleanupLifecycleCase(f.client, record, { now, scope, observeProvider: async () => ({ status: 'blocked', reason: 'account_mapping_unproven_404' }) })
  assert.equal(record.cleanup.status, 'passed')
  assert.equal(record.cleanup.history, 'retained')
  assert.deepEqual(record.cleanup.runIds.sort(), [id(11), id(12)].sort())
  assert.ok(!f.calls.some(call => /delete|setIssueDeleted|saveE2BKey/.test(call.action ?? call.path)))
  assert.equal(f.calls.filter(call => call.path?.endsWith('/machine')).length, 2)
  assert.equal(record.cleanup.provider.status, 'blocked')
})

test('lost dispatch can be reconciled by discovered owned runs with exact end receipts', async () => {
  const record = { issueId: id(13), dispatchAttempted: true }, f = cleanupClient()
  await cleanupLifecycleCase(f.client, record, { now, scope })
  assert.equal(record.cleanup.status, 'passed')
  assert.deepEqual(record.cleanup.machineReceipts.map(item => item.runId).sort(), [id(11), id(12)].sort())
  assert.ok(record.cleanup.machineReceipts.every(item => item.state === 'ended'))
})

test('cleanup fails explicitly when normal end fails and still attempts every known run', async () => {
  const record = fixture(), f = cleanupClient({ endFails: true })
  await cleanupLifecycleCase(f.client, record, { now, scope })
  assert.equal(record.cleanup.status, 'failed')
  assert.equal(record.cleanup.errors.filter(item => item.step === 'machine_end').length, 2)
  assert.doesNotMatch(JSON.stringify(record.cleanup), /PRIVATE_END_ERROR/)
})

test('a positively owned VM still present after end is a cleanup failure', async () => {
  const record = fixture(), f = cleanupClient()
  await cleanupLifecycleCase(f.client, record, { now, scope, observeProvider: async () => ({ status: 'observed', ownershipVerified: true, state: 'paused' }) })
  assert.equal(record.cleanup.status, 'failed')
  assert.ok(record.cleanup.errors.some(item => item.code === 'lifecycle_cleanup_provider_still_present'))
})

test('normal per-run kill receipts remain cleanup proof when independent static confirmation is blocked', async () => {
  const record = fixture(), f = cleanupClient()
  await cleanupLifecycleCase(f.client, record, { now, scope, observeProvider: async () => ({ status: 'blocked', ownershipVerified: true, reason: 'provider_observation_unavailable' }) })
  assert.equal(record.cleanup.status, 'passed')
  assert.equal(record.cleanup.machineReceipts.length, 2)
  assert.equal(record.cleanup.provider.status, 'blocked')
})

test('each normal end requires its own exact closed receipt even if the last database projection says ended', async () => {
  const record = fixture(), f = cleanupClient(), original = f.client.json
  f.client.json = (path, init) => path.endsWith('/machine') ? { state: 'ended', runId: id(999) } : original(path, init)
  await cleanupLifecycleCase(f.client, record, { now, scope })
  assert.equal(record.cleanup.status, 'failed')
  assert.equal(record.cleanup.errors.filter(item => item.code === 'lifecycle_cleanup_end_receipt_invalid').length, 2)
})

test('live observation accepts Factory push hooks, has no repeated business read without events, and aborts', async () => {
  const sockets = [], controller = new AbortController(), record = { issueId: id(13), runId: id(11) }
  let reads = 0, observed = false
  class Socket {
    constructor() { sockets.push(this); queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: 'live_ready', kinds: ['thread', 'run', 'factory_task'] }) })) }
    close() { this.closed = true }
  }
  const client = { rpc: async () => { reads++; return { live: { runs: [{ id: id(11), workspaceId }] } } },
    json: async () => ({ url: 'wss://live.example.invalid', protocol: 'PRIVATE_TICKET', expiresAt: epoch + 60000 }) }
  const result = watchRun(client, record, 1000, Socket, now, undefined, { signal: controller.signal, allowTerminal: true,
    matches: event => event.kind === 'factory_task' && event.id === id(14), observe: async () => observed })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(reads, 2, 'initial read and live_ready catch-up only')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(reads, 2)
  observed = true
  sockets[0].onmessage({ data: JSON.stringify({ kind: 'factory_task', id: id(14) }) })
  await result
  assert.equal(reads, 3); assert.equal(sockets[0].closed, true)
  const second = watchRun(client, record, 1000, Socket, now, undefined, { signal: controller.signal, allowTerminal: true, observe: async () => false })
  controller.abort()
  await assert.rejects(second, /observation_aborted/)
})

test('live deadline final read is serialized behind the in-flight async observer', async () => {
  let release, reads = 0, observers = 0, maximum = 0
  const pending = new Promise(resolve => { release = resolve })
  const client = { rpc: async () => { reads++; return { live: { runs: [{ id: id(11), workspaceId }] } } },
    json: async () => ({ url: 'wss://live.example.invalid', protocol: 'test', expiresAt: epoch + 60000 }) }
  class Socket { close() {} }
  const result = watchRun(client, { issueId: id(13), runId: id(11) }, 10, Socket, now, undefined, { allowTerminal: true,
    observe: async () => { observers++; maximum = Math.max(maximum, observers); if (reads === 1) await pending; observers--; return false } })
  const rejected = assert.rejects(result, /execution_timeout/)
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(reads, 1)
  release()
  await rejected
  assert.equal(reads, 2); assert.equal(maximum, 1)
})

function lifecycleClient({ providerBlocked = false, changedSession = false, driftAtAnswer = false, missRunningSample = false,
  finishedAt = { origin: new Date(epoch + 20).toISOString(), continuation: new Date(epoch + 40).toISOString() } } = {}) {
  const fixed = fixture(), actions = [], observations = []
  let phase = 'origin', machineState = 'running', answered = false, cancelled = false, pinCalls = 0
  const question = final => ({ id: final ? id(22) : id(21), issueId: fixed.issueId, taskId: fixed.taskId, kind: 'decision',
    originRunId: final ? fixed.continuationRunId : fixed.runId, originSessionId: 'PRIVATE_NATIVE_SID',
    question: `${fixed.caseId} ${final ? 'FINAL_REVIEW_READY' : 'Choose provider receipts or stale epoch review?'}`,
    status: !final && answered ? 'resolved' : 'open', ...(answered && !final ? { continuationRunId: fixed.continuationRunId } : {}),
    reference: { questionId: final ? id(22) : id(21), questionRevision: 1, binding: { taskId: fixed.taskId, revision: 2 },
      originRunId: final ? fixed.continuationRunId : fixed.runId, originSessionId: 'PRIVATE_NATIVE_SID' } })
  const detail = (runId, terminal = true) => {
    const final = runId === fixed.continuationRunId, record = { ...fixed, runId }
    const chunks = final ? [...proofChunks(record, 'after_answer', true), ...proofChunks(record, 'delivery', true)] : proofChunks(record, 'before_question')
    chunks.push(...nativePair(`${runId}:ask`, 'mcp__mikka__ask_human', { kind: 'decision', question: question(final).question }, final ? [{ type: 'text', text: 'Recorded' }] : 'Recorded', 10))
    return { thread: { id: runId, status: terminal ? 'stopped' : 'running', finishedAt: new Date(epoch + 999).toISOString(),
      attempts: [{ runId: fixed.runId, status: final || terminal ? 'stopped' : 'running', finishedAt: final || terminal ? finishedAt.origin : null },
        ...(final ? [{ runId: fixed.continuationRunId, status: terminal ? 'stopped' : 'running', finishedAt: terminal ? finishedAt.continuation : null }] : [])] }, chunks,
      live: { runs: [{ id: runId, workspaceId }] } }
  }
  const frozenEvidence = runId => ({ run: { id: runId, issueId: fixed.issueId, harness: 'claude_code', model: MODELS.claude_code,
    credentialType: 'subscription', subscriptionRoute: 'claude_code_cli', agentProfile: { profileId: profile.id, version: 1, digest: DIGEST, source: 'explicit' },
    executionIdentity: { version: 1, requester: OWNER, executionPrincipal: OWNER, botId, botOwner: OWNER, outputOwner: OWNER, workspaceId,
      personalResourcePolicy: 'requester_only', billingAccount: { model: { kind: 'subscription', ownerId: ADMIN, resourceId: id(61) }, runtime: { kind: 'e2b', ownerId: OWNER, resourceId: OWNER } },
      resourceBindings: [{ kind: 'device', id: id(60), ownerId: OWNER, access: 'owner' }, { kind: 'subscription', id: id(61), ownerId: ADMIN, access: 'workspace_share', revision: '1' }] } } })
  const client = {
    rpc: async (action, args) => {
      actions.push({ action, args })
      if (action === 'issues.saveIssue') return { issue: { id: fixed.issueId } }
      if (action === 'agents.getThreadMachine') return { kind: 'cloud', state: machineState, cloud: { sandboxId: fixed.sandboxId } }
      if (action === 'agents.getIssueThread') return detail(args[1])
      if (action === 'agents.pollIssueThreads') return { threads: [{ id: fixed.runId, ownedByCurrentUser: true }] }
      if (action === 'agents.getThreadChanges') return { state: 'ready', changes: { additions: 10, deletions: 0,
        files: [`issue-1593-${fixed.caseId}.marker`, `issue-1593-${fixed.caseId}.md`].map(path => ({ path, binary: false, previousPath: null, additions: 5 })) } }
      if (action === 'coordinator.stopCoordinatorTurn') return { stopped: true }
      assert.fail(action)
    },
    json: async (path, init) => {
      actions.push({ path, body: init?.body })
      if (path === `/api/bots/${botId}/computer/runs`) {
        const body = JSON.parse(init.body)
        assert.equal(body.profileId, profile.id); assert.equal(body.harness, 'claude_code'); assert.equal(body.needsSpec, false)
        return { thread: 'new', runId: fixed.runId }
      }
      if (path.match(/^\/api\/runs\/.*\/evidence$/)) return frozenEvidence(path.split('/')[3])
      if (path.startsWith('/api/factory/tasks?')) return { issueId: fixed.issueId, liveWorkspaceId: workspaceId, tasks: [{ id: fixed.taskId, issueId: fixed.issueId }] }
      if (path === `/api/factory/tasks/${fixed.taskId}`) {
        if (init) cancelled = true
        return { task: { id: fixed.taskId, issueId: fixed.issueId, status: cancelled ? 'cancelled' : 'waiting', revision: 2 },
          liveWorkspaceId: workspaceId, attempts: [{ runId: fixed.runId, sessionId: 'PRIVATE_NATIVE_SID' }, ...(answered ? [{
            runId: fixed.continuationRunId, sessionId: changedSession ? 'PRIVATE_DIFFERENT_SID' : 'PRIVATE_NATIVE_SID' }] : [])] }
      }
      if (path.startsWith('/api/factory/questions?')) {
        const q = question(path.endsWith(fixed.continuationRunId))
        return { questions: [{ questionId: q.id, type: 'decision', question: q.question }] }
      }
      if (path === `/api/factory/questions/${id(21)}`) {
        if (init) {
          const body = JSON.parse(init.body)
          assert.deepEqual(body.reference, question(false).reference)
          assert.match(body.text, /owner_choice=provider-receipts/)
          answered = true; phase = 'continuation'; machineState = 'running'
        }
        return question(false)
      }
      if (path === `/api/factory/questions/${id(22)}`) { assert.equal(init, undefined, 'the final authorization question is never answered'); return question(true) }
      if (path.endsWith('/machine') && init) { machineState = 'ended'; return { runId: path.split('/')[3], state: 'ended' } }
      assert.fail(path)
    },
  }
  const observeProvider = createProviderObserver({ now, apiKey: 'PRIVATE_PROVIDER_KEY', getInfo: async () => {
    observations.push({ phase, state: machineState })
    if (providerBlocked || machineState === 'ended') throw { status: 404 }
    return { sandboxId: fixed.sandboxId, state: machineState, metadata: { application: 'mikka-thread', workspaceId, runId: fixed.runId, operationId: id(25) } }
  } })
  return { fixed, client, actions, observations, observeProvider,
    pin: async () => { pinCalls++; if (driftAtAnswer && pinCalls === 3) throw new Error('lifecycle_production_source_mismatch') },
    wait: async (_client, record, _timeout, _ws, _now, _cleanup, hooks) => {
      const control = { watchRun: () => {}, watchScope: () => {}, checkActive: () => {} }
      if (missRunningSample && record.runId === fixed.continuationRunId) {
        machineState = 'paused'
        assert.equal(await hooks.observe(detail(record.runId), control), true)
        return
      }
      assert.equal(await hooks.observe(detail(record.runId, false), control), false)
      // Native termination is observable before the provider pause. This must
      // not cache a running provider snapshot as the pause receipt.
      assert.equal(await hooks.observe(detail(record.runId), control), false)
      machineState = 'paused'
      assert.equal(await hooks.observe(detail(record.runId), control), true)
    } }
}

async function runFixture(f) {
  return runLifecycleCase({ client: f.client, botId, profile, scope, harness: 'claude_code', sourceCommit: SOURCE, source: SOURCE_FILE,
    caseId: f.fixed.caseId, markerValue: f.fixed.markerValue, now, pin: f.pin, wait: f.wait, observeProvider: f.observeProvider, signal: f.signal })
}


test('generated task separates report writes from each exact native snapshot tool call', async () => {
  const f = lifecycleClient()
  await runFixture(f)
  const request = f.actions.find(item => item.action === 'issues.saveIssue')
  const taskText = request.args[0].content.content[0].content[0].text
  assert.match(taskText, /三段验证脚本.*各自.*独占一次.*原生 shell 工具调用/)
  assert.match(taskText, /command 只能是.*脚本全文/)
  assert.match(taskText, /报告创建\/修改必须使用另外的工具调用/)
  assert.match(taskText, /不得把 cat\/heredoc.*前后命令.*拼进同一次调用/)
  const scripts = [...taskText.matchAll(/python3 - <<'MIKKA_1593_PY'\n[\s\S]*?\nMIKKA_1593_PY/g)]
    .map(match => match[0])
  assert.deepEqual(scripts, ['before_question', 'after_answer', 'delivery']
    .map(phase => nativeSnapshotCommand(f.fixed, phase)))
})

test('normal double decision passes its declared scope while overall issue acceptance remains incomplete', async () => {
  const f = lifecycleClient(), report = await runFixture(f)
  assert.equal(report.status, 'passed', report.error)
  assert.equal(report.issueAcceptance, 'incomplete')
  assert.equal(report.session.status, 'proved')
  assert.equal(report.session.originSessionHash, report.session.actualContinuationSessionHash)
  assert.equal(report.before.markerSha256, report.after.markerSha256)
  assert.equal(report.provider.before_answer.state, 'paused')
  assert.equal(report.provider.after_delivery.state, 'paused')
  assert.equal(report.provider.resumed_running.state, 'running')
  assert.equal(report.cleanup.provider.state, 'missing')
  assert.equal(report.cleanup.status, 'passed')
  assert.equal(report.checkpoint.scope, 'latest_chain_checkpoint_not_independently_run_bound')
  assert.equal(report.delivery.finalSubmission, 'blocked_unpinned_next_stage_profile')
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_|markerValue|reportText/)
  assert.ok(!f.actions.some(item => item.action?.includes('setIssueDeleted')))
})

test('terminal timestamps come from the exact read attempt and missing timestamps do not add a pass gate', async () => {
  const report = await runFixture(lifecycleClient())
  assert.equal(report.status, 'passed')
  assert.equal(report.terminal.origin.runId, id(11))
  assert.equal(report.terminal.origin.finishedAt, new Date(epoch + 20).toISOString())
  assert.equal(report.terminal.continuation.runId, id(12))
  assert.equal(report.terminal.continuation.finishedAt, new Date(epoch + 40).toISOString())
  assert.equal(report.terminal.continuation.source, 'normal_owner_thread_attempt')
  assert.equal(report.terminal.continuation.status, 'stopped')
  const absent = await runFixture(lifecycleClient({ finishedAt: { origin: null, continuation: 'PRIVATE_NOT_A_TIMESTAMP' } }))
  assert.equal(absent.status, 'passed')
  assert.equal(absent.terminal.origin.finishedAt, null)
  assert.equal(absent.terminal.continuation.finishedAt, null)
  assert.doesNotMatch(JSON.stringify(absent), /PRIVATE_NOT_A_TIMESTAMP/)
})

test('unmatched observer account preserves genuine native/Owner evidence but never invents provider pause or deletion', async () => {
  const report = await runFixture(lifecycleClient({ providerBlocked: true }))
  assert.equal(report.status, 'partial', report.error)
  assert.equal(report.session.status, 'proved')
  assert.equal(report.provider.before_answer.status, 'blocked')
  assert.equal(report.dimensions.providerPause, 'blocked')
  assert.equal(report.dimensions.originalVm, 'blocked')
  assert.equal(report.dimensions.ownerVmMapping, 'same_id_observed')
  assert.equal(report.cleanup.provider.status, 'blocked')
  assert.equal(report.cleanup.provider.state, undefined)
})

test('a short real continuation needs no polling to catch running when both provider pauses and actual same-VM execution are proved', async () => {
  const report = await runFixture(lifecycleClient({ missRunningSample: true }))
  assert.equal(report.status, 'passed', report.error)
  assert.equal(report.resume.source, 'native_execution_same_vm')
  assert.equal(report.resume.runningObservation, 'unobserved')
  assert.equal(report.provider.resumed_running, undefined)
  assert.equal(report.resume.status, 'proved')
  assert.equal(report.session.status, 'proved')
  assert.equal(report.issueAcceptance, 'incomplete')
})

test('a claimed requested resume does not pass when the actual completed attempt SID differs', async () => {
  const report = await runFixture(lifecycleClient({ changedSession: true }))
  assert.equal(report.status, 'failed')
  assert.equal(report.error, 'lifecycle_native_session_changed')
  assert.equal(report.cleanup.status, 'passed')
})

test('source drift before Owner answer still cancels and ends the original owned case', async () => {
  const f = lifecycleClient({ driftAtAnswer: true }), report = await runFixture(f)
  assert.equal(report.status, 'failed')
  assert.equal(report.error, 'lifecycle_production_source_mismatch')
  assert.equal(report.continuationRunId, undefined)
  assert.equal(report.cleanup.status, 'passed')
  assert.ok(f.actions.some(item => item.path?.endsWith('/machine')))
})

test('abort during an awaited pin prevents a new dispatch or answer while cleanup remains available', async () => {
  for (const atPin of [2, 3]) {
    const f = lifecycleClient(), controller = new AbortController(), originalPin = f.pin
    let pins = 0
    f.signal = controller.signal
    f.pin = async () => { await originalPin(); if (++pins === atPin) controller.abort() }
    const report = await runFixture(f)
    assert.equal(report.error, 'lifecycle_interrupted')
    assert.equal(report.cleanup.status, 'passed')
    assert.equal(f.actions.filter(item => item.path?.endsWith('/computer/runs')).length, atPin === 2 ? 0 : 1)
    assert.ok(!f.actions.some(item => item.path === `/api/factory/questions/${id(21)}` && item.body))
    assert.ok(f.actions.some(item => item.action === 'coordinator.stopCoordinatorTurn'))
  }
  const f = mainClient(), controller = new AbortController(), originalJson = f.client.json
  let versions = 0
  f.client.json = async (path, init) => {
    const value = await originalJson(path, init)
    if (path === '/api/version' && ++versions === 2) controller.abort()
    return value
  }
  const report = await runThreadLifecycle(readOptions(env), { env, signal: controller.signal, createClient: () => f.client,
    now, readSource: async () => SOURCE_FILE, WebSocketImpl: class {}, runCase: async () => assert.fail('must not allocate') })
  assert.ok(!f.calls.some(call => call.action === 'bots.createBot'))
  assert.equal(report.cases[0].error, 'lifecycle_interrupted')
  assert.equal(report.cleanup.workspaceRestored, true)
  assert.ok(f.calls.some(call => call.path === '/api/auth/sign-out'))
})
