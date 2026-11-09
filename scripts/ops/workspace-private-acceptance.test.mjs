import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertOpsContext } from './self-hosted-ingress-probe.mjs'
import { P0, FINALIZE_DIAGNOSTIC, assertDependencies, assertSourceIdentity, assertWorkerIdentity, diagnoseExistingBuild,
  collectorFailure, readAcceptanceInputs, summarizeAcceptance, summarizeCollectedAcceptance } from './workspace-private-acceptance.mjs'

const context = { opsSource: 'a'.repeat(40), workerSha: P0.workerSha, runId: '123', runAttempt: '2' }
const identity = { sourceCommit: P0.source, workerSha: context.workerSha, workflowCommit: context.opsSource,
  runId: context.runId, runAttempt: context.runAttempt }
const fixture = '00000000-0000-4000-8000-000000000001'
const digest = { entries: 123, sha256: 'c'.repeat(64) }
const kinds = ['claude', 'codex']
const guard = { ok: true, version: 1, sourceSha256: P0.files['packages/daemon/scripts/workspace-ingress.py'],
  bootId: fixture, installedTicks: 100, workerPid: 321, workerStartTicks: 101, providerPorts: [49983],
  preparedBeforeWorker: true, workerStartedAfterGuard: true, rulesVerified: { ipv4: true, ipv6: true } }

function fixtureReceipts() {
  const templates = Object.fromEntries(kinds.map(kind => [kind, { name: `mikka-preview-${P0.source.slice(0, 12)}-123-2-${kind}`,
    templateId: `owned-${kind}`, buildId: `build-${kind}`, baseTemplate: kind, preinstalled: true, privateVerified: true,
    conservation: { before: digest, after: digest } }]))
  const journals = Object.fromEntries(kinds.map(kind => [kind, { version: 1, purpose: 'mikka-workspace-ingress-acceptance',
    sourceCommit: P0.source, workerSha: context.workerSha, opsSource: context.opsSource, runId: '123', runAttempt: '2',
    kind, fixtureId: fixture, templateId: templates[kind].templateId, creationRequested: true, sandboxId: `sandbox-${kind}` }]))
  const frameworks = ['next', 'vite'].map(framework => ({ framework, rawDenied: true, authenticatedHttp: true, assets: true,
    hotReload: true, crossSiteBootstrap: true, revoked: true, takeoverDenied: true, unauthenticatedStatus: 401, replayStatus: 403,
    hmrEvent: framework === 'next' ? 'built' : 'update', websocket: { closed: true, closeCode: 1001, messages: 3, bytes: 200 } }))
  return { buildReport: { identity, status: 'passed', stage: 'complete' }, candidates: { sourceCommit: P0.source, workerSha: context.workerSha, templates },
    builderJournal: { version: 1, identity, templates: Object.fromEntries(kinds.map(kind => [kind, { kind,
      ...templates[kind], creationStarted: true, collision: false }])), sandboxes: [], pendingSandbox: null },
    journals, runtime: Object.fromEntries(kinds.map(kind => [kind, { version: 1, sourceCommit: P0.source, workerSha: context.workerSha,
      kind, templateId: templates[kind].templateId, fixtureId: fixture, sandboxId: journals[kind].sandboxId,
      productionTaskAuthorityTested: false, subscriptionsTested: false, agentRootIsolationProven: false,
      frameworkVersions: { next: '16.4.1', vite: '8.3.6', react: '19.3.1', 'react-dom': '19.3.1' },
      frameworkLockSha256: P0.files['scripts/e2b/fixtures/preview-frameworks/package-lock.json'],
      stage: 'completed', passed: true, guard, resumedGuard: guard, frameworks, previewStopped: true, terminal: { passed: true } }])),
    vmCleanup: { version: 1, sourceCommit: P0.source, opsSource: context.opsSource,
      cleanup: kinds.map(kind => ({ kind, stopped: true, absent: true, scopeVerified: true, killAcknowledged: true,
        outcome: 'provider_kill_acknowledged_and_absent' })) },
    templateCleanups: [{ identity, confirmed: true, errors: [], sandboxes: [],
      templates: kinds.map(kind => ({ kind, name: templates[kind].name, templateId: templates[kind].templateId, status: 'deleted' })) }],
    outcomes: { build: 'success', acceptance: 'success', vmCleanup: 'success', templateCleanup: 'success' } }
}

