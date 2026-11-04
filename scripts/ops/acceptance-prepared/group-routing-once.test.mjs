import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareCoreEvidence, runPreparedRouting, writeRoutingReport } from './group-routing-once.mjs'

const digest = value => createHash('sha256').update(value).digest('hex')
const repository = 'alexj11324/Mikka', branch = 'acceptance/proactive-1157-1163'
const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0')
function coreReplay() {
  const rows = policyVersion => Array.from({ length: 12 }, (_, index) => {
    const receipt = { executionId: policyVersion + '-execution-' + index, providerGenerationId: policyVersion + '-generation-' + index,
      requestDigest: digest(policyVersion + index), modelId: 'openai/gpt-6-luna-decisions' }
    return { policyVersion, status: 'complete', failureReason: null, receipt, route: { action: 'reply' }, projection: { intervention: true },
      decisions: [{ index: 0, policyVersion, status: 'complete', failure: null, receipt }] }
  })
  return { status: 'comparison_ready', comparisonVersion: 'group-decision-comparison-v2',
    baseline: rows('group-route-v0'), candidate: rows('group-contribution-v2'),
    comparison: { baselineClassifiable: true, decisionReviewReady: true,
      baseline: { observed: 12, accuracyDenominator: 12, measured: 12, abstentions: 0 },
      candidate: { observed: 12, accuracyDenominator: 12, measured: 12, coverage: 1, failures: [] } } }
}

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'routing-artifact-contract-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const env = { GITHUB_REPOSITORY: repository, GITHUB_REF: 'refs/heads/' + branch, GITHUB_EVENT_NAME: 'push',
    GITHUB_RUN_ATTEMPT: '1', GITHUB_RUN_ID: '201', GITHUB_SHA: 'b'.repeat(40), GITHUB_WORKSPACE: directory,
    GH_TOKEN: 'PRIVATE_GITHUB_TEST_TOKEN', GROUP_CORE_RUN_ID: '101', GROUP_CORE_JOB_ID: '102', GROUP_CORE_ARTIFACT_ID: '103',
    GROUP_CORE_WORKFLOW_ID: '104', GROUP_CORE_DRIVER_REVISION: 'c'.repeat(40), GROUP_ACCEPTANCE_REVISION: 'a'.repeat(40),
    GROUP_ACCEPTANCE_DEPLOYMENT: 'dpl_SyntheticOnly', GROUP_ACCEPTANCE_ORIGIN: 'https://app.aspectlylabs.com' }
  const core = { status: 'pass', origin: env.GROUP_ACCEPTANCE_ORIGIN, revision: env.GROUP_ACCEPTANCE_REVISION,
    deploymentId: env.GROUP_ACCEPTANCE_DEPLOYMENT, expectedDecisionReplays: 24, actualReceiptedDecisionReplays: 24,
    completedLogicalDecisionReplays: 24, replay: coreReplay(), replayAccounting: { comparisonVersion: 'group-decision-comparison-v2', evidenceValid: true, valid: true, collectionComplete: true, qualityAccepted: true,
      baselineClassifiable: true, logicalReplays: 24, receiptedLogicalReplays: 24, completedLogicalReplays: 24, baselineCompleted: 12, baselineAbstentions: 0, candidateCompleted: 12 },
    fixtureConversationId: id(1), group: { status: 'pass', revision: env.GROUP_ACCEPTANCE_REVISION, deploymentId: env.GROUP_ACCEPTANCE_DEPLOYMENT,
      conversationId: id(1), fixtureId: id(2), workspaceId: id(3), requesterId: 'synthetic-owner' } }
  options.changeCore?.(core)
  const json = JSON.stringify(core, null, 2) + '\n'
  const entries = options.entries ?? [{ name: 'results.json', data: json }]
  const zip = execFileSync('python3', ['-c', `import io,json,sys,zipfile,stat
out=io.BytesIO()
with zipfile.ZipFile(out,'w',compression=zipfile.ZIP_DEFLATED) as archive:
 for entry in json.load(sys.stdin):
  info=zipfile.ZipInfo(entry['name'])
  info.compress_type=zipfile.ZIP_DEFLATED
  if entry.get('symlink'): info.external_attr=(stat.S_IFLNK|0o777)<<16
  archive.writestr(info,entry['data'])
sys.stdout.buffer.write(out.getvalue())
`], { input: JSON.stringify(entries) })
  env.GROUP_CORE_REPORT_SHA256 = digest(json); env.GROUP_CORE_ZIP_SHA256 = digest(zip)
  const run = { id: 101, workflow_id: 104, status: 'completed', conclusion: 'success', run_attempt: 1, event: 'push',
    head_branch: branch, head_sha: env.GROUP_CORE_DRIVER_REVISION, repository: { full_name: repository }, head_repository: { full_name: repository },
    path: '.github/workflows/proactive-acceptance.yml@' + branch }
  const jobs = { total_count: 1, jobs: [{ id: 102, run_id: 101, head_sha: env.GROUP_CORE_DRIVER_REVISION,
    name: 'acceptance', status: 'completed', conclusion: 'success' }] }
  const artifact = { id: 103, name: 'proactive-acceptance-101', expired: false, size_in_bytes: zip.length,
    digest: 'sha256:' + env.GROUP_CORE_ZIP_SHA256, workflow_run: { id: 101, head_branch: branch, head_sha: env.GROUP_CORE_DRIVER_REVISION } }
  options.changeMetadata?.({ run, jobs, artifact })
  const calls = [], state = { bundleCalls: 0, verified: 0 }
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input); calls.push({ host: url.hostname, path: url.pathname, authorization: new Headers(init.headers).get('authorization') })
    assert.equal(init.method, 'GET'); assert.ok(init.signal instanceof AbortSignal)
    if (url.hostname === 'api.github.com') {
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer ' + env.GH_TOKEN)
      const jsonResponse = data => new Response(JSON.stringify(data), { status: 200 })
      if (url.pathname.endsWith('/actions/runs/101')) return jsonResponse(run)
      if (url.pathname.endsWith('/actions/runs/101/jobs')) { assert.equal(url.search, '?filter=all&per_page=100'); return jsonResponse(jobs) }
      if (url.pathname.endsWith('/actions/artifacts/103')) return jsonResponse(artifact)
      if (url.pathname.endsWith('/actions/artifacts/103/zip')) {
        assert.equal(init.redirect, 'manual')
        return new Response(null, { status: 302, headers: { location: options.foreignRedirect
          ? 'https://foreign.invalid/archive.zip?PRIVATE_SIGNED_URL'
          : 'https://productionresultssa1.blob.core.windows.net/artifact.zip?PRIVATE_SIGNED_URL' } })
      }
    } else {
      assert.equal(url.hostname, 'productionresultssa1.blob.core.windows.net')
      assert.equal(new Headers(init.headers).has('authorization'), false); assert.equal(init.redirect, 'error')
      return new Response(options.changedZip ? Buffer.from('different zip') : zip, { status: 200 })
    }
    assert.fail('Unexpected request')
  }
  const verify = () => { state.verified++ }
  const bundle = async input => {
    state.bundleCalls++; assert.equal(input.coreReportJson, json); assert.equal(input.coreReportSha256, digest(json))
    return { status: options.bundleFailed ? 'failed' : 'passed', group: { messageAttempts: 8, status: 'passed' }, credentialCleanup: { created: true, removed: true } }
  }
  return { env, calls, state, json, core, directory, args: { env, fetchImpl, verify }, runArgs: { env, bundle, verify } }
}

