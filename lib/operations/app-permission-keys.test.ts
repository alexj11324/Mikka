import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WRITE_ACTIONS } from './write-schema'
import { WRITE_TOOL_APPS } from '@/lib/app-policy/apps'
import { appCallAllowed, appCallSettingKeys, appPermissionKeys, appPermissionValue, withAppPermission, withAppPermissions } from './app-permission-keys'

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

test('one save covers every selected app, and a page save carries both keys', () => {
  assert.deepEqual(withAppPermissions({ gmail: 'ask' }, ['slack', 'notion'], 'deny'),
    { gmail: 'ask', slack: 'deny', send_slack_message: 'deny', notion: 'deny', append_notion_paragraph: 'deny' })
  assert.deepEqual(withAppPermissions({ slack: 'deny', send_slack_message: 'deny' }, ['slack'], null), {})
})

test('a tool call consults its own slug and its app keys, with no duplicates', () => {
  assert.deepEqual(appCallSettingKeys('slack_send_message', 'slack'), ['slack_send_message', 'slack', 'send_slack_message'])
  assert.deepEqual(appCallSettingKeys('hubspot_create_contact', 'hubspot'), ['hubspot_create_contact', 'hubspot'])
})

test('every first-class write action is governed by its app key', () => {
  // A future action added to WRITE_ACTIONS must also be reachable from the workspace page.
  for (const action of WRITE_ACTIONS) {
    const app = WRITE_TOOL_APPS[action]
    assert.equal(typeof app, 'string', action)
    assert.deepEqual(appPermissionKeys(app), [app, action], action)
    assert.deepEqual(withAppPermissions({}, [app], 'deny'), { [app]: 'deny', [action]: 'deny' }, action)
  }
})
