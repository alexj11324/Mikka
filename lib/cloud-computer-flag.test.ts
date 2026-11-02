import assert from 'node:assert/strict'
import test from 'node:test'
import { byosEnabled, byosEnrollmentEnabled, cloudComputerRunsEnabled, cloudComputerTasksEnabled } from './cloud-computer-flag'

test('cloud computer tasks are on unless the kill switch is exactly 0', () => {
  assert.equal(cloudComputerTasksEnabled({}), true)
  assert.equal(cloudComputerTasksEnabled({ MIKKA_CLOUD_COMPUTER_TASKS: '1' }), true)
  assert.equal(cloudComputerTasksEnabled({ MIKKA_CLOUD_COMPUTER_TASKS: 'false' }), true)
  assert.equal(cloudComputerTasksEnabled({ MIKKA_CLOUD_COMPUTER_TASKS: '0' }), false)
})

test('BYOS and BYOS enrollment are on only when set to exactly 1', () => {
  for (const value of [undefined, '', '0', 'true', 'TRUE', ' 1', 'yes']) {
    assert.equal(byosEnabled({ MIKKA_BYOS_ENABLED: value }), false, `MIKKA_BYOS_ENABLED=${value}`)
    assert.equal(byosEnrollmentEnabled({ MIKKA_BYOS_ENROLLMENT_ENABLED: value }), false, `MIKKA_BYOS_ENROLLMENT_ENABLED=${value}`)
  }
  assert.equal(byosEnabled({ MIKKA_BYOS_ENABLED: '1' }), true)
  assert.equal(byosEnrollmentEnabled({ MIKKA_BYOS_ENROLLMENT_ENABLED: '1' }), true)
  // Each reads only its own variable.
  assert.equal(byosEnabled({ MIKKA_BYOS_ENROLLMENT_ENABLED: '1' }), false)
  assert.equal(byosEnrollmentEnabled({ MIKKA_BYOS_ENABLED: '1' }), false)
})

test('cloud computer runs need the tasks switch not killed and BYOS on', () => {
  for (const tasks of [undefined, '1', '0']) for (const byos of [undefined, '1', '0']) {
    const env = { MIKKA_CLOUD_COMPUTER_TASKS: tasks, MIKKA_BYOS_ENABLED: byos }
    assert.equal(cloudComputerRunsEnabled(env), tasks !== '0' && byos === '1', JSON.stringify(env))
  }
})

test('the default reads process.env at call time', () => {
  const saved = { tasks: process.env.MIKKA_CLOUD_COMPUTER_TASKS, byos: process.env.MIKKA_BYOS_ENABLED, enrollment: process.env.MIKKA_BYOS_ENROLLMENT_ENABLED }
  try {
    process.env.MIKKA_CLOUD_COMPUTER_TASKS = '1'; process.env.MIKKA_BYOS_ENABLED = '1'; process.env.MIKKA_BYOS_ENROLLMENT_ENABLED = '1'
    assert.equal(cloudComputerRunsEnabled(), true)
    assert.equal(byosEnrollmentEnabled(), true)
    process.env.MIKKA_CLOUD_COMPUTER_TASKS = '0'
    assert.equal(cloudComputerRunsEnabled(), false)
    assert.equal(byosEnabled(), true)
    process.env.MIKKA_BYOS_ENROLLMENT_ENABLED = '0'
    assert.equal(byosEnrollmentEnabled(), false)
  } finally {
    for (const [name, value] of [['MIKKA_CLOUD_COMPUTER_TASKS', saved.tasks], ['MIKKA_BYOS_ENABLED', saved.byos], ['MIKKA_BYOS_ENROLLMENT_ENABLED', saved.enrollment]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value
    }
  }
})
