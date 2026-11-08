import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { assertOpsContext } from './self-hosted-ingress-probe.mjs'
import { P0, assertDependencies, assertSourceIdentity, assertWorkerIdentity, summarizeAcceptance } from './workspace-private-acceptance.mjs'

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
      stage: 'completed', passed: true, guard, resumedGuard: guard, frameworks, terminal: { passed: true } }])),
    vmCleanup: { version: 1, sourceCommit: P0.source, opsSource: context.opsSource,
      cleanup: kinds.map(kind => ({ kind, stopped: true, absent: true, scopeVerified: true, killAcknowledged: true,
        outcome: 'provider_kill_acknowledged_and_absent' })) },
    templateCleanups: [{ identity, confirmed: true, errors: [], sandboxes: [],
      templates: kinds.map(kind => ({ kind, name: templates[kind].name, templateId: templates[kind].templateId, status: 'deleted' })) }],
    outcomes: { build: 'success', acceptance: 'success', vmCleanup: 'success', templateCleanup: 'success' } }
}

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

test('workflow retains the original sole credential and gives cleanup time outside the production lane', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/self-hosted-vault-closeout.yml', import.meta.url), 'utf8')
  assert.match(workflow, /branches: \[ops\/self-hosted-vault-closeout-20261108\]/)
  assert.match(workflow, /group: coding-workspace-private-candidates/)
  assert.doesNotMatch(workflow, /production-smoke-owner-acceptance|workflow_dispatch:|pull_request:|SMOKE_OWNER|publish-verified|(?:GITHUB_SHA|GITHUB_REF)=/)
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
