import assert from 'node:assert/strict'
import test from 'node:test'
import { SETTINGS_SECTIONS, isSettingsSectionParam, resolveSettingsSection, settingsHref, visibleSettingsSections } from '../lib/settings-sections.ts'

test('every nav item has exactly one section, in the Figma 1508:2 group order', () => {
  assert.deepEqual(SETTINGS_SECTIONS.filter(s => s.group === 'personal' && !s.withheld && !s.unbuilt && s.sidebar !== false).map(s => s.id), ['preferences', 'appearance', 'account', 'security', 'notifications', 'models', 'environments', 'connections', 'developer', 'computers'])
  assert.deepEqual(SETTINGS_SECTIONS.filter(s => s.group === 'agent' && !s.unbuilt).map(s => s.id), ['instructions', 'threads'])
  assert.deepEqual(SETTINGS_SECTIONS.filter(s => s.group === 'review' && !s.unbuilt).map(s => s.id), [])
  assert.deepEqual(SETTINGS_SECTIONS.filter(s => s.group === 'workspace' && !s.unbuilt && s.sidebar !== false).map(s => s.id), ['general', 'organization', 'issue-states', 'members', 'teams', 'billing', 'usage', 'audit', 'cloud'])
})

test('old links keep landing on the page that now holds their content', () => {
  for (const [old, now] of [['profile', 'account'], ['integrations', 'connections'], ['devices', 'computers'], ['workspace', 'general'], ['memory', 'instructions'], ['privacy', 'account'], ['bot-permissions', 'computers']]) {
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

const UNBUILT = ['shortcuts', 'git', 'review-repositories', 'review-config', 'activity']
const WITHHELD = ['referrals', 'experiments', 'cloud-credentials']
const SIDEBAR_OFF = ['logins', 'secrets', 'permissions']

test('members do not see admin-only sections; admins see every built one', () => {
  const member = visibleSettingsSections({ admin: false }).map(s => s.id)
  assert.equal(member.includes('permissions'), false)
  // 计费: members see 付款 only (their card designation and credit share; C19).
  // 密钥与环境: members see every entry and write repository ones (decision 2026-11-02-2120).
  for (const id of ['general', 'members', 'teams', 'computers', 'usage', 'billing', 'environments']) assert.equal(member.includes(id), true, id)
  for (const id of SIDEBAR_OFF) assert.equal(member.includes(id), false, id)
  for (const id of ['audit']) assert.equal(member.includes(id), false, id)
  assert.deepEqual(visibleSettingsSections({ admin: true }).map(s => s.id), SETTINGS_SECTIONS.filter(s => !UNBUILT.includes(s.id) && !WITHHELD.includes(s.id) && !SIDEBAR_OFF.includes(s.id) && s.id !== 'cloud').map(s => s.id))
})

test('cloud server settings require the explicit server administrator capability', () => {
  for (const admin of [false, true]) {
    assert.equal(visibleSettingsSections({ admin }).some(s => s.id === 'cloud'), false)
    assert.equal(visibleSettingsSections({ admin, cloudAdmin: false }).some(s => s.id === 'cloud'), false)
    assert.equal(visibleSettingsSections({ admin, cloudAdmin: true }).some(s => s.id === 'cloud'), true)
  }
  assert.deepEqual(visibleSettingsSections({ admin: true, cloudAdmin: true }).map(s => s.id), SETTINGS_SECTIONS.filter(s => !UNBUILT.includes(s.id) && !WITHHELD.includes(s.id) && !SIDEBAR_OFF.includes(s.id)).map(s => s.id))
})

test('身份与访问 is in the public team sidebar; a personal workspace has no organization', () => {
  for (const admin of [false, true]) {
    assert.equal(visibleSettingsSections({ admin }).some(s => s.id === 'organization'), true)
    assert.equal(visibleSettingsSections({ admin, personal: true }).some(s => s.id === 'organization'), false)
    assert.equal(visibleSettingsSections({ admin, organization: true, personal: true }).some(s => s.id === 'organization'), false)
  }
  assert.equal(visibleSettingsSections({ admin: true, organization: true }).some(s => s.id === 'organization'), true)
  const personalMember = visibleSettingsSections({ admin: false, organization: true, personal: true }).map(s => s.id)
  for (const teamOnly of ['organization', 'members', 'teams', 'permissions', 'audit']) assert.equal(personalMember.includes(teamOnly), false, teamOnly)
  assert.deepEqual(visibleSettingsSections({ admin: true, cloudAdmin: true, organization: true }).map(s => s.id), SETTINGS_SECTIONS.filter(s => !UNBUILT.includes(s.id) && !WITHHELD.includes(s.id) && !SIDEBAR_OFF.includes(s.id)).map(s => s.id))
})

test('sections without a page body are hidden until their UI lands, and their links open preferences', () => {
  assert.deepEqual(SETTINGS_SECTIONS.filter(s => s.unbuilt).map(s => s.id), UNBUILT)
  for (const admin of [false, true]) for (const id of UNBUILT) assert.equal(visibleSettingsSections({ admin }).some(s => s.id === id), false, `${id} admin=${admin}`)
  for (const id of UNBUILT) {
    assert.equal(resolveSettingsSection('/settings', id), 'preferences', id)
    assert.equal(isSettingsSectionParam(id), true, `${id} is still a known link`)
  }
})

test('withheld pages are not links and never appear', () => {
  assert.deepEqual(SETTINGS_SECTIONS.filter(s => s.withheld).map(s => s.id), WITHHELD)
  for (const id of WITHHELD) {
    assert.equal(visibleSettingsSections({ admin: true, cloudAdmin: true, organization: true }).some(s => s.id === id), false, id)
    assert.equal(isSettingsSectionParam(id), false, id)
    assert.equal(resolveSettingsSection('/settings', id), 'preferences', id)
  }
})

test('sidebar names follow Figma 设置 v4 in the English search titles', () => {
  const title = id => SETTINGS_SECTIONS.find(s => s.id === id).title
  assert.deepEqual(['computers', 'developer', 'permissions', 'logins'].map(title), ['Devices', 'Personal access tokens', 'Team permissions', 'Secrets and logins'])
})

test('a current id wins over a legacy alias with the same name', () => {
  assert.equal(resolveSettingsSection('/settings', 'account'), 'account')
  assert.equal(resolveSettingsSection('/settings', 'profile'), 'account')
})

test('a personal workspace has every setting of the workspace itself; only what is between people is a team\'s', () => {
  // Decision 2026-11-02-0203: the two kinds differ only in 成员, 团队, 团队权限 and 审计日志.
  const personal = visibleSettingsSections({ admin: true, personal: true }).map(s => s.id)
  const account = SETTINGS_SECTIONS.filter(s => (s.group === 'personal' || s.group === 'agent') && !UNBUILT.includes(s.id) && !WITHHELD.includes(s.id) && s.sidebar !== false).map(s => s.id)
  assert.deepEqual(personal, [...account, 'general', 'issue-states', 'billing', 'usage'])
  const team = visibleSettingsSections({ admin: true }).map(s => s.id)
  for (const id of ['general', 'organization', 'members', 'teams', 'environments', 'audit', 'usage', 'billing']) assert.ok(team.includes(id), id)
  assert.equal(team.includes('permissions'), false)
  assert.equal(team.includes('secrets'), false)
})
