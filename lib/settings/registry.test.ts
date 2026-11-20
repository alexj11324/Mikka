import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSettingsPatch, resolveSettingValue, settingsSchema } from './registry'
import { workCreationView } from './work-creation-policy'

test('inheritance retains explicit zero/empty overrides and falls through null to workspace or default', () => {
  assert.deepEqual(resolveSettingValue('archiveIdleAfterDays', 0, 7), { value: 0, source: 'personal' })
  assert.deepEqual(resolveSettingValue('archiveIdleAfterDays', null, 7), { value: 7, source: 'workspace' })
  assert.deepEqual(resolveSettingValue('archiveIdleAfterDays', null, null), { value: 30, source: 'default' })
  assert.deepEqual(resolveSettingValue('threadTitleInstructions', '', 'team'), { value: '', source: 'personal' })
  assert.deepEqual(resolveSettingValue('subagentMaxConcurrent', 20, null), { value: 6, source: 'default' })
})

test('server guards reject unknown fields, invalid scope, coercion and out-of-range values', () => {
  for (const values of [{ archiveIdleAfterDays: '7' }, { archiveIdleAfterDays: 4 }, { unknown: true }, { toString: 'x' }, { subagentMaxConcurrent: 3 }]) {
    assert.throws(() => parseSettingsPatch('personal', { values }))
  }
  for (const value of [0, 21, 1.5, '6', true]) assert.throws(() => parseSettingsPatch('workspace', { values: { subagentMaxConcurrent: value } }))
  assert.throws(() => parseSettingsPatch('personal', { userId: 'other', values: { archiveIdleAfterDays: 7 } }))
  assert.deepEqual(parseSettingsPatch('personal', { values: { archiveIdleAfterDays: null, threadTitleInstructions: '  own  ' } }),
    { archiveIdleAfterDays: null, threadTitleInstructions: 'own' })
})

test('public schema is serializable metadata with bilingual row search and no server guard', () => {
  const schema = JSON.parse(JSON.stringify(settingsSchema()))
  const row = schema.find((value: { key: string }) => value.key === 'archiveIdleAfterDays')
  assert.equal(row.label['zh-CN'], '归档闲置线程')
  assert.equal(row.page, 'threads')
  assert.ok(row.keywords.includes('archive'))
  assert.equal('guard' in row, false)
  assert.deepEqual(row.writeAccess, { personal: 'owner', workspace: 'admin' })
})

test('new-work preferences inherit independently of the workspace creation policy', () => {
  assert.deepEqual(resolveSettingValue('newWorkVisibility', null, null), { value: 'private', source: 'default' })
  assert.deepEqual(resolveSettingValue('newWorkVisibility', null, 'shared'), { value: 'shared', source: 'workspace' })
  assert.deepEqual(resolveSettingValue('newWorkVisibility', 'private', 'shared'), { value: 'private', source: 'personal' })
  assert.deepEqual(resolveSettingValue('allowPrivateNewWork', true, false), { value: false, source: 'workspace' })
  const configured = { value: 'private' as const, source: 'personal' as const }
  assert.deepEqual(workCreationView('team', configured, false), {
    configured, effectiveVisibility: 'shared', privateAllowed: false, reason: 'workspace_policy',
  })
  assert.deepEqual(workCreationView('team', configured, true), {
    configured, effectiveVisibility: 'private', privateAllowed: true, reason: 'configured',
  })
  const shared = { value: 'shared' as const, source: 'workspace' as const }
  assert.deepEqual(workCreationView('personal', shared, false), {
    configured: shared, effectiveVisibility: 'private', privateAllowed: true, reason: 'personal_workspace',
  })
  for (const value of ['workspace', 'link', true, 1]) assert.throws(() => parseSettingsPatch('personal', { values: { newWorkVisibility: value } }))
  assert.throws(() => parseSettingsPatch('personal', { values: { allowPrivateNewWork: false } }))
  assert.deepEqual(parseSettingsPatch('personal', { values: { newWorkVisibility: null } }), { newWorkVisibility: null })
})
