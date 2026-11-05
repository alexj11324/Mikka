import assert from 'node:assert/strict'
import test from 'node:test'
import { bareUrl, candidateCheckRetry, candidateCheckRetryConfirmed, candidateCheckState, criterionGroups, pullNumber, resultRows, visibleAcceptance, type AcceptanceCheck, type AcceptanceTaskView } from './acceptance-view'
import type { EvidenceEntry } from './evidence-view'

const shot = (id: string, title: string): EvidenceEntry => ({ artifact: `run-capture:${id}`, captureId: id, title, kind: 'screenshot', stage: 'verify', runId: 'verify-run' })
const log: EvidenceEntry = { artifact: 'run-chunk:7d1c2a40-0000-4000-8000-000000000001', kind: 'log', stage: 'verify', runId: 'verify-run' }
const report: EvidenceEntry = { artifact: 'run-report:exec', kind: 'report', stage: 'execute', runId: 'exec-run' }
const check = (patch: Partial<AcceptanceCheck>): AcceptanceCheck => ({ attemptId: 'a', stage: 'verify', status: 'passed', candidateId: 'c1', candidateSha: 'f'.repeat(40), runId: 'verify-run', criteria: [], verify: null, ...patch })

test('evidence sits under the criterion that names it; the rest stays in a last untitled group', () => {
  const verify = check({
    criteria: [
      { criterionId: 'k1', text: '首页 2 秒内可交互（4G）', passed: true, evidence: 'run-capture:s1 and run-chunk:7d1c2a40-0000-4000-8000-000000000001' },
      { criterionId: 'k2', text: '首屏图片懒加载后无布局跳动', passed: false, evidence: '图片加载完成' },
    ],
    verify: { status: 'passed', command: 'pnpm e2e home-cls', exitCode: 0 },
  })
  const groups = criterionGroups([shot('s1', '首页首屏'), shot('s2', '图片加载完成'), log, report], [verify], 'c1')
  assert.deepEqual(groups.map(group => [group.title, group.passed, group.items.map(item => item.entry.artifact)]), [
    ['首页 2 秒内可交互（4G）', true, ['run-capture:s1', log.artifact]],
    ['首屏图片懒加载后无布局跳动', false, ['run-capture:s2']],
    [null, null, ['run-report:exec']],
  ])
  assert.deepEqual(groups[0].items[1].command, { text: 'pnpm e2e home-cls', exitCode: 0 }, 'text from the verify run carries its command')
  assert.equal(groups[0].items[0].command, null, 'media never does')
  assert.equal(groups[2].items[0].command, null, 'text from another run does not')
})

test('each criterion shows the command that checked it; the run command is the fallback', () => {
  const second: EvidenceEntry = { ...log, artifact: 'run-chunk:7d1c2a40-0000-4000-8000-000000000002' }
  const verify = check({
    criteria: [
      { criterionId: 'k1', text: '首页 2 秒内可交互（4G）', passed: true, evidence: log.artifact, command: 'pnpm perf:home --4g', exitCode: 0 },
      { criterionId: 'k2', text: 'Lighthouse 性能分 ≥ 90', passed: false, evidence: second.artifact, command: 'pnpm lighthouse:mobile', exitCode: 1 },
      { criterionId: 'k3', text: '首屏图片懒加载后无布局跳动', passed: true, evidence: `${log.artifact} ${second.artifact}` },
    ],
    verify: { status: 'failed', command: 'pnpm verify', exitCode: 1 },
  })
  const groups = criterionGroups([log, second], [verify], 'c1')
  assert.deepEqual(groups.map(group => group.items.map(item => item.command)), [
    [{ text: 'pnpm perf:home --4g', exitCode: 0 }],
    [{ text: 'pnpm lighthouse:mobile', exitCode: 1 }],
    [{ text: 'pnpm verify', exitCode: 1 }, { text: 'pnpm verify', exitCode: 1 }],
  ])
  const unknownExit = check({ criteria: [{ criterionId: 'k1', text: 'a', passed: true, evidence: log.artifact, command: 'pnpm a' }] })
  assert.deepEqual(criterionGroups([log], [unknownExit], 'c1')[0].items[0].command, { text: 'pnpm a', exitCode: null })
})

