import assert from 'node:assert/strict'
import test from 'node:test'
import { SETTINGS_SECTIONS, isSettingsSectionParam, resolveSettingsSection, settingsHref, visibleSettingsSections } from '../lib/settings-sections.ts'

test('every v4 nav item has exactly one section, in Figma order', () => {
  assert.deepEqual(SETTINGS_SECTIONS.filter(s => s.group === 'personal').map(s => s.id), ['account', 'security', 'preferences', 'notifications', 'memory', 'connections', 'models', 'logins', 'privacy', 'computers', 'developer'])
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

const UNBUILT = ['developer']

test('members do not see admin-only sections; admins see every built one', () => {
  const member = visibleSettingsSections({ admin: false }).map(s => s.id)
  assert.equal(member.includes('permissions'), false)
  // 计费: members see 付款 only (their card designation and credit share; C19).
  for (const id of ['general', 'members', 'teams', 'computers', 'usage', 'billing']) assert.equal(member.includes(id), true, id)
  for (const id of ['secrets', 'audit']) assert.equal(member.includes(id), false, id)
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

test('sidebar names follow Figma 设置 v4 in the English search titles', () => {
  const title = id => SETTINGS_SECTIONS.find(s => s.id === id).title
  assert.deepEqual(['computers', 'developer', 'permissions', 'logins'].map(title), ['Devices', 'Personal access tokens', 'Team permissions', 'Logins and keys'])
})

test('a current id wins over a legacy alias with the same name', () => {
  assert.equal(resolveSettingsSection('/settings', 'account'), 'account')
  assert.equal(resolveSettingsSection('/settings', 'profile'), 'account')
})

test('a personal workspace hides 成员, 团队权限 and 审计日志; a team workspace keeps them', () => {
  // Decision 2026-10-31-2130: a personal workspace has exactly one member.
  const personal = visibleSettingsSections({ admin: true, personal: true }).map(s => s.id)
  for (const id of ['members', 'permissions', 'audit']) assert.equal(personal.includes(id), false, id)
  for (const id of ['account', 'models', 'general', 'bots', 'usage', 'billing']) assert.ok(personal.includes(id), id)
  const team = visibleSettingsSections({ admin: true }).map(s => s.id)
  for (const id of ['members', 'permissions', 'audit']) assert.ok(team.includes(id), id)
})