test('original run, its sole job and exact artifact bind the downloaded bytes without forwarding the GitHub token', async t => {
  const h = fixture(t), manifest = await prepareCoreEvidence(h.args)
  assert.equal(h.calls.length, 5); assert.equal(h.calls.at(-1).authorization, null)
  assert.equal(manifest.coreRunId, 101); assert.equal(manifest.coreJobId, 102); assert.equal(manifest.artifactId, 103)
  assert.equal(manifest.gitHubMetadataVerified, true); assert.equal(manifest.uniqueJobVerified, true)
  assert.equal(readFileSync(join(h.directory, 'group-routing-input/core-report.json'), 'utf8'), h.json)
  assert.equal(JSON.stringify(manifest).includes('PRIVATE'), false)
  const report = await runPreparedRouting(h.runArgs)
  assert.equal(report.status, 'passed'); assert.equal(h.state.bundleCalls, 1)
  assert.equal(report.coreArtifactProof.reportDigestVerified, true)
  writeRoutingReport(report, h.env)
  assert.equal(readFileSync(join(h.directory, 'group-routing-sanitized/results.json'), 'utf8').includes('PRIVATE'), false)
})

test('wrong run, fork, job, artifact or expired metadata stops before an archive or application operation', async t => {
  for (const changeMetadata of [m => { m.run.conclusion = 'failure' }, m => { m.run.head_sha = 'd'.repeat(40) },
    m => { m.run.head_repository.full_name = 'other/Mikka' }, m => { m.run.event = 'pull_request' },
    m => { m.jobs.total_count = 2 }, m => { m.jobs.jobs[0].id = 999 }, m => { m.jobs.jobs[0].conclusion = 'cancelled' },
    m => { m.artifact.expired = true }, m => { m.artifact.workflow_run.id = 999 }, m => { m.artifact.name = 'other-artifact' }]) {
    const h = fixture(t, { changeMetadata })
    await assert.rejects(prepareCoreEvidence(h.args), /routing_entry_core_/)
    assert.equal(h.calls.some(c => c.path.endsWith('/zip')), false); assert.equal(h.state.bundleCalls, 0)
  }
})

