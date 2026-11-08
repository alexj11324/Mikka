import test from 'node:test'
import assert from 'node:assert/strict'
import { timingReceipt } from './timings.mjs'

test('parallel waits are not summed into wall time; runner, queue and step durations stay separate', () => {
  const at = seconds => new Date(Date.UTC(2026, 10, 8) + seconds * 1000).toISOString()
  const job = (name, created, started, completed) => ({ name, created_at: at(created), started_at: at(started), completed_at: at(completed), conclusion: 'success', steps: [{ name: 'Install dependencies', started_at: at(started), completed_at: at(started + 10), conclusion: 'success' }] })
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

test('an unfinished or entirely skipped run cannot become a performance sample', () => {
  assert.throws(() => timingReceipt({ id: 1, status: 'in_progress' }, []), /runIncomplete/)
  assert.throws(() => timingReceipt({ id: 2, status: 'completed' }, [{ conclusion: 'skipped' }]), /runWithoutCompletedJobs/)
})