test('only the current candidate counts, and the latest check of a stage wins', () => {
  const old = check({ candidateId: 'c0', criteria: [{ criterionId: null, text: 'old', passed: true, evidence: null }] })
  const first = check({ criteria: [{ criterionId: null, text: 'first', passed: false, evidence: null }] })
  const latest = check({ criteria: [{ criterionId: null, text: 'latest', passed: true, evidence: null }] })
  assert.deepEqual(criterionGroups([], [old, first, latest], 'c1').map(group => group.title), ['latest'])
  assert.deepEqual(criterionGroups([report], [], 'c1').map(group => group.title), [null], 'no checks: one untitled group')
  assert.deepEqual(criterionGroups([], [], 'c1'), [])
})

test('独立结果 lists the latest review then verify with their counts', () => {
  const rows = resultRows([
    check({ stage: 'verify', criteria: [{ criterionId: null, text: 'a', passed: true, evidence: null }, { criterionId: null, text: 'b', passed: true, evidence: null }] }),
    check({ stage: 'review', status: 'failed', runId: 'review-run', criteria: [{ criterionId: null, text: 'x', passed: false, evidence: null }] }),
    check({ stage: 'monitor' }),
  ], 'c1')
  assert.deepEqual(rows.map(row => [row.stage, row.status, row.runId, row.passed, row.total]), [['review', 'failed', 'review-run', 0, 1], ['verify', 'passed', 'verify-run', 2, 2]])
})

test('command origins belong only to the latest check of the current candidate and never change its verdict', () => {
  const origin = { runId: 'pre-question-run', sessionId: 'original-native-session', status: 'stopped' as const,
    recoveryEventId: 'immutable-answer-receipt', observedAt: '2026-11-04T09:12:34.000Z' }
  const rows = resultRows([
    check({ stage: 'review', candidateId: 'old-candidate', commandSources: [origin] }),
    check({ stage: 'review', commandSources: [origin] }),
    check({ stage: 'review', status: 'failed', criteria: [{ criterionId: 'k', text: 'Current file', passed: false, evidence: null }] }),
    check({ stage: 'verify', status: 'failed', commandSources: [origin] }),
  ], 'c1')
  assert.equal(rows[0].commandSources, undefined, 'an earlier check cannot label a new result')
  assert.deepEqual(rows[1].commandSources, [origin], 'preserve the host-provided run, SID, status, receipt and time')
  assert.deepEqual(rows.map(row => [row.stage, row.status, row.passed, row.total]), [['review', 'failed', 0, 1], ['verify', 'failed', 0, 0]])
})

test('PR numbers and bare preview hosts', () => {
  assert.equal(pullNumber('https://github.com/alexj11324/Mikka/pull/418'), '418')
  assert.equal(pullNumber('https://github.com/alexj11324/Mikka/pull/418/files'), '418')
  assert.equal(pullNumber('https://github.com/alexj11324/Mikka'), null)
  assert.equal(bareUrl('https://mikka-8quhtq3c9-mikka-dev.vercel.app/'), 'mikka-8quhtq3c9-mikka-dev.vercel.app')
})

test('the step playing is the last one already reached', async () => {
  const { activeStep } = await import('./evidence-view')
  const steps = [{ atMs: 0 }, { atMs: 600 }, { atMs: 1200 }]
  assert.equal(activeStep([], 500), -1)
  assert.equal(activeStep([{ atMs: 100 }], 50), -1)
  assert.equal(activeStep(steps, 0), 0)
  assert.equal(activeStep(steps, 599), 0)
  assert.equal(activeStep(steps, 600), 1)
  assert.equal(activeStep(steps, 5000), 2)
})

