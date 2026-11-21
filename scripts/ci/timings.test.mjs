import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { timingReceipt } from './timings.mjs'

test('parallel waits are not summed into wall time; runner, queue and step durations stay separate', () => {
  const at = seconds => new Date(Date.UTC(2026, 10, 8) + seconds * 1000).toISOString()
  const job = (name, created, started, completed) => ({ name, status: 'completed', created_at: at(created), started_at: at(started), completed_at: at(completed), conclusion: 'success', steps: [{ name: 'Install dependencies', started_at: at(started), completed_at: at(started + 10), conclusion: 'success' }] })
  const run = { id: 1, status: 'completed', created_at: at(0), run_attempt: 2 }
  const result = timingReceipt(run, [job('linux', 5, 20, 80), job('mac', 5, 30, 150), { name: 'skipped', conclusion: 'skipped', steps: null }])
  assert.equal(result.wall_seconds, 150)
  assert.equal(result.first_queue_seconds, 20)
  assert.equal(result.execution_span_seconds, 130)
  assert.equal(result.runner_minutes, 3)
  assert.equal(result.attempt, 2)
  assert.deepEqual(result.jobs.map(j => j.queue_seconds), [15, 25, null])
  assert.equal(result.jobs[0].steps[0].seconds, 10)
  assert.equal(result.jobs[2].seconds, 0)
})

test('the collector measures the recorded attempt, excluding earlier work retained by a failed-job retry', t => {
  const directory = mkdtempSync(join(tmpdir(), 'ci-timing-api-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const fixture = fileURLToPath(new URL('./fixtures/actions-rerun-timings.json', import.meta.url))
  // Simulate only gh's external read-only API boundary with captured GitHub data.
  writeFileSync(join(directory, 'gh'), `#!${process.execPath}
const { readFileSync } = require('node:fs')
const samples = JSON.parse(readFileSync(process.env.CI_TIMING_FIXTURE, 'utf8'))
const responses = new Map()
for (const sample of samples) {
  const path = 'repos/alexj11324/Mikka/actions/runs/' + sample.run.id
  responses.set(path, sample.run)
  responses.set(path + '/attempts/2', sample.attempt)
  responses.set(path + '/attempts/2/jobs?per_page=100&page=1', { total_count: sample.jobs.length, jobs: sample.jobs })
}
if (process.argv[2] !== 'api' || !responses.has(process.argv[3])) process.exit(2)
process.stdout.write(JSON.stringify(responses.get(process.argv[3])))
`, { mode: 0o755 })
  const actual = JSON.parse(execFileSync(process.execPath, [
    fileURLToPath(new URL('./timings.mjs', import.meta.url)), '44798376633', '44791185503',
  ], {
    encoding: 'utf8',
    env: { ...process.env, PATH: directory + delimiter + process.env.PATH, CI_TIMING_FIXTURE: fixture },
  }))
  assert.equal(actual[0].first_queue_seconds, 514)
  assert.equal(actual[0].wall_seconds, 2611)
  assert.equal(actual[0].run_lifetime_seconds, 4737)
  assert.equal(actual[0].runner_minutes * 60, 221)
  assert.equal(actual[0].retained_job_count, 0)
  assert.equal(actual[1].first_queue_seconds, 5)
  assert.equal(actual[1].wall_seconds, 177)
  assert.equal(actual[1].run_lifetime_seconds, 539)
  assert.equal(actual[1].runner_minutes * 60, 165)
  assert.equal(actual[1].retained_job_count, 1)
  const retained = actual[1].jobs.find(job => job.id === 136482292335)
  assert.equal(retained.queue_seconds, null)
  assert.equal(retained.seconds, 0)
  assert.equal(retained.retained_seconds, 28)
  assert.equal(retained.started_at, '2026-11-20T18:16:22Z')
})

test('an unfinished or entirely skipped run cannot become a performance sample', () => {
  assert.throws(() => timingReceipt({ id: 1, status: 'in_progress' }, []), /runIncomplete/)
  assert.throws(() => timingReceipt({ id: 2, status: 'completed' }, [{ conclusion: 'skipped' }]), /runWithoutCompletedJobs/)
})
