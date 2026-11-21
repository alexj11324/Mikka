import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSettingsPatch, resolveSettingValue, settingsSchema } from './registry'

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

test('Git defaults retain explicit false and empty prefixes; review fields are administrator-only', () => {
  assert.deepEqual(resolveSettingValue('prAutoMerge', false, true), { value: false, source: 'personal' })
  assert.deepEqual(resolveSettingValue('prTitlePrefix', '', '[Team]'), { value: '', source: 'personal' })
  assert.deepEqual(resolveSettingValue('prBranchPrefix', null, 'team/fix'), { value: 'team/fix', source: 'workspace' })
  assert.deepEqual(resolveSettingValue('prBranchPrefix', null, null), { value: 'mikka', source: 'default' })
  for (const values of [{ prBranchPrefix: 'refs/../main' }, { prAutoMerge: 'true' }, { prTitlePrefix: 'text\u0000more' },
    { codeReviewModel: 'model with spaces' }, { codeReviewSeverity: 'all' }, { codeReviewIgnoredPaths: ['../secret'] }, { codeReviewOutput: 'approve' }]) {
    assert.throws(() => parseSettingsPatch('workspace', { values }))
  }
  for (const key of ['codeReviewModel', 'codeReviewSeverity', 'codeReviewIgnoredPaths', 'codeReviewOutput']) assert.throws(() => parseSettingsPatch('personal', { values: { [key]: null } }))
  assert.deepEqual(parseSettingsPatch('workspace', { values: { prBranchPrefix: 'team/fix/', codeReviewIgnoredPaths: ['vendor/**', 'vendor/**'] } }),
    { prBranchPrefix: 'team/fix', codeReviewIgnoredPaths: ['vendor/**'] })
})