test('steps that share a second show tenths; the others show whole seconds', async () => {
  const { stepTime } = await import('./evidence-view')
  const steps = [{ atMs: 0 }, { atMs: 1200 }, { atMs: 1700 }, { atMs: 65_000 }]
  assert.deepEqual(steps.map((_, position) => stepTime(steps, position)), ['0:00', '0:01.2', '0:01.7', '1:05'])
})

const failedTask = (patch: Partial<AcceptanceTaskView> = {}): AcceptanceTaskView => ({
  id: 't1', issueId: 'issue-1', attemptId: 'a1', revision: 24, candidateId: 'c1', stage: 'review', status: 'failed', ...patch,
})
const retryFixture = (stage: 'review' | 'verify' = 'review') => {
  const task = failedTask({ stage })
  const detail = { task: { ...task }, checks: [check({ stage, attemptId: 'a1', status: 'failed' })] }
  const ledger = { taskId: 't1', issueId: 'issue-1', attemptId: 'a1', revision: 24, candidateId: 'c1' }
  return { task, detail, ledger }
}

test('fixed candidates stay visible for failed, pending and running checks, without widening other stages', () => {
  for (const stage of ['review', 'verify'] as const) for (const status of ['failed', 'pending', 'running'] as const) {
    assert.equal(visibleAcceptance(failedTask({ stage, status })), true)
    assert.deepEqual(candidateCheckState(failedTask({ stage, status })), { stage, status })
  }
  for (const patch of [
    { candidateId: null }, { stage: 'execute' }, { status: 'waiting' }, { status: 'passed' },
    { status: 'cancelled' }, { status: 'revoked' },
  ]) assert.equal(visibleAcceptance(failedTask(patch)), false)
  const recovery = failedTask({ completionRecovery: { binding: { taskId: 't1', revision: 24 } } })
  assert.equal(visibleAcceptance(recovery), true)
  assert.equal(candidateCheckState(recovery), null, 'host completion recovery keeps its existing presentation')
  for (const patch of [{ stage: 'approval', status: 'pending' }, { stage: 'approval', status: 'passed' }, { stage: 'publish' }]) {
    assert.equal(visibleAcceptance(failedTask(patch)), true)
    assert.equal(candidateCheckState(failedTask(patch)), null)
  }
})

test('a blocked independent check retains its fixed candidate without widening other acceptance stages', () => {
  for (const stage of ['review', 'verify'] as const) {
    const task = failedTask({ stage, status: 'blocked' })
    assert.equal(visibleAcceptance(task), true, `${stage}: a retained candidate must remain reachable`)
    assert.deepEqual(candidateCheckState(task), { stage, status: 'blocked' })
    assert.equal(visibleAcceptance({ ...task, candidateId: null }), false)
  }
  assert.equal(visibleAcceptance(failedTask({ stage: 'execute', status: 'blocked' })), false)
  const recovery = failedTask({ status: 'blocked', completionRecovery: { binding: { taskId: 't1', revision: 24 } } })
  assert.equal(visibleAcceptance(recovery), true)
  assert.equal(candidateCheckState(recovery), null, 'host completion recovery retains its own presentation')
})

test('a blocked label and matching identities alone never authorize candidate retry', () => {
  for (const stage of ['review', 'verify'] as const) {
    const { task, detail, ledger } = retryFixture(stage)
    const blocked = { ...task, status: 'blocked' }
    const blockedDetail = { ...detail, task: blocked, checks: [check({ stage, attemptId: 'a1', status: 'blocked' })] }
    assert.equal(candidateCheckRetry(blocked, blockedDetail, ledger), null,
      'visibility must not grant recovery to an unqualified blocked attempt')
    assert.equal(candidateCheckRetry(blocked, detail, ledger), null, 'an older failed detail cannot grant retry')
    const pending = { ...blocked, attemptId: 'a2', revision: 25, status: 'pending' }
    assert.equal(candidateCheckRetryConfirmed(blocked, { contractVersion: 1, task: pending,
      attempts: [{ id: 'a2', taskId: 't1', candidateId: 'c1', stage, status: 'pending' }],
      candidates: [{ id: 'c1', taskId: 't1' }] }), false)
  }
})