async function onDiskReceipts(t, input = fixtureReceipts()) {
  const base = await mkdtemp(join(tmpdir(), 'workspace-receipt-read-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  await mkdir(join(base, 'candidates')); await mkdir(join(base, 'runtime'))
  const save = (name, value) => writeFile(join(base, name), JSON.stringify(value, null, 2) + '\n')
  await save('candidates/build-report.json', input.buildReport)
  await save('candidates/candidates.json', input.candidates)
  await save('candidates/creation-journal.json', input.builderJournal)
  await save('runtime/cleanup.json', input.vmCleanup)
  for (const [index, row] of input.templateCleanups.entries())
    await save(`candidates/cleanup${index ? `-${index + 1}` : ''}.json`, row)
  for (const kind of kinds) {
    await save(`runtime/${kind}.json`, input.runtime[kind])
    await save(`runtime/${kind}.cleanup.json`, input.journals[kind])
  }
  return { base, input, save }
}

test('a complete candidates receipt above the old cap is read while its unretained content stays private', async t => {
  const input = fixtureReceipts(), privateText = 'synthetic-model-receipt-not-for-artifact'
  // Actual builders carry two templates with preload/fresh changes and model
  // slots. Exercise the real file boundary independently of the small fixtures.
  input.candidates.templates.claude.models = [{ models: Array.from({ length: 500 }, (_, i) => `model-${i}`),
    modelSlots: Array.from({ length: 500 }, (_, i) => ({ slot: `model-${i}`, model: 'm'.repeat(128), name: 'n'.repeat(200) })) }]
  input.candidates.templates.codex.models = structuredClone(input.candidates.templates.claude.models)
  input.candidates.unretained = privateText
  const { base } = await onDiskReceipts(t, input)
  const bytes = (await readFile(join(base, 'candidates/candidates.json'))).length
  assert(bytes > 262_144 && bytes < 4 * 1024 * 1024)
  const loaded = await readAcceptanceInputs(base, input.outcomes)
  assert.deepEqual(loaded.input.candidates, input.candidates)
  const report = loaded.reports.find(row => row.role === 'candidates')
  assert.deepEqual(report, { role: 'candidates', type: 'file', bytes, limit: 4 * 1024 * 1024, code: 'ok' })
  const result = summarizeCollectedAcceptance(context, loaded)
  assert.equal(result.verdict.passed, true)
  assert.equal(result.verdict.collection.code, 'ok')
  assert.deepEqual(result.unavailableReceipts, [])
  assert.match(result.receipts.candidates, /^[0-9a-f]{64}$/)
  assert.equal(JSON.stringify(result).includes(privateText), false)
  assert.equal(JSON.stringify(result).includes('modelSlots'), false)
})

test('an over-4-MiB candidates file fails closed without erasing independent runtime and cleanup observations', async t => {
  const input = fixtureReceipts(), privateText = 'synthetic-private-report-data'
  input.runtime.claude.stage = 'initial_ingress'; input.runtime.claude.passed = false; input.runtime.claude.failure = 'positive_control'
  input.outcomes.acceptance = 'failure'
  const { base, save } = await onDiskReceipts(t, input)
  await save('candidates/candidates.json', { ...input.candidates, unretained: privateText + 'x'.repeat(4 * 1024 * 1024) })
  const loaded = await readAcceptanceInputs(base, input.outcomes)
  const read = loaded.reports.find(row => row.role === 'candidates')
  assert.equal(read.type, 'file'); assert.equal(read.code, 'too_large'); assert(read.bytes > read.limit)
  assert.equal(loaded.input.candidates, null)
  const result = summarizeCollectedAcceptance(context, loaded)
  assert.equal(result.verdict.passed, false)
  assert.equal(result.verdict.collection.stage, 'report_read')
  assert.equal(result.verdict.collection.code, 'receipt_unavailable')
  assert.equal(result.verdict.cases[0].stage, 'initial_ingress')
  assert.equal(result.verdict.cases[0].failure, 'positive_control')
  assert.equal(result.verdict.cases[0].identityMatched, false)
  assert.equal(result.verdict.cases[0].runtimePassed, false)
  assert.equal(result.verdict.runtimeCleanup[0].outcome, 'provider_kill_acknowledged_and_absent')
  assert.equal(result.verdict.templateCleanupConfirmed, true)
  assert.equal(result.receipts.candidates, null)
  assert.deepEqual(result.unavailableReceipts, ['candidates'])
  assert.match(result.receipts.runtime, /^[0-9a-f]{64}$/)
  assert.equal(JSON.stringify(result).includes(privateText), false)
  assert.equal(JSON.stringify(result).includes(base), false)
})

test('the larger candidates allowance does not increase any runtime, journal or cleanup report limit', async t => {
  const { base, input, save } = await onDiskReceipts(t)
  await save('runtime/cleanup.json', { ...input.vmCleanup, unretained: 'x'.repeat(262_144) })
  const loaded = await readAcceptanceInputs(base, input.outcomes)
  const refused = loaded.reports.find(row => row.role === 'vmCleanup')
  assert.equal(refused.code, 'too_large'); assert.equal(refused.limit, 262_144)
  assert(loaded.reports.filter(row => row.role !== 'candidates').every(row => row.limit === 262_144))
  const result = summarizeCollectedAcceptance(context, loaded)
  assert.equal(result.verdict.passed, false)
  assert.equal(result.verdict.build.passed, true)
  assert.equal(result.verdict.cases[0].runtimePassed, true)
  assert.equal(result.verdict.runtimeCleanupConfirmed, false)
  assert.deepEqual(result.unavailableReceipts, ['vmCleanup'])
})

test('malformed, non-regular and missing fixed reports retain only closed file observations', async t => {
  for (const [kind, code] of [['invalid_json', 'invalid_json'], ['directory', 'not_regular'], ['symlink', 'not_regular'], ['missing', 'missing']]) {
    const { base, input } = await onDiskReceipts(t)
    const path = join(base, 'runtime/claude.json')
    await rm(path)
    if (kind === 'invalid_json') await writeFile(path, '{synthetic-secret-parser-message')
    if (kind === 'directory') await mkdir(path)
    if (kind === 'symlink') await symlink(join(base, 'runtime/codex.json'), path)
    const loaded = await readAcceptanceInputs(base, input.outcomes)
    const observed = loaded.reports.find(row => row.role === 'runtime' && row.kind === 'claude')
    assert.equal(observed.code, code)
    assert.equal(observed.type, kind === 'invalid_json' ? 'file' : kind)
    const result = summarizeCollectedAcceptance(context, loaded)
    assert.equal(result.verdict.passed, false)
    assert.equal(result.verdict.cases[1].runtimePassed, true)
    assert.equal(JSON.stringify(result).includes(base), false)
    assert.equal(JSON.stringify(result).includes('synthetic-secret-parser-message'), false)
    assert.equal(JSON.stringify(result).includes('SyntaxError'), false)
  }
})

test('an unexpected projection fault retains closed runtime diagnostics and cannot publish success or exception text', () => {
  const input = fixtureReceipts(), privateText = 'synthetic-private-exception'
  Object.defineProperty(input.runtime.claude, 'version', { get() { throw new Error(privateText) } })
  const result = summarizeCollectedAcceptance(context, { input, reports: [] })
  assert.equal(result.verdict.passed, false)
  assert.equal(result.verdict.collection.stage, 'projection')
  assert.equal(result.verdict.collection.code, 'projection_failed')
  assert.equal(result.verdict.cases[0].stage, 'completed')
  assert.equal(result.verdict.cases[0].identityMatched, false)
  assert.equal(result.verdict.cases[1].runtimePassed, false)
  assert.equal(result.verdict.runtimeCleanup[1].absent, true)
  assert.equal(JSON.stringify(result).includes(privateText), false)
})

test('source/input/projection failures emit only closed codes and source refusal cannot reach report reads', () => {
  assert.deepEqual(collectorFailure(new Error('workspace_source_refused'), 'source'), {
    event: 'workspace_private_ops_refused', stage: 'source', code: 'workspace_source_refused', sourceVerified: false })
  assert.equal(collectorFailure(Object.assign(new Error('private assertion text'), { code: 'ERR_ASSERTION' }), 'source').code, 'ops_identity_refused')
  assert.equal(collectorFailure(new SyntaxError('private parse bytes'), 'input').code, 'json_invalid')
  const privateText = 'synthetic-private-error-path-and-capability'
  for (const stage of ['source', 'input', 'projection', privateText]) {
    const row = collectorFailure(Object.assign(new Error(privateText), { code: privateText, path: privateText }), stage)
    assert.equal(row.code, 'internal')
    assert.equal(JSON.stringify(row).includes(privateText), false)
    assert.equal(row.sourceVerified, stage === 'input' || stage === 'projection')
  }
  const source = readFileSync(new URL('./workspace-private-acceptance.mjs', import.meta.url), 'utf8')
  const main = source.slice(source.indexOf('async function main('))
  assert(main.indexOf('const source = await verifySources(directory)') < main.indexOf("collectorStage = 'input'"))
  assert(main.indexOf("collectorStage = 'input'") < main.indexOf("optionalJson(resolve(evidence, 'source.json'))"))
  assert(main.indexOf('const source = await verifySources(directory)') < main.indexOf('await readAcceptanceInputs('))
})

test('identity diagnostics retain only the three source operations and closed fixed SDK evidence', () => {
  for (const operation of ['get_info', 'source_command', 'source_compare']) {
    const input = fixtureReceipts()
    Object.assign(input.runtime.claude, { stage: 'identity', passed: false, failure: 'internal', identityDiagnostic: {
      operation, truncated: false,
      exceptionChain: [{ type: 'CommandExitError', exitCode: 128, httpStatus: null, connectCode: null },
        { type: 'ConnectError', exitCode: null, httpStatus: 503, connectCode: 14 },
        { type: 'Error', reason: 'process_start_event_missing' },
        { type: 'SandboxError', reason: 'process_result_missing' }],
      stderr: { gitDubiousOwnership: true, gitNotRepository: false, oversized: false },
    } })
    const result = summarizeAcceptance(context, input), diagnostic = result.cases[0].identityDiagnostic
    assert.equal(result.passed, false); assert.equal(result.cases[0].runtimePassed, false)
    assert.equal(result.cases[0].identityMatched, true)
    assert.equal(diagnostic.operation, operation)
    assert.deepEqual(diagnostic.exceptionChain, [
      { type: 'CommandExitError', reason: null, exitCode: 128, httpStatus: null, connectCode: null },
      { type: 'ConnectError', reason: null, exitCode: null, httpStatus: 503, connectCode: 14 },
      { type: 'Error', reason: 'process_start_event_missing', exitCode: null, httpStatus: null, connectCode: null },
      { type: 'SandboxError', reason: 'process_result_missing', exitCode: null, httpStatus: null, connectCode: null },
    ])
    assert.deepEqual(diagnostic.stderr, { gitDubiousOwnership: true, gitNotRepository: false, oversized: false })
  }
})

test('identity diagnostic projection rejects foreign stages, types, numeric fields and arbitrary SDK data', () => {
  const privateText = 'synthetic-private-exception-path-url-header'
  const input = fixtureReceipts()
  Object.assign(input.runtime.claude, { stage: 'identity', passed: false, failure: 'internal', identityDiagnostic: {
    operation: 'source_command', truncated: false, privateText,
    exceptionChain: [{ type: privateText, message: privateText, stderr: privateText, exitCode: 128, connectCode: 14, httpStatus: true },
      { type: 'CommandExitError', exitCode: 256, httpStatus: 600, connectCode: 14, reason: 'process_start_event_missing' },
      { type: 'ConnectError', exitCode: -1, connectCode: 17, httpStatus: 99, message: privateText },
      { type: 'SandboxError', reason: privateText, code: privateText },
      { type: 'TimeoutError', message: privateText }],
    stderr: { gitDubiousOwnership: privateText, gitNotRepository: true, oversized: false, text: privateText },
  } })
  const result = summarizeAcceptance(context, input), diagnostic = result.cases[0].identityDiagnostic
  assert.equal(result.passed, false)
  assert.equal(diagnostic.truncated, true); assert.equal(diagnostic.exceptionChain.length, 4)
  assert.equal(diagnostic.exceptionChain[0].type, 'other')
  for (const row of diagnostic.exceptionChain)
    assert.deepEqual([row.reason, row.exitCode, row.httpStatus, row.connectCode], [null, null, null, null])
  assert.deepEqual(diagnostic.stderr, { gitDubiousOwnership: null, gitNotRepository: true, oversized: false })
  assert.equal(JSON.stringify(result).includes(privateText), false)
  input.runtime.claude.identityDiagnostic.operation = privateText
  assert.equal(summarizeAcceptance(context, input).cases[0].identityDiagnostic, null)
  input.runtime.claude.identityDiagnostic.operation = 'get_info'; input.runtime.claude.stage = 'next'
  assert.equal(summarizeAcceptance(context, input).cases[0].identityDiagnostic, null)
})

test('identity code bounds reject booleans, fractions and strings while keeping actual SDK boundaries', () => {
  for (const [type, field, valid, invalid] of [
    ['CommandExitError', 'exitCode', [-255, 0, 255], [-256, 256, true, '128', 1.5]],
    ['ConnectError', 'connectCode', [1, 16], [0, 17, true, '14', 1.5]],
    ['SandboxError', 'httpStatus', [100, 599], [99, 600, true, '503', 1.5]],
  ]) {
    for (const value of [...valid, ...invalid]) {
      const input = fixtureReceipts()
      Object.assign(input.runtime.claude, { stage: 'identity', passed: false, failure: 'internal', identityDiagnostic: {
        operation: 'source_command', exceptionChain: [{ type, [field]: value }],
      } })
      const result = summarizeAcceptance(context, input)
      assert.equal(result.cases[0].identityDiagnostic.exceptionChain[0][field], valid.includes(value) ? value : null)
      assert.equal(result.passed, false)
    }
  }
})

test('the real original Ops push is required; source checks never impersonate main or another run', () => {
  const branch = 'ops/self-hosted-vault-closeout-20261108'
  const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'alexj11324/Mikka', GITHUB_REF: `refs/heads/${branch}`,
    GITHUB_ACTOR: 'alexj11324', GITHUB_SHA: context.opsSource, GITHUB_RUN_ID: '123', GITHUB_EVENT_NAME: 'push',
    GITHUB_WORKFLOW_REF: `alexj11324/Mikka/.github/workflows/self-hosted-vault-closeout.yml@refs/heads/${branch}` }
  const event = { repository: { id: 1427517699, owner: { id: 183887963 } }, ref: env.GITHUB_REF,
    after: env.GITHUB_SHA, deleted: false, forced: false }
  assertOpsContext(env, event, env.GITHUB_SHA)
  for (const change of [{ GITHUB_REF: 'refs/heads/main' }, { GITHUB_SHA: P0.source },
    { GITHUB_REPOSITORY: 'fork/Mikka' }, { GITHUB_ACTOR: 'another-owner' }, { GITHUB_EVENT_NAME: 'workflow_dispatch' }])
    assert.throws(() => assertOpsContext({ ...env, ...change }, event, env.GITHUB_SHA))
  assert.throws(() => assertOpsContext(env, { ...event, forced: true }, env.GITHUB_SHA))
})

test('both clean checkouts and every pinned entry are checked before the workload credential', () => {
  const value = { source: P0.source, tree: P0.tree, dirty: false, opsDirty: false, files: P0.files }
  assertSourceIdentity(value)
  for (const change of [{ source: 'f'.repeat(40) }, { tree: 'f'.repeat(40) }, { dirty: true }, { opsDirty: true }, { files: {} }])
    assert.throws(() => assertSourceIdentity({ ...value, ...change }))
  for (const file of Object.keys(P0.files))
    assert.throws(() => assertSourceIdentity({ ...value, files: { ...P0.files, [file]: '0'.repeat(64) } }))
  assertDependencies(P0.sdks)
  for (const key of Object.keys(P0.sdks)) assert.throws(() => assertDependencies({ ...P0.sdks, [key]: 'unexpected-version' }))
  assertWorkerIdentity(P0.workerSha)
  for (const workerSha of ['b'.repeat(40), undefined, 'invalid']) {
    assert.throws(() => assertWorkerIdentity(workerSha))
    assert.throws(() => summarizeAcceptance({ ...context, workerSha }, fixtureReceipts()))
  }
})

test('both private candidates, complete runtime receipts and separate cleanup outcomes are needed', () => {
  const result = summarizeAcceptance(context, fixtureReceipts())
  assert.equal(result.passed, true)
  assert.equal(result.runtimeCleanupConfirmed, true)
  assert.equal(result.templateCleanupConfirmed, true)
  assert.equal(result.productionTaskAuthorityTested, false)
  assert.equal(result.subscriptionsTested, false)
  assert.equal(result.agentRootIsolationProven, false)
  assert.equal(result.journals.runtime.claude.sandboxId, 'sandbox-claude')
  assert.equal(result.journals.builder.templates.codex.templateId, 'owned-codex')
  for (const change of [value => { value.runtime.claude.passed = false }, value => { value.runtime.codex.frameworks.pop() },
    value => { value.runtime.claude.guard = { ...guard, preparedBeforeWorker: false } },
    value => { value.runtime.codex.resumedGuard = { ...guard, workerPid: 999 } },
    value => { value.runtime.codex.frameworkVersions.vite = 'different' },
    value => { value.candidates.templates.codex.privateVerified = false },
    value => { value.candidates.templates.codex.conservation.after = { ...digest, entries: 1 } },
    value => { value.buildReport.status = 'failed' }, value => { value.outcomes.acceptance = 'failure' }]) {
    const value = structuredClone(fixtureReceipts()); change(value)
    assert.equal(summarizeAcceptance(context, value).passed, false)
  }
})

test('a report from another source, run, attempt, fixture, template or worker is never reusable', () => {
  for (const change of [{ sourceCommit: 'e'.repeat(40) }, { opsSource: 'e'.repeat(40) }, { workerSha: 'e'.repeat(40) },
    { runId: '124' }, { runAttempt: '3' }, { fixtureId: '00000000-0000-4000-8000-000000000002' },
    { templateId: 'another-template' }, { sandboxId: 'another-sandbox' }]) {
    const value = structuredClone(fixtureReceipts())
    Object.assign(value.journals.claude, change)
    const result = summarizeAcceptance(context, value)
    assert.equal(result.passed, false)
    assert.equal(result.cases[0].runtimePassed, false)
  }
  const wrongBuilder = fixtureReceipts()
  wrongBuilder.buildReport = { ...wrongBuilder.buildReport, identity: { ...identity, workflowCommit: P0.source } }
  assert.equal(summarizeAcceptance(context, wrongBuilder).build.passed, false)
})

test('missing, duplicate, pending, public or unacknowledged cleanup never turns a failure green', () => {
  for (const change of [value => { value.vmCleanup = null }, value => { value.vmCleanup.cleanup.pop() },
    value => { value.vmCleanup.cleanup[1] = value.vmCleanup.cleanup[0] },
    value => { value.vmCleanup.cleanup[0].absent = false }, value => { value.templateCleanups = [] },
    value => { value.templateCleanups[0].templates.pop() },
    value => { value.templateCleanups[0].templates[0].status = 'retained_public' },
    value => { value.builderJournal.pendingSandbox = { kind: 'claude', templateId: 'owned-claude' } },
    value => { value.templateCleanups[0].identity.runAttempt = '9' },
    value => { value.outcomes.templateCleanup = 'failure' }]) {
    const value = structuredClone(fixtureReceipts()); change(value)
    assert.equal(summarizeAcceptance(context, value).passed, false)
  }
  const value = fixtureReceipts()
  value.templateCleanups.unshift({ identity, confirmed: false, errors: [{ stage: 'sandbox_list', code: 'provider_http_error' }], templates: [], sandboxes: [] })
  const recovered = summarizeAcceptance(context, value)
  assert.equal(recovered.templateCleanupConfirmed, true)
  assert.equal(recovered.templateCleanups[0].confirmed, false, 'keep the original failed cleanup receipt')
})

test('explicit preflight refusal with no creation remains failed while recording clean absence', () => {
  const value = fixtureReceipts()
  Object.assign(value, { buildReport: { identity, status: 'failed', stage: 'preflight', code: 'candidate_preflight_failed' },
    candidates: null, builderJournal: null, runtime: {}, journals: {},
    templateCleanups: [{ identity, confirmed: true, templates: [], sandboxes: [], errors: [] }],
    outcomes: { build: 'failure', acceptance: 'skipped', vmCleanup: 'success', templateCleanup: 'success' } })
  value.vmCleanup.cleanup = kinds.map(kind => ({ kind, stopped: true, absent: true, outcome: 'no_creation_journal' }))
  const result = summarizeAcceptance(context, value)
  assert.equal(result.runtimeCleanupConfirmed, true)
  assert.equal(result.templateCleanupConfirmed, true)
  assert.equal(result.passed, false)
  value.buildReport = null
  assert.equal(summarizeAcceptance(context, value).templateCleanupConfirmed, false)
})

test('closed artifacts keep resource journals and counters without copying SDK text, URLs or capabilities', () => {
  const value = fixtureReceipts(), privateText = 'synthetic-private-credential-do-not-retain'
  value.extra = { secret: privateText }
  value.runtime.claude.cookies = privateText
  value.runtime.claude.failure = privateText
  value.runtime.claude.stage = privateText
  value.runtime.codex.terminal = { passed: false, failure: privateText, key: privateText }
  value.builderJournal.privateText = privateText
  value.journals.claude.ticket = privateText
  value.templateCleanups[0].errors.push({ stage: privateText, code: privateText, message: privateText })
  const result = summarizeAcceptance(context, value)
  assert.equal(result.passed, false)
  assert.equal(result.cases[0].failure, 'internal')
  assert.equal(result.cases[0].stage, 'invalid')
  assert.equal(result.journals.runtime.claude.sandboxId, 'sandbox-claude')
  assert.equal(JSON.stringify(result).includes(privateText), false)
})

test('build diagnostics retain bounded type/status/host phase evidence without copying raw SDK data', () => {
  const value = fixtureReceipts(), privateText = 'synthetic-private-sdk-text'
  value.buildReport = { identity, status: 'failed', stage: 'build_claude', code: 'template_build_failed', diagnostic: {
    message: privateText, exceptionChainTruncated: true,
    exceptionChain: [
      { type: 'BuildException', code: 'template_build_failed', exitCode: 1, message: privateText, url: privateText },
      { type: 'HTTPError', code: 'provider_http_error', httpStatus: 503, headers: { Authorization: privateText } },
      ...Array.from({ length: 8 }, () => ({ type: privateText, code: privateText, httpStatus: privateText, exitCode: privateText })),
    ],
    buildLogs: { claude: { entries: 200, ignoredLines: 100, oversizedEntries: 1, truncated: true, raw: privateText,
      events: [{ phase: 'template_created', privateText }, { phase: 'bootstrap', detail: 'source', elapsedMs: 12 },
        { phase: 'ingress', detail: 'tool', message: privateText }, { phase: 'host_failure', detail: 'official_files_changed', path: privateText },
        { phase: 'official_capture', entries: 9, sha256: privateText },
        ...Array.from({ length: 80 }, () => ({ phase: 'bootstrap', detail: privateText, elapsedMs: privateText }))] },
      [privateText]: { events: [] } },
  } }
  const result = summarizeAcceptance(context, value), diagnostic = result.build.diagnostic
  assert.equal(result.passed, false)
  assert.equal(result.build.code, 'template_build_failed')
  assert.equal(diagnostic.exceptionChain.length, 8)
  assert.deepEqual(diagnostic.exceptionChain[0], { type: 'BuildException', code: 'template_build_failed', httpStatus: null, exitCode: 1 })
  assert.equal(diagnostic.exceptionChain[1].httpStatus, 503)
  assert.equal(diagnostic.exceptionChain[2].type, 'other')
  assert.equal(diagnostic.buildLogs.claude.events.length, 64)
  assert.deepEqual(diagnostic.buildLogs.claude.events[1], { phase: 'bootstrap', detail: 'source', elapsedMs: 12 })
  assert.equal(diagnostic.buildLogs.claude.entries, 200)
  assert.equal(diagnostic.buildLogs.claude.truncated, true)
  assert.equal(JSON.stringify(result).includes(privateText), false)
})

test('prebuilt startup and readiness failures survive both evidence paths without claiming runtime success', () => {
  const value = fixtureReceipts(), privateText = 'synthetic-private-prebuilt-command'
  const start = ['entry', 'preconditions_verified', 'guard_prepare', 'guard_prepared',
    'control_install', 'control_installed', 'worker_exec']
  const ready = ['pid_file', 'pid_read', 'pid_alive', 'worker_waiting', 'ingress_ready',
    'bootstrap_absent', 'device_absent', 'viewer_key_absent', 'viewer_unauthorized', 'official_files']
  const expected = [
    ...start.map(detail => ({ phase: 'prebuilt_start', detail })),
    { phase: 'prebuilt_start_failed', detail: 'guard_prepare', exitCode: 1 },
    ...ready.map(detail => ({ phase: 'prebuilt_ready_failed', detail, exitCode: 255 })),
  ]
  value.buildReport = { identity, status: 'failed', stage: 'build_claude', code: 'template_build_failed', diagnostic: {
    buildLogs: { claude: { events: expected.map(event => ({ ...event, raw: privateText, argv: [privateText] })) } },
    statusLookup: { identityMatched: true, status: 'error', debugLogs: {
      events: expected.map(event => ({ ...event, count: 2, message: privateText, path: privateText })),
    } },
  } }
  const result = summarizeAcceptance(context, value)
  assert.equal(result.passed, false)
  assert.equal(result.build.code, 'template_build_failed')
  assert.equal(result.build.stage, 'build_claude')
  assert.deepEqual(result.build.diagnostic.buildLogs.claude.events, expected)
  assert.deepEqual(result.build.diagnostic.statusLookup.debugLogs.events,
    expected.map(event => ({ ...event, count: 2 })))
  assert.equal(result.productionTaskAuthorityTested, false)
  assert.equal(result.subscriptionsTested, false)
  assert.equal(JSON.stringify(result).includes(privateText), false)
})

test('prebuilt evidence rejects foreign phases and invalid failure statuses within the existing event cap', () => {
  const value = fixtureReceipts(), privateText = 'synthetic-private-prebuilt-phase'
  const invalid = [
    { phase: 'prebuilt_start', detail: privateText },
    { phase: 'prebuilt_start', detail: 'pid_file' },
    { phase: 'prebuilt_start_failed', detail: 'pid_file', exitCode: 1 },
    { phase: 'prebuilt_ready_failed', detail: 'worker_exec', exitCode: 1 },
    { phase: 'prebuilt_ready_failed', detail: privateText, exitCode: 1 },
    ...[undefined, null, false, true, 0, -1, 256, 1.5, '1', privateText].map(exitCode =>
      ({ phase: 'prebuilt_ready_failed', detail: 'pid_file', exitCode })),
  ]
  value.buildReport = { identity, status: 'failed', stage: 'build_claude', code: 'template_build_failed', diagnostic: {
    buildLogs: { claude: { events: invalid } },
    statusLookup: { identityMatched: true, status: 'error', debugLogs: {
      events: invalid.map(event => ({ ...event, count: 1 })),
    } },
  } }
  let result = summarizeAcceptance(context, value)
  assert.deepEqual(result.build.diagnostic.buildLogs.claude.events, [])
  assert.deepEqual(result.build.diagnostic.statusLookup.debugLogs.events, [])
  assert.equal(JSON.stringify(result).includes(privateText), false)
  const known = { phase: 'prebuilt_start', detail: 'entry' }
  value.buildReport.diagnostic.buildLogs.claude.events = [
    ...Array.from({ length: 64 }, () => known), { phase: 'prebuilt_start', detail: 'worker_exec' },
  ]
  result = summarizeAcceptance(context, value)
  assert.deepEqual(result.build.diagnostic.buildLogs.claude.events, Array.from({ length: 64 }, () => known))
})

test('conservation rejection keeps closed provider changes without promoting a failed build', () => {
  const value = fixtureReceipts(), secret = 'private-file-target-digest-and-path'
  const conservation = { observedChanges: 2, redactedChanges: 1, truncated: false,
    changes: [{ pathCode: 'provider_shared_directory', kind: 'directory', fields: ['mode'],
      before: { mode: 493 }, after: { mode: 511 }, contentChanged: false, targetChanged: false }] }
  const event = { phase: 'host_failure', detail: 'official_files_changed', conservation }
  value.buildReport = { identity, status: 'failed', stage: 'build_claude', code: 'template_build_failed', diagnostic: {
    buildLogs: { claude: { events: [{ ...event, path: secret, conservation: { ...conservation, raw: secret,
      changes: [{ ...conservation.changes[0], path: secret, target: secret, sha256: secret }] } }] } },
    statusLookup: { identityMatched: true, status: 'error', debugLogs: { events: [{ ...event, count: 35 }] } },
  } }
  const result = summarizeAcceptance(context, value)
  assert.equal(result.passed, false)
  assert.deepEqual(result.build.diagnostic.buildLogs.claude.events, [event])
  assert.deepEqual(result.build.diagnostic.statusLookup.debugLogs.events, [{ ...event, count: 35 }])
  assert.ok(!JSON.stringify(result).includes(secret))
  for (const change of [row => { row.changes[0].pathCode = secret }, row => { row.changes[0].after.mode = true },
    row => { row.changes[0].before.credential = secret }, row => { row.changes[0].fields = [secret] },
    row => { row.changes[0].contentChanged = true }, row => { row.redactedChanges = 3 }, row => { row.truncated = true },
    row => { row.changes[0].after.mode = 4096 }]) {
    const invalid = structuredClone(conservation); change(invalid)
    value.buildReport.diagnostic.buildLogs.claude.events = [{ ...event, conservation: invalid }]
    const failure = summarizeAcceptance(context, value)
    assert.equal(failure.passed, false)
    assert.deepEqual(failure.build.diagnostic.buildLogs.claude.events, [{ phase: event.phase, detail: event.detail }])
    assert.ok(!JSON.stringify(failure).includes(secret))
  }
})

test('ingress command diagnostics retain only known observations without copying private process data', () => {
  const value = fixtureReceipts(), privateText = 'synthetic-private-netfilter-argument'
  const command = { family: 'ipv6', operation: 'provider_rule', failureKind: 'exit', returnCode: 2,
    extension: 'multiport', revision: 1,
    unsupportedExtensions: [{ extension: 'multiport', revision: 1 }],
    unsupportedRevision: false, missingKernelModule: false, missingExtension: true,
    operationNotSupported: false, permissionDenied: false, invalidArgument: false }
  const event = { phase: 'ingress', detail: 'command', command: { ...command,
    stderr: privateText, argv: [privateText], path: privateText } }
  value.buildReport = { identity, status: 'failed', stage: 'build_claude', code: 'template_build_failed',
    diagnostic: { buildLogs: { claude: { events: [event] } } } }
  let result = summarizeAcceptance(context, value)
  assert.equal(result.passed, false)
  assert.deepEqual(result.build.diagnostic.buildLogs.claude.events[0], { phase: 'ingress', detail: 'command', command })
  assert.equal(JSON.stringify(result).includes(privateText), false)
  for (const operation of ['install_policy', 'list_table', 'list_ruleset', 'create_table', 'new_chain',
    'base_chain', 'provider_rule', 'reply_rule', 'output_jump']) {
    const native = { ...command, family: 'inet', operation, extension: 'unknown', revision: null, unsupportedExtensions: [] }
    event.command = { ...native, stderr: privateText }
    result = summarizeAcceptance(context, value)
    assert.deepEqual(result.build.diagnostic.buildLogs.claude.events[0].command, native)
    assert.equal(JSON.stringify(result).includes(privateText), false)
  }
  for (const [failureKind, returnCode] of [['timeout', null], ['output_limit', 0], ['execution', null]]) {
    event.command = { ...command, failureKind, returnCode, stderr: privateText }
    result = summarizeAcceptance(context, value)
    assert.deepEqual(result.build.diagnostic.buildLogs.claude.events[0].command, { ...command, failureKind, returnCode })
    assert.equal(JSON.stringify(result).includes(privateText), false)
  }
  for (const change of [{ family: privateText }, { operation: privateText }, { failureKind: privateText },
    { returnCode: privateText }, { returnCode: true }, { returnCode: 256 }, { returnCode: -256 }, { permissionDenied: privateText }]) {
    event.command = { ...command, ...change }
    result = summarizeAcceptance(context, value)
    assert.deepEqual(result.build.diagnostic.buildLogs.claude.events[0], { phase: 'ingress', detail: 'command' })
    assert.equal(JSON.stringify(result).includes(privateText), false)
  }
  for (const key of Object.keys(command).filter(key => !['extension', 'revision', 'unsupportedExtensions'].includes(key))) {
    event.command = Object.fromEntries(Object.entries(command).filter(([name]) => name !== key))
    result = summarizeAcceptance(context, value)
    assert.deepEqual(result.build.diagnostic.buildLogs.claude.events[0], { phase: 'ingress', detail: 'command' })
  }
  for (const [extension, revision, expectedExtension] of [[privateText, 1, 'unknown'], ['owner', privateText, 'owner'],
    ['owner', true, 'owner'], ['owner', 256, 'owner'], [undefined, undefined, 'unknown']]) {
    event.command = { ...command, extension, revision }
    result = summarizeAcceptance(context, value)
    assert.deepEqual(result.build.diagnostic.buildLogs.claude.events[0].command,
      { ...command, extension: expectedExtension, revision: null })
    assert.equal(JSON.stringify(result).includes(privateText), false)
  }
  event.command = { ...command, unsupportedExtensions: [
    { extension: 'owner', revision: 1, stderr: privateText }, { extension: 'multiport', revision: 1 },
    { extension: 'owner', revision: 1 }, { extension: privateText, revision: 1 },
    { extension: 'mark', revision: privateText }, { extension: 'conntrack', revision: 256 },
    ...Array.from({ length: 20 }, () => ({ extension: 'tcp', revision: 0 })),
  ] }
  result = summarizeAcceptance(context, value)
  assert.deepEqual(result.build.diagnostic.buildLogs.claude.events[0].command.unsupportedExtensions,
    [{ extension: 'conntrack', revision: null }, { extension: 'mark', revision: null },
      { extension: 'multiport', revision: 1 }, { extension: 'owner', revision: 1 }])
  assert.equal(JSON.stringify(result).includes(privateText), false)
})

test('a failed status lookup preserves the original failure and only exact-identity status metadata', () => {
  const value = fixtureReceipts(), privateText = 'private-provider-reason-command'
  value.buildReport = { identity, status: 'failed', stage: 'build_claude', code: 'template_build_failed', diagnostic: {
    exceptionChain: [{ type: 'BuildException', code: 'template_build_failed' }], statusLookup: {
      attempted: true, identityMatched: true, status: 'error', step: { phase: 'bootstrap', index: 9, raw: privateText },
      reason: privateText, exitCode: 2, exitCodeSource: 'provider_reason', reasonLogEntries: 3, reasonLogEntriesTruncated: false,
    },
  } }
  let result = summarizeAcceptance(context, value)
  assert.equal(result.passed, false)
  assert.equal(result.build.diagnostic.statusLookup.status, 'error')
  assert.equal(result.build.diagnostic.statusLookup.exitCode, 2)
  assert.deepEqual(result.build.diagnostic.statusLookup.step, { phase: 'bootstrap', index: 9 })
  value.buildReport.diagnostic.statusLookup = { ...value.buildReport.diagnostic.statusLookup, identityMatched: false,
    failure: { exceptionChain: [{ type: 'HTTPError', code: 'provider_http_error', httpStatus: 503, message: privateText }] } }
  result = summarizeAcceptance(context, value)
  assert.equal(result.build.code, 'template_build_failed')
  assert.equal(result.build.diagnostic.statusLookup.status, null)
  assert.equal(result.build.diagnostic.statusLookup.step.phase, null)
  assert.equal(result.build.diagnostic.statusLookup.failure.exceptionChain[0].httpStatus, 503)
  assert.equal(JSON.stringify(result).includes(privateText), false)
})

test('pre-cleanup debug evidence preserves bounded pages and closed reasons without promoting a build failure', () => {
  const value = fixtureReceipts(), secret = 'private-debug-sdk-url-header-key-and-body'
  const lookup = { attempted: true, identityMatched: true, status: 'error', step: { phase: 'finalize', index: null },
    complete: true, outcome: 'available', requests: 2, pages: 2, entries: 103,
    limits: { pages: 6, entriesPerPage: 100, totalSeconds: 90, requestSeconds: 15, secret },
    categories: ['ready_failed', 'ready_timeout', 'ready_failed', secret], exitCode: 1, exitCodeSource: 'provider_reason',
    reasonLogEntries: 0, reasonLogEntriesTruncated: false, failure: null, secret,
    debugLogs: { entries: 103, ignoredLines: 100, oversizedEntries: 0, truncated: false, secret,
      levels: { debug: 102, info: 1, warn: 0, error: 0, [secret]: 1 },
      signals: { startAnnounced: true, readyAnnounced: true, templateReady: false, readyRejected: 2, secret },
      events: [{ phase: 'ingress', detail: 'worker_order', count: 1, secret },
        { phase: 'host_failure', detail: 'anonymous_worker_unavailable', count: 1, secret },
        { phase: 'ready_rejected', categories: ['ready_timeout', secret], exitCode: null, count: 2, secret }] } }
  value.buildReport = { identity, status: 'failed', stage: 'build_claude', code: 'template_build_failed',
    diagnostic: { exceptionChain: [{ type: 'BuildException', code: 'template_build_failed' }], statusLookup: lookup } }
  let result = summarizeAcceptance(context, value), projected = result.build.diagnostic.statusLookup
  assert.equal(result.passed, false)
  assert.equal(result.build.code, 'template_build_failed')
  assert.equal(projected.complete, true)
  assert.deepEqual([projected.requests, projected.pages, projected.entries], [2, 2, 103])
  assert.deepEqual(projected.categories, ['ready_failed', 'ready_timeout'])
  assert.deepEqual(projected.debugLogs.events, [
    { phase: 'ingress', detail: 'worker_order', count: 1 },
    { phase: 'host_failure', detail: 'anonymous_worker_unavailable', count: 1 },
    { phase: 'ready_rejected', categories: ['ready_timeout'], exitCode: null, count: 2 },
  ])
  assert.equal(projected.debugLogs.signals.readyRejected, 2)
  assert.equal(JSON.stringify(result).includes(secret), false)
  for (const failure of [{ code: 'request_timeout', httpStatus: null }, { code: 'not_found', httpStatus: 400 },
    { code: 'status_changed', httpStatus: null }]) {
    lookup.failure = { ...failure, message: secret, exceptionChain: [{ type: 'ReadTimeout', code: 'operation_timeout', message: secret }] }
    lookup.outcome = 'partial'; lookup.complete = false
    result = summarizeAcceptance(context, value); projected = result.build.diagnostic.statusLookup
    assert.equal(projected.complete, false)
    assert.equal(projected.failure.code, failure.code)
    assert.equal(projected.failure.httpStatus, failure.httpStatus)
    assert.equal(projected.failure.exceptionChain[0].type, 'ReadTimeout')
    assert.equal(JSON.stringify(result).includes(secret), false)
  }
})

test('incomplete or unverified debug metadata cannot claim a complete historical read', () => {
  const value = fixtureReceipts(), secret = 'private-untrusted-debug-result'
  const base = { attempted: true, identityMatched: true, status: 'error', complete: true, outcome: 'available',
    requests: 1, pages: 1, entries: 2, limits: { pages: 6, entriesPerPage: 100, totalSeconds: 90, requestSeconds: 15 },
    failure: null, debugLogs: { events: [{ phase: secret, count: 1 }] } }
  for (const change of [{ identityMatched: false }, { status: 'building' }, { failure: { code: 'not_terminal' } },
    { pages: 7 }, { entries: 601 }, { limits: { ...base.limits, totalSeconds: 91 } }, { outcome: 'partial' }]) {
    value.buildReport = { identity, status: 'failed', stage: 'build_claude', code: 'template_build_failed',
      diagnostic: { statusLookup: { ...base, ...change } } }
    const result = summarizeAcceptance(context, value)
    assert.equal(result.build.diagnostic.statusLookup.complete, false)
    assert.equal(JSON.stringify(result).includes(secret), false)
  }
})

function diagnosticPage(entries = [], reason = null, extra = {}) {
  return { templateID: FINALIZE_DIAGNOSTIC.templateId, buildID: FINALIZE_DIAGNOSTIC.buildId,
    status: 'error', logs: [], logEntries: entries, reason, ...extra }
}
const logEntry = (message, level = 'debug') => ({ timestamp: '2026-11-09T00:31:00Z', level, message, step: 'finalize' })
const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), { status })

