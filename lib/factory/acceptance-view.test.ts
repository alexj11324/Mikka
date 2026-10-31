import assert from 'node:assert/strict'
import test from 'node:test'
import { bareUrl, criterionGroups, pullNumber, resultRows, type AcceptanceCheck } from './acceptance-view'
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
