import assert from 'node:assert/strict'
import test from 'node:test'
import { SETTINGS_SECTIONS, resolveSettingsSection, settingsHref, visibleSettingsSections } from '../lib/settings-sections.ts'

test('every v4 nav item has exactly one section, in Figma order', () => {
  assert.deepEqual(SETTINGS_SECTIONS.filter(s => s.group === 'personal').map(s => s.id), ['account', 'security', 'preferences', 'notifications', 'memory', 'connections', 'models', 'logins', 'privacy', 'activity', 'computers', 'developer'])
  assert.deepEqual(SETTINGS_SECTIONS.filter(s => s.group === 'workspace').map(s => s.id), ['general', 'members', 'teams', 'bots', 'permissions', 'secrets', 'audit', 'usage', 'billing'])
})

test('old links keep landing on the page that now holds their content', () => {
  // v4 reuses `account` for 账户, so v3's account link lands there; its sign-in rows are one click away under 安全.
  for (const [old, now] of [['profile', 'account'], ['integrations', 'connections'], ['devices', 'computers'], ['workspace', 'general']]) {
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
  for (const id of ['general', 'members', 'teams']) assert.equal(member.includes(id), true, id)
  assert.equal(visibleSettingsSections({ admin: true }).length, SETTINGS_SECTIONS.filter(s => !s.placeholder).length)
  assert.equal(visibleSettingsSections({ admin: true }).some(s => s.id === 'permissions'), true)
})

test('sections that are not built yet stay out of the nav but still resolve', () => {
  const shown = visibleSettingsSections({ admin: true }).map(s => s.id)
  for (const id of ['developer', 'bots', 'secrets', 'audit', 'usage', 'billing']) {
    assert.equal(shown.includes(id), false, id)
    assert.equal(resolveSettingsSection('/settings', id), id)
  }
})

test('a current id wins over a legacy alias with the same name', () => {
  assert.equal(resolveSettingsSection('/settings', 'account'), 'account')
  assert.equal(resolveSettingsSection('/settings', 'profile'), 'account')
})