test('the diagnostic reads only the frozen build with debug-level finite pages and closed evidence', async () => {
  const privateText = 'synthetic-private-diagnostic-key-and-command'
  const requests = []
  const pages = [diagnosticPage(Array.from({ length: 100 }, () => logEntry(privateText)),
    { step: 'finalize', message: `ready command failed: ready command timed out after 10m0s ${privateText}`, logEntries: [] }),
  diagnosticPage([logEntry('Running start command: ' + privateText, 'info'),
    logEntry('Waiting for template to be ready: ' + privateText, 'info'),
    logEntry('Template is not ready: exit status 1 ' + privateText),
    logEntry('[ready] [stderr]: {"ok":false,"detail":"worker_order"}'),
    logEntry('[start] [stderr]: Cloud worker unavailable', 'info')])]
  const result = await diagnoseExistingBuild(privateText, { fetchImpl: async (url, init) => {
    requests.push({ url, init }); return jsonResponse(pages[requests.length - 1])
  } })
  assert.equal(requests.length, 2)
  for (const [index, request] of requests.entries()) {
    const url = new URL(request.url)
    assert.equal(url.origin, 'https://api.e2b.dev')
    assert.equal(url.pathname, `/templates/${FINALIZE_DIAGNOSTIC.templateId}/builds/${FINALIZE_DIAGNOSTIC.buildId}/status`)
    assert.equal(url.search, `?level=debug&logsOffset=${index * 100}&limit=100`)
    assert.equal(request.init.method, 'GET')
    assert.equal(request.init.redirect, 'error')
    assert.equal(request.init.headers['X-API-Key'], privateText)
    assert.ok(request.init.signal instanceof AbortSignal)
    assert.equal(request.init.body, undefined)
  }
  assert.equal(result.outcome, 'available')
  assert.equal(result.complete, true)
  assert.equal(result.entries, 105)
  assert.equal(result.identityMatched, true)
  assert.deepEqual(result.reason.categories, ['ready_failed', 'ready_timeout'])
  assert.equal(result.signals.startAnnounced, true)
  assert.equal(result.signals.readyAnnounced, true)
  assert.equal(result.signals.readyRejected, 1)
  assert.ok(result.events.some(row => row.kind === 'ingress' && row.detail === 'worker_order'))
  assert.ok(result.events.some(row => row.kind === 'host_failure' && row.detail === 'anonymous_worker_unavailable'))
  assert.equal(result.resourcesCreated, false)
  assert.equal(result.runtimeAcceptance, false)
  assert.equal(JSON.stringify(result).includes(privateText), false)
})

