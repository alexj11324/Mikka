import assert from 'node:assert/strict'
import test from 'node:test'
import { threadMachineLimits, threadMachineViolation } from './thread-machine-limits'

test('defaults cap one owner at three running machines, a workspace at twenty and sixty compute hours a month', () => {
  assert.deepEqual(threadMachineLimits({}), { perOwner: 3, perWorkspace: 20, monthlyComputeHours: 60 })
})

test('settings override the defaults, but zero, negative and non-integer values cannot disable a cap', () => {
  assert.deepEqual(
    threadMachineLimits({ MIKKA_THREAD_MACHINES_PER_OWNER: '5', MIKKA_THREAD_MACHINES_PER_WORKSPACE: '50', MIKKA_THREAD_MACHINE_MONTHLY_COMPUTE_HOURS: '120' }),
    { perOwner: 5, perWorkspace: 50, monthlyComputeHours: 120 },
  )
  for (const value of ['0', '-1', '1.5', 'many', '']) {
    assert.deepEqual(
      threadMachineLimits({ MIKKA_THREAD_MACHINES_PER_OWNER: value, MIKKA_THREAD_MACHINES_PER_WORKSPACE: value, MIKKA_THREAD_MACHINE_MONTHLY_COMPUTE_HOURS: value }),
      { perOwner: 3, perWorkspace: 20, monthlyComputeHours: 60 },
      value,
    )
  }
})

test('the first exhausted limit blocks provisioning and the check is inclusive', () => {
  const limits = { perOwner: 2, perWorkspace: 5, monthlyComputeHours: 10 }
  const usage = { ownerActive: 0, workspaceActive: 0, ownerComputeHours: 0 }
  assert.equal(threadMachineViolation(usage, limits), null)
  assert.equal(threadMachineViolation({ ...usage, ownerActive: 1 }, limits), null)
  assert.equal(threadMachineViolation({ ...usage, ownerActive: 2 }, limits), 'owner')
  assert.equal(threadMachineViolation({ ...usage, ownerActive: 2, workspaceActive: 2, ownerComputeHours: 1 }, limits), 'owner')
  assert.equal(threadMachineViolation({ ...usage, workspaceActive: 5, ownerComputeHours: 1 }, limits), 'workspace')
  assert.equal(threadMachineViolation({ ...usage, workspaceActive: 4, ownerComputeHours: 9.99 }, limits), null)
  assert.equal(threadMachineViolation({ ...usage, workspaceActive: 4, ownerComputeHours: 10 }, limits), 'budget')
})