test('blocked start recovery requires the exact host capability and coherent current reads', () => {
  for (const stage of ['review', 'verify'] as const) {
    const { task, ledger } = retryFixture(stage)
    const blocked = { ...task, status: 'blocked' }
    const checkStartRecovery = { binding: { taskId: 't1', revision: 24 } }
    const detail = { task: blocked, checkStartRecovery, checks: [check({ stage, attemptId: 'a1', status: 'blocked' })] }
    assert.deepEqual(candidateCheckRetry(blocked, detail, ledger)?.binding, checkStartRecovery.binding)
    for (const capability of [undefined, { binding: { taskId: 'other', revision: 24 } },
      { binding: { taskId: 't1', revision: 23 } }, { binding: { taskId: 't1', revision: 25 } }])
      assert.equal(candidateCheckRetry(blocked, { ...detail, checkStartRecovery: capability }, ledger), null)
    for (const patch of [{ id: 'other' }, { issueId: 'other' }, { attemptId: 'other' }, { candidateId: 'other' },
      { revision: 23 }, { stage: stage === 'review' ? 'verify' : 'review' }, { status: 'failed' }])
      assert.equal(candidateCheckRetry(blocked, { ...detail, task: { ...blocked, ...patch } }, ledger), null)
    assert.equal(candidateCheckRetry(blocked, detail, { ...ledger, attemptId: 'older' }), null)
    assert.equal(candidateCheckRetry(blocked, { ...detail, checks: [check({ stage, attemptId: 'a1', status: 'failed' })] }, ledger), null)
    assert.equal(candidateCheckRetry(blocked, { ...detail, checks: [...detail.checks, check({ stage, attemptId: 'a2', status: 'pending' })] }, ledger), null)
    assert.equal(candidateCheckRetry(blocked, { ...detail, completionRecovery: checkStartRecovery }, ledger), null)
  }
})

test('host-qualified start recovery confirms only its same-candidate bound running receipt', () => {
  for (const stage of ['review', 'verify'] as const) {
    const task = failedTask({ stage, status: 'blocked' })
    const capability = { binding: { taskId: 't1', revision: 24 } }
    const next = { ...task, revision: 26, attemptId: 'a2', status: 'running' }
    const attempt = { id: 'a2', taskId: 't1', candidateId: 'c1', stage, status: 'running', runId: 'new-check-run' }
    const receipt = { contractVersion: 1, task: next, attempts: [attempt], candidates: [{ id: 'c1', taskId: 't1' }] }
    assert.equal(candidateCheckRetryConfirmed(task, receipt, capability), true)
    assert.equal(candidateCheckRetryConfirmed(task, receipt), false)
    assert.equal(candidateCheckRetryConfirmed(task, receipt, { binding: { taskId: 'other', revision: 24 } }), false)
    assert.equal(candidateCheckRetryConfirmed(task, receipt, { binding: { taskId: 't1', revision: 23 } }), false)
    for (const patch of [{ id: 'other' }, { issueId: 'other' }, { candidateId: 'other' }, { stage: 'execute' },
      { status: 'pending' }, { revision: 25 }, { revision: 27 }, { attemptId: 'a1' }])
      assert.equal(candidateCheckRetryConfirmed(task, { ...receipt, task: { ...next, ...patch } }, capability), false)
    for (const patch of [{ id: 'other' }, { taskId: 'other' }, { candidateId: 'other' }, { stage: 'execute' },
      { status: 'pending' }, { runId: null }, { runId: '' }])
      assert.equal(candidateCheckRetryConfirmed(task, { ...receipt, attempts: [{ ...attempt, ...patch }] }, capability), false)
    const pending = { ...next, revision: 25, status: 'pending' }
    assert.equal(candidateCheckRetryConfirmed(task, { ...receipt, task: pending,
      attempts: [{ ...attempt, status: 'pending', runId: null }] }, capability), false, 'retry without a bound run is not a completed start recovery')
    assert.equal(candidateCheckRetryConfirmed({ ...task, stage: 'execute' }, receipt, capability), false)
    assert.equal(candidateCheckRetryConfirmed({ ...task, completionRecovery: capability }, receipt, capability), false)
  }
})