test('archive bytes, JSON bytes, paths and symlinks must match the fixed single-report contract', async t => {
  for (const options of [{ changedZip: true }, { entries: [{ name: '../results.json', data: '{}' }] },
    { entries: [{ name: 'results.json', data: '{}', symlink: true }] },
    { entries: [{ name: 'results.json', data: '{}' }, { name: 'extra', data: '{}' }] },
    { entries: [{ name: 'results.json', data: '{}' }] }]) {
    const h = fixture(t, options)
    await assert.rejects(prepareCoreEvidence(h.args), /routing_entry_(?:archive|report)_/)
    assert.equal(existsSync(join(h.directory, 'group-routing-input')), false)
  }
})

test('a successful workflow with a failed or partial actual core report cannot authorize credentials', async t => {
  for (const changeCore of [core => { core.status = 'fail' }, core => { core.replayAccounting.qualityAccepted = false },
    core => { core.completedLogicalDecisionReplays = 23 }, core => { core.group.deploymentId = 'dpl_Other' },
    core => { delete core.replay.comparisonVersion }, core => { core.replay.status = 'complete' }, core => { core.replay.candidate[0].status = 'invalid_decision' }]) {
    const h = fixture(t, { changeCore })
    await assert.rejects(prepareCoreEvidence(h.args), /routing_entry_(?:core_not_accepted|report_source_binding)/)
    assert.equal(h.state.bundleCalls, 0); assert.equal(existsSync(join(h.directory, 'group-routing-input')), false)
  }
})

test('download redirects are constrained and no GitHub credential is sent to a different service', async t => {
  const h = fixture(t, { foreignRedirect: true })
  await assert.rejects(prepareCoreEvidence(h.args), /archive_location/)
  assert.equal(h.calls.length, 4); assert.ok(h.calls.every(call => call.host === 'api.github.com'))
})

