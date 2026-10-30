import assert from 'node:assert/strict'
import test from 'node:test'
import { SETTINGS_SECTIONS, isSettingsSectionParam, resolveSettingsSection, settingsHref, visibleSettingsSections } from '../lib/settings-sections.ts'

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

const UNBUILT = ['developer', 'secrets', 'audit', 'usage', 'billing']

test('members do not see admin-only sections; admins see every built one', () => {
  const member = visibleSettingsSections({ admin: false }).map(s => s.id)
  assert.equal(member.includes('permissions'), false)
  for (const id of ['general', 'members', 'teams', 'computers']) assert.equal(member.includes(id), true, id)
  assert.deepEqual(visibleSettingsSections({ admin: true }).map(s => s.id), SETTINGS_SECTIONS.filter(s => !UNBUILT.includes(s.id)).map(s => s.id))
})

test('sections without a page body are hidden until their UI lands, and their links open preferences', () => {
  assert.deepEqual(SETTINGS_SECTIONS.filter(s => s.unbuilt).map(s => s.id), UNBUILT)
  for (const admin of [false, true]) for (const id of UNBUILT) assert.equal(visibleSettingsSections({ admin }).some(s => s.id === id), false, `${id} admin=${admin}`)
  for (const id of UNBUILT) {
    assert.equal(resolveSettingsSection('/settings', id), 'preferences', id)
    assert.equal(isSettingsSectionParam(id), true, `${id} is still a known link`)
  }
})

test('Bot 管理 has its page (docs/design/bot-settings.md): shown to members and admins, its links open it', () => {
  for (const admin of [false, true]) assert.equal(visibleSettingsSections({ admin }).some(s => s.id === 'bots'), true, `admin=${admin}`)
  assert.equal(resolveSettingsSection('/settings', 'bots'), 'bots')
})

test('sidebar names follow Figma 设置 v4 in the English search titles', () => {
  const title = id => SETTINGS_SECTIONS.find(s => s.id === id).title
  assert.deepEqual(['computers', 'developer', 'permissions', 'logins'].map(title), ['Devices', 'Personal access tokens', 'Team permissions', 'Logins and keys'])
})

test('a current id wins over a legacy alias with the same name', () => {
  assert.equal(resolveSettingsSection('/settings', 'account'), 'account')
  assert.equal(resolveSettingsSection('/settings', 'profile'), 'account')
})
