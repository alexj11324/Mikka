import assert from 'node:assert/strict'
import test from 'node:test'

const { displayTitle } = await import('../lib/display-title.ts')

test('a leading issue key is not shown', () => {
  assert.equal(displayTitle('ALEX-12: 修复 iOS 登录回调'), '修复 iOS 登录回调')
  assert.equal(displayTitle('ALEX-1203 修复 iOS 登录回调'), '修复 iOS 登录回调')
  assert.equal(displayTitle('#1408 iOS 按 Comma 的布局重做'), 'iOS 按 Comma 的布局重做')
  assert.equal(displayTitle('[MIK-3] 设置页改用原生表单'), '设置页改用原生表单')
})

test('a trailing date or time stamp is not shown', () => {
  assert.equal(displayTitle('Factory review 2026-11-06'), 'Factory review')
  assert.equal(displayTitle('Factory review 2026-11-06 03:12'), 'Factory review')
  assert.equal(displayTitle('Factory review (2026-11-06T03:12:44Z)'), 'Factory review')
  assert.equal(displayTitle('周报 · 11/06 09:30'), '周报')
  assert.equal(displayTitle('nightly check 20261106-0312'), 'nightly check')
  assert.equal(displayTitle('ALEX-77: 生产部署回滚检查 2026-11-05 22:10'), '生产部署回滚检查')
})

test('the rest of the title is untouched', () => {
  assert.equal(displayTitle('提交 1.0.0 (7) 审核'), '提交 1.0.0 (7) 审核')
  assert.equal(displayTitle('PR #1459 设置页改用原生表单'), 'PR #1459 设置页改用原生表单')
  assert.equal(displayTitle('升级到 Node 24'), '升级到 Node 24')
  assert.equal(displayTitle('升级到 Expo 58.0'), '升级到 Expo 58.0')
  assert.equal(displayTitle('发布 v1.2.3'), '发布 v1.2.3')
  assert.equal(displayTitle('提交 1.0.0'), '提交 1.0.0')
})

test('a title that is only a key or a stamp keeps its text', () => {
  assert.equal(displayTitle('ALEX-12'), 'ALEX-12')
  assert.equal(displayTitle('2026-11-06'), '2026-11-06')
})
