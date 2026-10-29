import assert from 'node:assert/strict'
import test from 'node:test'
import { SETTINGS_SECTIONS, resolveSettingsSection, settingsHref, visibleSettingsSections } from '../lib/settings-sections.ts'

test('every v4 nav item has exactly one section, in Figma order', () => {
  assert.deepEqual(SETTINGS_SECTIONS.filter(s => s.group === 'personal').map(s => s.id), ['account', 'security', 'preferences', 'notifications', 'memory', 'connections', 'models', 'logins', 'privacy', 'activity', 'computers', 'developer'])
  assert.deepEqual(SETTINGS_SECTIONS.filter(s => s.group === 'workspace').map(s => s.id), ['general', 'members', 'teams', 'bots', 'permissions', 'secrets', 'audit', 'usage', 'billing'])
})

test('old links keep landing on the page that now holds their content', () => {
  for (const [old, now] of [['profile', 'account'], ['account', 'security'], ['integrations', 'connections'], ['devices', 'computers'], ['workspace', 'general']]) {
    assert.equal(resolveSettingsSection('/settings', old), now, old)
  }
})

test('routed pages win over the query, and unknown input falls back to preferences', () => {
  assert.equal(resolveSettingsSection('/settings/members', 'security'), 'members')
  assert.equal(resolveSettingsSection('/settings/teams', null), 'teams')
  assert.equal(resolveSettingsSection('/settings', 'nope'), 'preferences')
  assert.equal(resolveSettingsSection('/settings', null), 'preferences')
  assert.equal(resolveSettingsSection('/settings', 'notifications'), 'notifications')
})

test('hrefs keep the workspace and use the routed paths for members and teams', () => {
  assert.equal(settingsHref('security', 'w1'), '/settings?workspace=w1&section=security')
  assert.equal(settingsHref('members', 'w1'), '/settings/members?workspace=w1')
  assert.equal(settingsHref('preferences'), '/settings?section=preferences')
})

test('members do not see admin-only sections; admins see all of them', () => {
  const member = visibleSettingsSections({ admin: false }).map(s => s.id)
  for (const id of ['permissions', 'secrets', 'audit', 'billing']) assert.equal(member.includes(id), false, id)
  for (const id of ['general', 'members', 'teams', 'bots', 'usage']) assert.equal(member.includes(id), true, id)
  assert.equal(visibleSettingsSections({ admin: true }).length, SETTINGS_SECTIONS.length)
})