test('deleted or unauthorized exact builds stop immediately and remain unavailable', async () => {
  for (const [httpStatus, body, expected] of [[400, { message: `Build '${FINALIZE_DIAGNOSTIC.buildId}' not found` }, 'not_found'],
    [400, { message: 'another failure' }, 'http_error'], [401, {}, 'unauthorized'], [403, {}, 'forbidden'], [404, {}, 'not_found'], [429, {}, 'http_error']]) {
    let calls = 0
    const result = await diagnoseExistingBuild('synthetic-key', { fetchImpl: async () => { calls++; return jsonResponse(body, httpStatus) } })
    assert.equal(calls, 1)
    assert.equal(result.outcome, 'unavailable')
    assert.equal(result.failure.code, expected)
    assert.equal(result.failure.httpStatus, httpStatus)
    assert.equal(result.identityMatched, false)
    assert.equal(result.complete, false)
    assert.equal(result.reason.phase, null)
  }
})

test('foreign identity and malformed provider data are never treated as target evidence', async () => {
  for (const change of [{ templateID: 'foreign-template' }, { buildID: '00000000-0000-4000-8000-000000000000' },
    { status: 'private-provider-text' }, { logEntries: {} }, { logEntries: Array.from({ length: 101 }, () => logEntry('private-text')) }]) {
    const result = await diagnoseExistingBuild('synthetic-key', { fetchImpl: async () => jsonResponse(diagnosticPage([], null, change)) })
    assert.equal(result.outcome, 'unavailable')
    assert.equal(result.failure.code, 'response_refused')
    assert.equal(result.entries, 0)
    assert.equal(JSON.stringify(result).includes('private-provider-text'), false)
  }
})

