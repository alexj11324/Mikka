import assert from 'node:assert/strict'
import test from 'node:test'
import { renewalIdleCounts } from './renew-github-expiry.mjs'

const idle = () => ({ activeRuns: '0', pendingFactoryTasks: '0', pendingSubagents: '0', coordinatorLeases: '0',
  pendingPublications: '0', pendingMerges: '0', activeThreadMachines: '0', activeCloudMachines: '0' })
const rejected = value => assert.throws(() => renewalIdleCounts(value), /issue1503_github_renewal_fixture_work_active/)

test('same-child renewal requires both machine counts to be zero', () => {
  assert.deepEqual(Object.values(renewalIdleCounts(idle())), Array(8).fill(0))
  for (const key of ['activeThreadMachines', 'activeCloudMachines']) {
    rejected({ ...idle(), [key]: '1' })
  }
})

test('same-child renewal refuses a partial or unexpected activity projection', () => {
  for (const key of Object.keys(idle())) {
    const partial = idle()
    delete partial[key]
    rejected(partial)
  }
  rejected({ ...idle(), unknown: '0' })
  rejected(undefined)
  rejected({ ...idle(), activeThreadMachines: 'NaN' })
})
