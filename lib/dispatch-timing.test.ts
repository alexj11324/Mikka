import assert from 'node:assert/strict'
import test from 'node:test'
import { noteGitHubRequest, timedPhase, withDispatchTiming, type DispatchTiming } from './dispatch-timing'

const identity = async () => ({ workflowRunId: 'wrun_1', stepId: 'step_1', attempt: 1 })

test('one line per dispatch: phases in order, GitHub requests counted, nothing else', async () => {
  let clock = 0
  const now = () => clock
  const lines: DispatchTiming[] = []
  const result = await withDispatchTiming(async () => {
    await timedPhase('resolveRepository', async () => {
      clock += 100; noteGitHubRequest(40); noteGitHubRequest(60)
    }, now)
    await timedPhase('queueCloudRun', async () => { clock += 20 }, now)
    clock += 5
    return { runId: 'run-1' }
  }, now, line => lines.push(line), identity)
  assert.deepEqual(result, { runId: 'run-1' })
  assert.deepEqual(lines, [{
    msg: 'dispatch_timing', workflowRunId: 'wrun_1', stepId: 'step_1', attempt: 1, startedAt: 0, endedAt: 125, totalMs: 125,
    phases: [{ phase: 'resolveRepository', ms: 100 }, { phase: 'queueCloudRun', ms: 20 }],
    github: { requests: 2, ms: 100 }, failed: false,
  }])
})

test('a failed dispatch still logs what ran, and the failure reaches the caller', async () => {
  const lines: DispatchTiming[] = []
  await assert.rejects(withDispatchTiming(async () => {
    await timedPhase('resolveModelDispatch', async () => { throw new Error('boom') })
  }, Date.now, line => lines.push(line), identity), /boom/)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].failed, true)
  assert.deepEqual(lines[0].phases.map(phase => phase.phase), ['resolveModelDispatch'])
})

test('outside a timed dispatch a phase only runs and a GitHub request is not counted', async () => {
  noteGitHubRequest(10)
  assert.equal(await timedPhase('anything', async () => 7), 7)
})

test('a broken log never fails the dispatch', async () => {
  const result = await withDispatchTiming(async () => 'ok', Date.now, () => { throw new Error('log down') }, identity)
  assert.equal(result, 'ok')
})