test('terminal history never becomes complete from a waiting or building response', async () => {
  for (const status of ['waiting', 'building']) {
    let calls = 0
    const result = await diagnoseExistingBuild('synthetic-key', { fetchImpl: async () => {
      calls++; return jsonResponse(diagnosticPage([], null, { status }))
    } })
    assert.equal(calls, 1)
    assert.equal(result.outcome, 'partial')
    assert.equal(result.complete, false)
    assert.equal(result.identityMatched, true)
    assert.equal(result.status, status)
    assert.equal(result.failure.code, 'not_terminal')
    assert.equal(result.pages, 1)
    assert.equal(result.entries, 0)
  }
})

test('terminal history rejects status changes between pages without consuming the changed page', async () => {
  for (const status of ['ready', 'waiting', 'building']) {
    let calls = 0
    const result = await diagnoseExistingBuild('synthetic-key', { fetchImpl: async () => {
      calls++
      return jsonResponse(calls === 1
        ? diagnosticPage(Array.from({ length: 100 }, () => logEntry('ignored')))
        : diagnosticPage([], null, { status }))
    } })
    assert.equal(calls, 2)
    assert.equal(result.outcome, 'partial')
    assert.equal(result.complete, false)
    assert.equal(result.status, 'error')
    assert.equal(result.failure.code, 'status_changed')
    assert.equal(result.pages, 1)
    assert.equal(result.entries, 100)
  }
})

