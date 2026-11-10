import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appCallAllowed, appPermissionKeys, appPermissionValue, withAppPermission } from './app-permission-keys'

test('only an explicit deny withholds an app call; ask stays callable where no card exists', () => {
  assert.equal(appCallAllowed('allow'), true)
  assert.equal(appCallAllowed('ask'), true)
  assert.equal(appCallAllowed(null), true)
  assert.equal(appCallAllowed(undefined), true)
  assert.equal(appCallAllowed('deny'), false)
})

test('an app key and its legacy write action carry the same choice', () => {
  assert.deepEqual(appPermissionKeys('slack'), ['slack', 'send_slack_message'])
  assert.deepEqual(appPermissionKeys('hubspot'), ['hubspot'])
  assert.equal(appPermissionValue({ slack: 'ask', send_slack_message: 'allow' }, 'slack'), 'ask')
  assert.equal(appPermissionValue({ send_slack_message: 'deny' }, 'slack'), 'deny')
  assert.equal(appPermissionValue({ slack: 'maybe' }, 'slack'), undefined)
})

test('saving one app choice updates both keys and default removes both', () => {
  const saved = withAppPermission({ slack: 'allow', hubspot: 'deny' }, 'slack', 'ask')
  assert.deepEqual(saved, { slack: 'ask', send_slack_message: 'ask', hubspot: 'deny' })
  assert.deepEqual(withAppPermission(saved, 'slack', null), { hubspot: 'deny' })
  assert.deepEqual(withAppPermission({}, 'hubspot', 'deny'), { hubspot: 'deny' })
})