test('candidate retry returns only the existing revision binding for one exact failed attempt', () => {
  for (const stage of ['review', 'verify'] as const) {
    const { task, detail, ledger } = retryFixture(stage)
    const retry = candidateCheckRetry(task, detail, ledger)
    assert.equal(retry?.stage, stage)
    assert.deepEqual(retry?.binding, { taskId: 't1', revision: 24 })
    assert.equal(retry?.key, JSON.stringify(['t1', 'issue-1', 'a1', 'c1', 24]))
  }
})

test('an unsubmitted review uses its distinct host capability and confirms a fresh same-candidate checker', () => {
  const { task, ledger } = retryFixture()
  const blocked = { ...task, status: 'blocked', route: { flowVersion: 2 } }
  const capability = { binding: { taskId: 't1', revision: 24 } }
  const latest = check({ stage: 'review', attemptId: 'a1', status: 'blocked', runId: 'ended-check-run' })
  const detail = { task: blocked, checkSubmissionRecovery: capability, checks: [latest] }
  assert.deepEqual(candidateCheckRetry(blocked, detail, ledger)?.binding, capability.binding)
  for (const patch of [
    { checkSubmissionRecovery: undefined }, { checkSubmissionRecovery: { binding: { taskId: 'other', revision: 24 } } },
    { checkSubmissionRecovery: { binding: { taskId: 't1', revision: 23 } } }, { checkStartRecovery: capability },
    { checkDispatchRecovery: capability }, { checks: [{ ...latest, runId: null }] },
  ]) assert.equal(candidateCheckRetry(blocked, { ...detail, ...patch }, ledger), null)
  assert.equal(candidateCheckRetry(blocked, detail, { ...ledger, attemptId: 'old' }), null)
  const next = { ...blocked, revision: 26, attemptId: 'a2', status: 'running' }
  const attempt = { id: 'a2', taskId: 't1', candidateId: 'c1', stage: 'review', status: 'running', runId: 'new-independent-run' }
  const receipt = { contractVersion: 1, task: next, attempts: [attempt], candidates: [{ id: 'c1', taskId: 't1' }] }
  assert.equal(candidateCheckRetryConfirmed(blocked, receipt, undefined, undefined, capability), true)
  assert.equal(candidateCheckRetryConfirmed(blocked, receipt), false)
  assert.equal(candidateCheckRetryConfirmed(blocked, receipt, capability, undefined, capability), false)
  assert.equal(candidateCheckRetryConfirmed(blocked, { ...receipt, attempts: [{ ...attempt, runId: null }] }, undefined, undefined, capability), false)
  assert.equal(candidateCheckRetryConfirmed(blocked, { ...receipt, task: { ...next, candidateId: 'other' } }, undefined, undefined, capability), false)
  const verdict = { ...blocked, status: 'failed' }
  assert.equal(candidateCheckRetry(verdict, { task: verdict, checks: [{ ...latest, status: 'failed' }] }, ledger), null,
    'an actual v2 review verdict still cannot receive another review')
})

test('an explicit single-review flow never offers the rejected generic failed-review retry', () => {
  for (const stage of ['review', 'verify'] as const) {
    const { task, detail, ledger } = retryFixture(stage)
    const singleReview = { ...task, route: { flowVersion: 2 } }
    const retry = candidateCheckRetry(task, { ...detail, task: singleReview }, ledger)
    if (stage === 'review') assert.equal(retry, null, 'canonical flow v2 has already consumed its bound review')
    else assert.ok(retry, 'the verification path keeps its existing retry')
    for (const route of [undefined, { flowVersion: 1 }]) {
      const legacy = { ...task, route }
      assert.ok(candidateCheckRetry(task, { ...detail, task: legacy }, ledger), 'missing or legacy flow remains unchanged')
    }
  }
})