test('a changed prepared context or report fails before the bundle and the execution marker prevents replay even after failure', async t => {
  const moved = fixture(t); await prepareCoreEvidence(moved.args)
  moved.env.GITHUB_RUN_ID = '202'
  await assert.rejects(runPreparedRouting(moved.runArgs), /prepared_manifest_binding/); assert.equal(moved.state.bundleCalls, 0)
  const changed = fixture(t); await prepareCoreEvidence(changed.args)
  writeFileSync(join(changed.directory, 'group-routing-input/core-report.json'), changed.json + ' ')
  await assert.rejects(runPreparedRouting(changed.runArgs), /report_digest/); assert.equal(changed.state.bundleCalls, 0)
  const h = fixture(t, { bundleFailed: true }); await prepareCoreEvidence(h.args)
  assert.equal((await runPreparedRouting(h.runArgs)).status, 'failed')
  await assert.rejects(runPreparedRouting(h.runArgs), /already_started_or_written/); assert.equal(h.state.bundleCalls, 1)
})

test('placeholders or rerun context cannot contact GitHub, and secret-bearing evidence is not written', async t => {
  for (const [key, value] of [['GROUP_CORE_RUN_ID', 'REPLACE_WITH_PASS'], ['GROUP_CORE_ZIP_SHA256', 'REPLACE_WITH_SHA'], ['GITHUB_RUN_ATTEMPT', '2']]) {
    const h = fixture(t); h.env[key] = value
    await assert.rejects(prepareCoreEvidence(h.args), /routing_entry_/); assert.equal(h.calls.length, 0)
  }
  const h = fixture(t)
  assert.throws(() => writeRoutingReport({ status: 'failed', bad: h.env.GH_TOKEN }, h.env), /report_secret/)
  assert.equal(existsSync(join(h.directory, 'group-routing-sanitized/results.json')), false)
})

test('the inactive template keeps one existing workflow path, pre-secret artifact binding and only three named application secrets', () => {
  const yaml = readFileSync(new URL('./group-routing-once.yml', import.meta.url), 'utf8')
  assert.deepEqual([...yaml.matchAll(/secret-name: ([A-Z_]+)/g)].map(match => match[1]), ['SMOKE_OWNER_EMAIL', 'SMOKE_OWNER_PASSWORD', 'DEEPSEEK_API_KEY'])
  assert.ok(yaml.indexOf('group-routing-once.mjs prepare') < yaml.indexOf('secret-name: SMOKE_OWNER_EMAIL'))
  assert.ok(yaml.indexOf('group-routing-once.mjs run') > yaml.indexOf('secret-name: DEEPSEEK_API_KEY'))
  assert.match(yaml, /actions: read/); assert.match(yaml, /github\.run_attempt == 1/)
  assert.match(yaml, /cancel-in-progress: false/); assert.match(yaml, /timeout-minutes: 20/)
  assert.match(yaml, /11m node --import tsx/); assert.match(yaml, /REPLACE_WITH_SUCCESSFUL_CORE_ARTIFACT_ID/)
  assert.doesNotMatch(yaml, /E2B_API_KEY|PostHog|workflow_dispatch/)
})

test('verified v2 artifact permits twenty genuinely completed cases plus four bound baseline abstentions', async t => {
  const h = fixture(t, { changeCore: core => {
    for (const row of core.replay.baseline.slice(0, 4)) {
      row.status = 'invalid_decision'; row.failureReason = 'uncertain'; row.route = null; row.projection = null
      row.decisions[0].status = 'invalid_decision'; row.decisions[0].failure = 'uncertain'
    }
    core.completedLogicalDecisionReplays = 20
    Object.assign(core.replayAccounting, { baselineCompleted: 8, baselineAbstentions: 4, completedLogicalReplays: 20 })
    Object.assign(core.replay.comparison.baseline, { measured: 8, abstentions: 4 })
  } })
  await prepareCoreEvidence(h.args)
  const report = await runPreparedRouting(h.runArgs)
  assert.equal(report.status, 'passed'); assert.equal(h.state.bundleCalls, 1)
  assert.equal(JSON.parse(h.json).completedLogicalDecisionReplays, 20)
})
