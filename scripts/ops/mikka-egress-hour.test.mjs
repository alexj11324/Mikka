import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = join(dirname(fileURLToPath(import.meta.url)), 'mikka-egress-hour.mjs')
const root = mkdtempSync(join(tmpdir(), 'mikka-egress-observer-test-'))
const repo = join(root, 'repo')
mkdirSync(join(repo, 'lib/factory'), { recursive: true })
for (let i = 0; i < 100; i++) writeFileSync(join(repo, 'lib/factory', String(i).padStart(3, '0') + '.ts'), 'export const value = ' + i + '\n')
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
git('init', '--quiet')
git('add', '.')
git('-c', 'user.name=Observer fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'isolated observer fixture')
const sourceSha = git('rev-parse', 'HEAD')
const start = Date.parse('2026-11-04T11:00:00.000Z')
const runId = '10000000-0000-4000-8000-000000000001'
const issueId = '20000000-0000-4000-8000-000000000001'
const expectedPaths = {
  api_key_flash: { model: 'deepseek-flash', harness: 'claude_code', credentialType: 'api_key', subscriptionRoute: null },
  claude_subscription: { model: 'claude-haiku-5-5', harness: 'claude_code', credentialType: 'subscription', subscriptionRoute: 'claude_code_cli' },
  codex_subscription: { model: 'gpt-6-luna', harness: 'codex', credentialType: 'subscription', subscriptionRoute: 'codex_cli' },
}
const execute = (mode, path, extra = {}) => spawnSync(process.execPath, [script, mode], {
  encoding: 'utf8', cwd: repo,
  env: { ...process.env, MIKKA_REPO_PATH: repo, EGRESS_SOURCE_SHA: sourceSha, EGRESS_WINDOW_START: new Date(start).toISOString(),
    EGRESS_PATH: path, EGRESS_RUN_ID: runId, EGRESS_ISSUE_ID: issueId, ...extra },
})
const goodSamples = path => Array.from({ length: 13 }, (_, index) => {
  const expected = expectedPaths[path]
  return {
    observedAt: new Date(start + index * 300_000).toISOString(), runId, issueId, status: 'running',
    startedAt: new Date(start - 60_000).toISOString(), finishedAt: null,
    ...expected, modelSource: expected.credentialType, cliModelSelection: 'explicit',
    apiKeyModel: expected.credentialType === 'api_key' ? expected.model : null,
    subscriptionModel: expected.credentialType === 'subscription' ? expected.model : null,
    lastSeq: 100 + index, lastEventAt: new Date(start + index * 300_000).toISOString(), lastReplyAt: null,
    otherOwnerRunningRuns: '0', otherRunningRuns: '0', otherWindowRuns: '0',
    rawOtherOwnerRunningRuns: '0', rawOtherRunningRuns: '0', rawOtherWindowRuns: '0',
    historicalOwnerRunningRows: '0', historicalRunningRows: '0', historicalWindowRows: '0',
  }
})
let count = 0
function validate(path, samples) {
  const file = join(root, 'samples-' + count++ + '.json')
  writeFileSync(file, JSON.stringify(samples))
  return execute('check-neon', path, { EGRESS_NEON_SAMPLES_PATH: file })
}

try {
  await test('the fixed source task is identical across the three explicit execution paths', () => {
    const plans = Object.keys(expectedPaths).map(path => {
      const result = execute('plan', path)
      assert.equal(result.status, 0, result.stderr)
      const plan = JSON.parse(result.stdout)
      assert.deepEqual(plan.expected, expectedPaths[path])
      assert.equal(plan.executionPath, path)
      assert.equal(plan.workload.files.length, 100)
      return plan
    })
    assert.equal(new Set(plans.map(plan => plan.workloadDigest)).size, 1)
    assert.equal(new Set(plans.map(plan => plan.prompt)).size, 1)
    assert.notEqual(execute('plan', '').status, 0)
    assert.notEqual(execute('plan', 'unknown-model').status, 0)
  })
  await test('each full, exclusive hour retains pending artifact/provider review status', () => {
    for (const path of Object.keys(expectedPaths)) {
      const result = validate(path, goodSamples(path))
      assert.equal(result.status, 0, result.stderr)
      const report = JSON.parse(result.stdout)
      assert.equal(report.status, 'samples_observed_pending_provider_and_artifact_review')
      assert.equal(report.progressBuckets, 12)
      assert.deepEqual(report.review, [])
    }
  })
  await test('a subscription-to-key transition or a model change invalidates the hour', () => {
    const samples = goodSamples('codex_subscription')
    samples[6] = { ...samples[6], credentialType: 'api_key', modelSource: 'api_key', subscriptionRoute: null,
      subscriptionModel: null, apiKeyModel: 'gpt-6-luna' }
    assert.match(validate('codex_subscription', samples).stderr, /egress_execution_path_changed/)
    const api = goodSamples('api_key_flash')
    api[6].model = 'deepseek-v4.1-pro'
    assert.match(validate('api_key_flash', api).stderr, /egress_execution_path_changed/)
    const conflict = goodSamples('api_key_flash')
    conflict[6].credentialType = 'conflict'
    assert.match(validate('api_key_flash', conflict).stderr, /egress_execution_path_changed/)
  })
  await test('other project activity, missing samples, and early completion cannot count as a full hour', () => {
    const active = goodSamples('api_key_flash'); active[5].otherRunningRuns = active[5].rawOtherRunningRuns = '1'
    assert.match(validate('api_key_flash', active).stderr, /egress_concurrent_project_run/)
    const brief = goodSamples('api_key_flash'); brief[12].otherWindowRuns = brief[12].rawOtherWindowRuns = '1'
    assert.match(validate('api_key_flash', brief).stderr, /egress_other_run_overlapped_window/)
    const earlyLast = goodSamples('api_key_flash')
    earlyLast[12].observedAt = new Date(start + 3_600_000 - 1_000).toISOString()
    assert.match(validate('api_key_flash', earlyLast).stderr, /egress_end_not_observed/)
    const missing = goodSamples('api_key_flash'); missing.splice(5, 1)
    assert.match(validate('api_key_flash', missing).stderr, /egress_neon_sample_missing_25/)
    const stopped = goodSamples('api_key_flash'); stopped[7].status = 'succeeded'
    stopped[7].finishedAt = stopped[7].observedAt
    assert.match(validate('api_key_flash', stopped).stderr, /egress_task_stopped_before_hour/)
  })
  await test('unchanged chunk sequence requires artifact/test review rather than asserting activity', () => {
    const samples = goodSamples('claude_subscription')
    samples[6].lastSeq = samples[5].lastSeq
    const result = validate('claude_subscription', samples)
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout).review, [{ minute: 30, reason: 'no_new_events_requires_artifact_and_test_review' }])
  })
  await test('historical unadmitted rows retain raw counts and cannot hide real activity or omit scope evidence', () => {
    const samples = goodSamples('codex_subscription')
    for (const sample of samples) {
      sample.rawOtherOwnerRunningRuns = sample.historicalOwnerRunningRows = '26'
      sample.rawOtherRunningRuns = sample.historicalRunningRows = '54'
      sample.rawOtherWindowRuns = sample.historicalWindowRows = '58'
    }
    const result = validate('codex_subscription', samples)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).samples[0].rawOtherWindowRuns, '58')
    samples[5].rawOtherWindowRuns = '59'
    assert.match(validate('codex_subscription', samples).stderr, /egress_activity_scope_mismatch/)
    samples[5].otherWindowRuns = '1'
    assert.match(validate('codex_subscription', samples).stderr, /egress_other_run_overlapped_window/)
    delete samples[0].rawOtherWindowRuns
    assert.match(validate('codex_subscription', samples).stderr, /egress_activity_scope_evidence_missing/)
  })
  await test('generated production observation is one scoped SELECT with no credential values', () => {
    const result = execute('neon-sql', 'claude_subscription')
    assert.equal(result.status, 0, result.stderr)
    const query = JSON.parse(result.stdout)
    assert.equal(query.project_id, 'autumn-fire-21908520')
    assert.equal(query.branch_id, 'br-autumn-rain-b5leflom')
    assert.equal(query.database_name, 'orvilo_mvp')
    assert.match(query.sql, /^WITH other_runs AS MATERIALIZED \(SELECT /)
    assert.match(query.sql, /SELECT now\(\)/)
    assert.match(query.sql, new RegExp(runId))
    assert.match(query.sql, new RegExp(issueId))
    assert.doesNotMatch(query.sql, /\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE)\b/i)
    assert.doesNotMatch(query.sql, /tokenHash|accessToken|refreshToken|secret|prompt|instructions|keyId|bindingId/)
  })
} finally {
  rmSync(root, { recursive: true, force: true })
}