test('stale or incomplete list, detail, ledger and latest-check identities cannot expose retry', () => {
  const { task, detail, ledger } = retryFixture()
  for (const patch of [
    { id: 'other' }, { issueId: 'other' }, { attemptId: 'other' }, { candidateId: 'other' },
    { revision: 23 }, { revision: 25 }, { status: 'pending' }, { stage: 'verify' },
  ]) assert.equal(candidateCheckRetry(task, { ...detail, task: { ...detail.task, ...patch } }, ledger), null)
  for (const patch of [
    { taskId: 'other' }, { issueId: 'other' }, { attemptId: 'other' }, { candidateId: 'other' },
    { revision: 23 }, { revision: 25 },
  ]) assert.equal(candidateCheckRetry(task, detail, { ...ledger, ...patch }), null)
  for (const patch of [
    { id: undefined }, { issueId: undefined }, { attemptId: undefined }, { revision: undefined },
    { revision: Number.NaN }, { revision: -1 }, { candidateId: null }, { status: 'running' },
  ]) assert.equal(candidateCheckRetry({ ...task, ...patch }, detail, ledger), null)
  assert.equal(candidateCheckRetry(task, undefined, ledger), null)
  assert.equal(candidateCheckRetry(task, detail, undefined), null)
  assert.equal(candidateCheckRetry(task, { ...detail, checks: [] }, ledger), null)
  assert.equal(candidateCheckRetry(task, { ...detail, completionRecovery: { binding: { taskId: 't1', revision: 24 } } }, ledger), null)
  const pending = check({ stage: 'review', attemptId: 'a2', status: 'pending', runId: null })
  assert.equal(candidateCheckRetry(task, { ...detail, checks: [...detail.checks, pending] }, ledger), null,
    'a newer undispatched attempt must not fall back to the old failed run')
  assert.equal(candidateCheckRetry(task, { ...detail, checks: [check({ stage: 'review', attemptId: 'a1', status: 'failed', candidateId: 'other' })] }, ledger), null)
})

test('retry confirmation requires the canonical same-candidate pending transition', () => {
  for (const stage of ['review', 'verify']) {
    const task = { id: 't1', issueId: 'issue-1', attemptId: 'check-24', candidateId: 'c1', revision: 24, stage, status: 'failed' }
    const next = { ...task, attemptId: 'check-25', revision: 25, status: 'pending' }
    const attempt = { id: next.attemptId, taskId: task.id, candidateId: task.candidateId, stage, status: 'pending' }
    const receipt = { contractVersion: 1, task: next, attempts: [attempt], candidates: [{ id: task.candidateId, taskId: task.id }] }
    assert.equal(candidateCheckRetryConfirmed(task, receipt), true)
    for (const value of [null, [], 'html', {}, { ...receipt, contractVersion: 2 }, { ...receipt, attempts: undefined },
      { ...receipt, candidates: undefined }, { ...receipt, attempts: [] }, { ...receipt, task },
      { ...receipt, attempts: [{ ...attempt, taskId: 'other' }] }])
      assert.equal(candidateCheckRetryConfirmed(task, value), false)
    for (const patch of [{ id: 'other' }, { issueId: 'other' }, { candidateId: 'other' }, { stage: 'execute' },
      { status: 'running' }, { revision: 26 }, { revision: 24 }, { attemptId: task.attemptId }, { attemptId: '' }])
      assert.equal(candidateCheckRetryConfirmed(task, { ...receipt, task: { ...next, ...patch } }), false)
  }
})

