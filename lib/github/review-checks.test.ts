import assert from 'node:assert/strict'
import test from 'node:test'
import { readReviewChecks, reviewCheckCounts, reviewCheckEvent } from './review-checks'

const sha = 'a'.repeat(40), at = '2026-11-09T13:00:00Z'
const run = (id: number, name: string, state = 'completed', conclusion: string | null = 'success') => ({ id, name, head_sha: sha,
  app: { id: 8 }, check_suite: { id: 100 }, status: state, conclusion, started_at: at, completed_at: state === 'completed' ? at : null })

test('review counts keep cancelled/failed and pending separate and never call skipped or neutral passed', async () => {
  const checks = [run(1, 'success'), run(2, 'failure', 'completed', 'failure'), run(3, 'queued', 'queued', null),
    run(4, 'cancelled', 'completed', 'cancelled'), run(5, 'skipped', 'completed', 'skipped'), run(6, 'neutral', 'completed', 'neutral')]
  const result = await readReviewChecks(async path => path.includes('check-runs') ? { total_count: checks.length, check_runs: checks }
    : { sha, total_count: 2, statuses: [{ id: 10, context: 'deploy', state: 'pending', updated_at: at }, { id: 11, context: 'lint', state: 'error', updated_at: at }] }, '/repos/o/r', sha)
  assert.deepEqual(reviewCheckCounts(result, sha).counts, { passed: 1, failed: 3, pending: 2, skipped: 2 })
  assert.equal(reviewCheckCounts(result, 'b'.repeat(40)).counts, null)
  assert.equal(reviewCheckCounts({ ...result, complete: false }, sha).counts, null)
  assert.deepEqual(reviewCheckCounts(null, sha), { counts: null, updatedAt: null })
})

test('review ingestion paginates all checks and counts only the latest run for a named app check', async () => {
  const first = Array.from({ length: 100 }, (_, i) => run(i + 1, `check-${i}`))
  const paths: string[] = []
  const result = await readReviewChecks(async path => {
    paths.push(path)
    if (!path.includes('check-runs')) return { sha, total_count: 0, statuses: [] }
    return { total_count: 101, check_runs: new URL(path, 'https://api.github.com').searchParams.get('page') === '1' ? first : [run(200, 'check-0', 'completed', 'failure')] }
  }, '/repos/o/r', sha)
  assert.equal(paths.length, 3)
  assert.deepEqual(reviewCheckCounts(result, sha).counts, { passed: 99, failed: 1, pending: 0, skipped: 0 })
})

test('the same job name in different check suites never hides a failing workflow, while a rerun replaces only its own suite', async () => {
  const checks = [{ ...run(11, 'backend', 'completed', 'failure'), check_suite: { id: 101 } },
    { ...run(12, 'backend'), check_suite: { id: 102 } }]
  const request = async (path: string) => {
    if (!path.includes('check-runs')) return { sha, total_count: 0, statuses: [] }
    assert.equal(new URL(path, 'https://api.github.com').searchParams.get('filter'), 'all')
    return { total_count: checks.length, check_runs: checks }
  }
  assert.deepEqual(reviewCheckCounts(await readReviewChecks(request, '/repos/o/r', sha), sha).counts, { passed: 1, failed: 1, pending: 0, skipped: 0 })
  checks.push({ ...run(13, 'backend'), check_suite: { id: 101 } })
  assert.deepEqual(reviewCheckCounts(await readReviewChecks(request, '/repos/o/r', sha), sha).counts, { passed: 2, failed: 0, pending: 0, skipped: 0 })
})

test('a partial API response, mismatched head or unbounded pagination cannot fabricate complete checks', async () => {
  for (const response of [{ total_count: 1, check_runs: [] }, { total_count: 1, check_runs: [{ ...run(1, 'CI'), head_sha: 'b'.repeat(40) }] }]) {
    await assert.rejects(readReviewChecks(async () => response, '/repos/o/r', sha), { code: 'github_request_failed' })
  }
  let calls = 0
  await assert.rejects(readReviewChecks(async () => { calls++; return { total_count: 1001, check_runs: Array.from({ length: 100 }, (_, i) => run(i + 1, `CI-${i}`)) } }, '/repos/o/r', sha), { code: 'github_request_failed' })
  assert.equal(calls, 10)
})

test('signed event projection admits only a repository/head-bound check or commit status', () => {
  const repository = { full_name: 'o/r' }
  const event = reviewCheckEvent('check_run', { action: 'completed', repository, check_run: run(4, 'CI') })!
  assert.equal(event.headSha, sha)
  assert.equal(event.repository, 'o/r')
  assert.equal(event.check.state, 'passed')
  assert.equal(reviewCheckEvent('check_run', { action: 'created', repository, check_run: { ...run(5, 'queued', 'queued', null), started_at: null } })?.check.state, 'pending')
  assert.equal(reviewCheckEvent('check_run', { action: 'completed' }), null)
  assert.equal(reviewCheckEvent('check_run', { action: 'rerequested', repository, check_run: run(4, 'CI') }), null)
  assert.equal(reviewCheckEvent('status', { repository: { full_name: 'other/../repo' }, sha, id: 3, context: 'ci', state: 'success', updated_at: at }), null)
  assert.equal(reviewCheckEvent('status', { repository, sha, id: 3, context: 'ci', state: 'success', updated_at: at })?.check.state, 'passed')
})