test('the read-only reader has six-page and total-time ceilings without retrying', async () => {
  let calls = 0
  let result = await diagnoseExistingBuild('synthetic-key', { fetchImpl: async () => {
    calls++; return jsonResponse(diagnosticPage(Array.from({ length: 100 }, () => logEntry('ignored'))))
  } })
  assert.equal(calls, 6)
  assert.equal(result.entries, 600)
  assert.equal(result.complete, false)
  assert.equal(result.outcome, 'partial')
  assert.equal(result.failure.code, 'page_limit')
  assert.deepEqual(result.limits, { pages: 6, entriesPerPage: 100, totalMs: 90_000, requestMs: 15_000 })
  let time = 0
  calls = 0
  result = await diagnoseExistingBuild('synthetic-key', { now: () => time, fetchImpl: async () => {
    calls++; time = 90_001; return jsonResponse(diagnosticPage(Array.from({ length: 100 }, () => logEntry('ignored'))))
  } })
  assert.equal(calls, 1)
  assert.equal(result.failure.code, 'time_limit')
  assert.equal(result.complete, false)
})

test('provider body, error and command text never escape diagnostic failures', async () => {
  const privateText = 'synthetic-private-provider-response'
  for (const fetchImpl of [async () => new Response(privateText),
    async () => { throw new Error(privateText) },
    async () => { throw new DOMException(privateText, 'TimeoutError') },
    async () => new Response(privateText.repeat(40_000))]) {
    const result = await diagnoseExistingBuild('synthetic-key', { fetchImpl })
    assert.equal(result.outcome, 'unavailable')
    assert.equal(JSON.stringify(result).includes(privateText), false)
    assert.equal(result.complete, false)
  }
  let calls = 0
  const result = await diagnoseExistingBuild('', { fetchImpl: async () => { calls++; throw new Error(privateText) } })
  assert.equal(calls, 0)
  assert.equal(result.failure.code, 'credential_missing')
})