test('host-qualified dispatch retry requires the same blocked attempt with no Run', () => {
  for (const stage of ['review', 'verify'] as const) {
    const { task, ledger } = retryFixture(stage)
    const blocked = { ...task, status: 'blocked', route: { flowVersion: 2 } }
    const capability = { binding: { taskId: 't1', revision: 24 } }
    const latest = check({ stage, attemptId: 'a1', status: 'blocked', runId: null })
    const detail = { task: blocked, checkDispatchRecovery: capability, checks: [latest] }
    assert.deepEqual(candidateCheckRetry(blocked, detail, ledger)?.binding, capability.binding)
    for (const checkDispatchRecovery of [undefined, { binding: { taskId: 'other', revision: 24 } },
      { binding: { taskId: 't1', revision: 23 } }, { binding: { taskId: 't1', revision: 25 } }])
      assert.equal(candidateCheckRetry(blocked, { ...detail, checkDispatchRecovery }, ledger), null)
    for (const patch of [{ id: 'other' }, { issueId: 'other' }, { attemptId: 'other' }, { candidateId: 'other' },
      { revision: 23 }, { stage: stage === 'review' ? 'verify' : 'review' }, { status: 'failed' }])
      assert.equal(candidateCheckRetry(blocked, { ...detail, task: { ...blocked, ...patch } }, ledger), null)
    assert.equal(candidateCheckRetry(blocked, detail, { ...ledger, attemptId: 'older' }), null)
    assert.equal(candidateCheckRetry(blocked, { ...detail, checks: [{ ...latest, runId: 'existing-run' }] }, ledger), null,
      'a dispatch capability must never be reused for an existing Run')
    assert.equal(candidateCheckRetry(blocked, { ...detail, checks: [{ ...latest, status: 'failed' }] }, ledger), null)
    assert.equal(candidateCheckRetry(blocked, { ...detail, checks: [...detail.checks, { ...latest, attemptId: 'newer' }] }, ledger), null)
    assert.equal(candidateCheckRetry(blocked, { ...detail, completionRecovery: capability }, ledger), null)
    assert.equal(candidateCheckRetry(blocked, { ...detail, checkStartRecovery: capability }, ledger), null,
      'conflicting recovery capabilities are not a safe retry signal')
  }
})

test('dispatch recovery confirms only the same candidate queued without a Run at revision plus one', () => {
  for (const stage of ['review', 'verify'] as const) {
    const task = failedTask({ stage, status: 'blocked' })
    const capability = { binding: { taskId: 't1', revision: 24 } }
    const next = { ...task, revision: 25, attemptId: 'a2', status: 'pending' }
    const attempt = { id: 'a2', taskId: 't1', candidateId: 'c1', stage, status: 'pending', runId: null }
    const receipt = { contractVersion: 1, task: next, attempts: [attempt], candidates: [{ id: 'c1', taskId: 't1' }] }
    assert.equal(candidateCheckRetryConfirmed(task, receipt, undefined, capability), true)
    assert.equal(candidateCheckRetryConfirmed(task, receipt), false)
    assert.equal(candidateCheckRetryConfirmed(task, receipt, capability), false,
      'ordinary dispatch retry is distinct from recovery of a frozen Run')
    assert.equal(candidateCheckRetryConfirmed(task, receipt, capability, capability), false)
    assert.equal(candidateCheckRetryConfirmed(task, receipt, undefined, { binding: { taskId: 'other', revision: 24 } }), false)
    assert.equal(candidateCheckRetryConfirmed(task, receipt, undefined, { binding: { taskId: 't1', revision: 23 } }), false)
    for (const patch of [{ id: 'other' }, { issueId: 'other' }, { candidateId: 'other' }, { stage: 'execute' },
      { status: 'running' }, { revision: 24 }, { revision: 26 }, { attemptId: 'a1' }])
      assert.equal(candidateCheckRetryConfirmed(task, { ...receipt, task: { ...next, ...patch } }, undefined, capability), false)
    for (const patch of [{ id: 'other' }, { taskId: 'other' }, { candidateId: 'other' }, { stage: 'execute' },
      { status: 'running' }, { runId: 'unexpected-run' }, { runId: undefined }])
      assert.equal(candidateCheckRetryConfirmed(task, { ...receipt, attempts: [{ ...attempt, ...patch }] }, undefined, capability), false)
    assert.equal(candidateCheckRetryConfirmed({ ...task, stage: 'execute' }, receipt, undefined, capability), false)
    assert.equal(candidateCheckRetryConfirmed({ ...task, completionRecovery: capability }, receipt, undefined, capability), false)
  }
})
