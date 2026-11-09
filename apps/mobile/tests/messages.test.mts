import assert from 'node:assert/strict'
import test from 'node:test'
import { getMobileMessages } from '../lib/messages.ts'

test('English device locales use shared English navigation and task copy', () => {
  for (const locale of ['en', 'en-US', 'en-GB']) {
    const messages = getMobileMessages(locale)
    assert.equal(messages.Nav.tasks, 'Tasks')
    assert.equal(messages.MobileCore.groups.done, 'Completed')
    assert.equal(messages.Nav.messageBot.replace('{name}', 'Atlas'), 'Message Atlas')
  }
})

test('Chinese device variants preserve Chinese navigation and task copy', () => {
  for (const locale of ['zh', 'zh-CN', 'zh-Hans-CN', 'zh-Hant-TW']) {
    const messages = getMobileMessages(locale)
    assert.equal(messages.Nav.tasks, '任务')
    assert.equal(messages.MobileCore.groups.done, '已完成')
    assert.equal(messages.MobileCore.attemptNumber.replace('{number}', '2'), '第 2 次尝试')
  }
})

test('other device languages use the available English core copy', () => {
  assert.equal(getMobileMessages('fr-FR').Nav.tasks, 'Tasks')
})