test('workflow retains the original sole credential and gives cleanup time outside the production lane', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/self-hosted-vault-closeout.yml', import.meta.url), 'utf8')
  assert.match(workflow, /branches: \[ops\/self-hosted-vault-closeout-20261108\]/)
  assert.match(workflow, /group: coding-workspace-private-candidates/)
  assert.doesNotMatch(workflow, /production-smoke-owner-acceptance|workflow_dispatch:|pull_request:|SMOKE_OWNER|publish-verified|(?:GITHUB_SHA|GITHUB_REF)=/)
  assert.doesNotMatch(workflow, /workspace-private-acceptance\.mjs (?:diagnostic-check|diagnose)\b/)
  assert.doesNotMatch(workflow, /(?:contents|actions): write|secrets: inherit/)
  assert.deepEqual([...workflow.matchAll(/^\s+secret-name: (.+)$/gm)].map(match => match[1]), ['E2B_API_KEY'])
  for (const exact of ['identity-id: 2cf9fa19-b9db-4c08-8ca0-b31859f2cbac', 'oidc-audience: mikka-infisical',
    'project-id: 89850d6a-f020-4936-863e-df77380dfe40', 'secret-path: /vercel', 'env-slug: prod',
    'recursive: false', 'include-imports: false', `P0_SOURCE: ${P0.source}`, `ref: ${P0.source}`]) assert.ok(workflow.includes(exact))
  assert.equal(workflow.split(P0.source).length - 1, 2)
  assert.ok(workflow.indexOf('mjs dependencies workspace-acceptance-source') < workflow.indexOf('uses: Infisical/secrets-action'))
  assert.ok(workflow.indexOf('id: vm_cleanup') < workflow.indexOf('id: template_cleanup'))
  assert.equal([...workflow.matchAll(/if: always\(\) && steps.source.outcome == 'success' && steps.credential.outcome == 'success' && steps.build.outcome != 'skipped'/g)].length, 2)
  assert.match(workflow, /pnpm install --frozen-lockfile/)
  assert.match(workflow, /timeout --signal=TERM --kill-after=1m 30m/)
  assert.match(workflow, /timeout --signal=TERM --kill-after=30s 12m/)
  assert.match(workflow, /path: \$\{\{ runner.temp \}\}\/workspace-private\/evidence\/\*\.json/)
  const timeouts = [...workflow.matchAll(/^\s+timeout-minutes: (\d+)$/gm)].map(match => Number(match[1]))
  assert.equal(timeouts[0], 75)
  assert.ok(timeouts.slice(1).reduce((sum, value) => sum + value, 0) <= 75, 'step ceilings must leave cleanup inside the job limit')
})

function projectConservationFailure(events) {
  const value = fixtureReceipts()
  value.buildReport = { identity, status: 'failed', stage: 'conservation_claude', code: 'operation_failed' }
  value.outcomes.build = 'failure'; value.outcomes.acceptance = 'skipped'
  const baseline = summarizeAcceptance(context, value)
  value.buildReport.diagnostic = {
    buildLogs: { claude: { events } },
    statusLookup: { identityMatched: true, status: 'error', debugLogs: { events: events.map(event => ({ ...event, count: 2 })) } },
  }
  const result = summarizeAcceptance(context, value)
  assert.equal(result.passed, false)
  assert.deepEqual({ ...result, build: { ...result.build, diagnostic: baseline.build.diagnostic } }, baseline,
    'diagnostic projection changes neither the original failed verdict nor any cleanup result')
  return { result, normal: result.build.diagnostic.buildLogs.claude.events,
    debug: result.build.diagnostic.statusLookup.debugLogs.events }
}

test('fresh conservation failures retain every closed stage/code in both evidence paths and keep the failed verdict', () => {
  const stages = ['preload_receipts', 'preload_validation', 'fresh_scan', 'fresh_receipt', 'fresh_validation', 'unknown']
  const details = ['official_manifest_invalid', 'official_conservation_invalid', 'official_conservation_missing',
    'official_files_removed', 'official_files_changed', 'e2b_certificate_target_invalid', 'conservation_failed',
    'conservation_diagnostic_too_large', 'conservation_metadata_invalid', 'conservation_diagnostic_invalid']
  const expected = stages.flatMap(stage => details.map(detail => ({ phase: 'conservation_failed', stage, detail })))
  const privateText = 'synthetic-private-conservation-SDK-path-target-digest'
  const { result, normal, debug } = projectConservationFailure(expected.map(event => ({ ...event,
    raw: privateText, message: privateText, path: privateText, target: privateText, sha256: privateText })))
  assert.equal(expected.length, 60)
  assert.deepEqual(normal, expected)
  assert.deepEqual(debug, expected.map(event => ({ ...event, count: 2 })))
  assert.equal(JSON.stringify(result).includes(privateText), false)
  const known = { phase: 'conservation_failed', stage: 'fresh_scan', detail: 'conservation_failed' }
  const capped = projectConservationFailure(Array.from({ length: 65 }, () => known))
  assert.equal(capped.normal.length, 64); assert.equal(capped.debug.length, 64)
})

test('unknown conservation detail or stage drops only that extension event and preserves known failure evidence', () => {
  const known = { phase: 'conservation_failed', stage: 'unknown', detail: 'conservation_failed' }
  const host = { phase: 'host_failure', detail: 'official_files_changed' }
  const privateText = 'synthetic-private-foreign-conservation-stage'
  const invalid = [undefined, null, true, 1, {}, ['fresh_scan'], privateText]
  const events = [known, host,
    ...invalid.map(stage => ({ ...known, stage })),
    ...invalid.map(detail => ({ ...known, detail })),
    { ...known, stage: 'worker_exec' }, { ...known, detail: 'operation_failed' },
    { ...known, phase: 'synthetic-foreign-phase' },
  ]
  const { result, normal, debug } = projectConservationFailure(events)
  assert.deepEqual(normal, [known, host])
  assert.deepEqual(debug, [known, host].map(event => ({ ...event, count: 2 })))
  assert.equal(JSON.stringify(result).includes(privateText), false)
})

test('conservation optional check/status/path codes are independently closed and integer zero is retained', () => {
  const base = { phase: 'conservation_failed', stage: 'fresh_receipt', detail: 'official_conservation_missing' }
  const checks = ['pid_file', 'pid_read', 'pid_alive', 'worker_waiting', 'official_files']
  const paths = ['provider_shared_directory', 'provider_root_certificate', 'provider_certificate_reference',
    'provider_hashed_certificate_reference', 'redacted']
  const expected = checks.map((check, index) => ({ ...base, check, exitCode: [-255, -1, 0, 1, 255][index], removedPathCode: paths[index] }))
  const projected = projectConservationFailure(expected)
  assert.deepEqual(projected.normal, expected)
  assert.deepEqual(projected.debug, expected.map(event => ({ ...event, count: 2 })))
  for (const field of ['check', 'exitCode', 'removedPathCode']) {
    const invalid = field === 'exitCode' ? [undefined, null, true, false, '1', -256, 256, 1.5, NaN, Infinity]
      : [undefined, null, true, 1, {}, ['official_files'], 'synthetic-private-path-or-check', 'ingress_ready']
    for (const value of invalid) {
      const retained = { ...expected[2] }; delete retained[field]
      const { normal, debug, result } = projectConservationFailure([{ ...expected[2], [field]: value }])
      assert.deepEqual(normal, [retained]); assert.deepEqual(debug, [{ ...retained, count: 2 }])
      assert.equal(JSON.stringify(result).includes('synthetic-private-path-or-check'), false)
    }
  }
})

test('fresh conservation changes reuse the strict existing sanitizer and never retain paths, targets or digests', () => {
  const privateText = 'synthetic-private-fresh-conservation-path-target-sha'
  const conservation = { observedChanges: 2, redactedChanges: 1, truncated: false,
    changes: [{ pathCode: 'provider_shared_directory', kind: 'directory', fields: ['mode'],
      before: { mode: 493 }, after: { mode: 511 }, contentChanged: false, targetChanged: false }] }
  const base = { phase: 'conservation_failed', stage: 'fresh_scan', detail: 'official_files_changed',
    check: 'official_files', exitCode: 1 }
  const expected = { ...base, conservation }
  const projected = projectConservationFailure([{ ...expected, raw: privateText, path: privateText,
    conservation: { ...conservation, raw: privateText, changes: [{ ...conservation.changes[0],
      path: privateText, target: privateText, sha256: privateText }] } }])
  assert.deepEqual(projected.normal, [expected])
  assert.deepEqual(projected.debug, [{ ...expected, count: 2 }])
  assert.equal(JSON.stringify(projected.result).includes(privateText), false)
  for (const mutate of [row => { row.changes[0].pathCode = privateText }, row => { row.changes[0].before.credential = privateText },
    row => { row.changes[0].fields = [privateText] }, row => { row.changes[0].after.mode = true },
    row => { row.changes[0].after.mode = 4096 }, row => { row.observedChanges = true },
    row => { row.redactedChanges = 3 }, row => { row.truncated = true },
    row => { row.changes[0].contentChanged = true }, row => { row.changes[0].targetChanged = true }]) {
    const invalid = structuredClone(conservation); mutate(invalid)
    const result = projectConservationFailure([{ ...base, conservation: invalid }])
    assert.deepEqual(result.normal, [base]); assert.deepEqual(result.debug, [{ ...base, count: 2 }])
    assert.equal(JSON.stringify(result.result).includes(privateText), false)
  }
  const redacted = { observedChanges: 1, redactedChanges: 1, truncated: false, changes: [] }
  assert.deepEqual(projectConservationFailure([{ ...base, conservation: redacted }]).normal, [{ ...base, conservation: redacted }])
})

test('takeover phases remain distinct closed failures without changing runtime or cleanup verdicts', () => {
  const privateText = 'synthetic-private-https://example.invalid/secret?cookie=do-not-copy'
  for (const stage of ['next', 'vite']) {
    for (const failure of ['takeover', 'takeover_bind', 'takeover_not_denied', privateText, 'takeover_bind extra', true, 1, {}]) {
      const input = fixtureReceipts()
      Object.assign(input.runtime.claude, { stage, passed: false, failure, frameworks: [],
        error: { message: privateText, stderr: privateText, port: 34567 } })
      input.outcomes.acceptance = 'failure'
      const result = summarizeAcceptance(context, input)
      const closed = typeof failure === 'string' && ['takeover', 'takeover_bind', 'takeover_not_denied'].includes(failure)
      assert.equal(result.cases[0].stage, stage)
      assert.equal(result.cases[0].failure, closed ? failure : 'internal')
      assert.equal(result.cases[0].identityMatched, true)
      assert.equal(result.cases[0].runtimePassed, false)
      assert.equal(result.passed, false)
      assert.equal(result.runtimeCleanupConfirmed, true)
      assert.equal(result.templateCleanupConfirmed, true)
      assert.deepEqual(result.cases[0].frameworks, [])
      assert.equal(JSON.stringify(result).includes(privateText), false)
      assert.equal(Object.hasOwn(result.cases[0], 'error'), false)
    }
  }
})

test('preview shutdown failure retains both completed frameworks and the exact stage without claiming PTY or dropping cleanup', () => {
  const input = fixtureReceipts(), privateText = 'synthetic-private-shutdown-command-url-and-output'
  Object.assign(input.runtime.claude, { stage: 'preview_shutdown', passed: false, failure: 'process',
    previewStopped: false, terminal: undefined, message: privateText, command: privateText })
  input.outcomes.acceptance = 'failure'
  const result = summarizeAcceptance(context, input), row = result.cases[0]
  assert.equal(result.passed, false); assert.equal(row.runtimePassed, false)
  assert.equal(row.stage, 'preview_shutdown'); assert.equal(row.failure, 'process'); assert.equal(row.previewStopped, false)
  assert.equal(row.frameworks.length, 2)
  assert.ok(row.frameworks.every(value => value.hotReload && value.revoked && value.takeoverDenied && value.websocket.closed))
  assert.equal(row.terminal.passed, false)
  assert.equal(result.cases[1].runtimePassed, true)
  assert.equal(result.runtimeCleanupConfirmed, true); assert.equal(result.templateCleanupConfirmed, true)
  assert.equal(JSON.stringify(result).includes(privateText), false)
})

test('completed runtime needs the exact preview shutdown boolean and never copies private reply fields', () => {
  const privateText = 'synthetic-private-shutdown-reply'
  for (const value of [undefined, null, false, 'true', 1, {}, []]) {
    const input = fixtureReceipts()
    input.runtime.claude.previewStopped = value
    input.runtime.claude.shutdownReply = { stopped: true, private: privateText }
    const result = summarizeAcceptance(context, input)
    assert.equal(result.cases[0].previewStopped, value === false ? false : null)
    assert.equal(result.cases[0].runtimePassed, false); assert.equal(result.passed, false)
    assert.equal(result.cases[1].runtimePassed, true)
    assert.equal(JSON.stringify(result).includes(privateText), false)
  }
  const input = fixtureReceipts(), result = summarizeAcceptance(context, input)
  assert.equal(result.passed, true); assert.ok(result.cases.every(row => row.previewStopped === true))
})
