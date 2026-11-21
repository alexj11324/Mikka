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
    // Alex 2026-11-09 (decisions/2026-11-09-0045): a task is one conversation; no 「尝试」 and no run numbers.
    // …and no switch verb (as Warp): where the Agent changes the conversation shows the Agent itself.
    assert.doesNotMatch(JSON.stringify(messages.MobileCore.conversation), /换|没跑通/)
    assert.doesNotMatch(JSON.stringify(messages.MobileCore), /尝试/)
    assert.equal(messages.MobileCore.threadSteps.commands.replace('{count}', '2'), '已运行 2 条命令')
    assert.equal(messages.MobileCore.steps.replace('{count}', '3'), '执行了 3 步')
  }
})

test('other device languages use the available English core copy', () => {
  assert.equal(getMobileMessages('fr-FR').Nav.tasks, 'Tasks')
})

test('notification read errors identify settings in the same device language as the retry action', () => {
  for (const [locale, title, failure, retry] of [
    ['en-US', 'Notifications', 'Unable to load Settings.', 'Retry save'],
    ['zh-CN', '通知', '设置加载失败。', '重试保存'],
  ]) {
    const messages = getMobileMessages(locale)
    assert.equal(messages.Settings.sections.notifications.title, title)
    assert.equal(messages.MobileCore.readFailed.replace('{label}', messages.Settings.title), failure)
    assert.equal(messages.MobileCore.notifications.retrySave, retry)
  }
})

test('legacy thread links, their read failures and the composer share the device language', () => {
  for (const [locale, input, readError, lastStatus] of [
    ['en-US', 'Message this thread', 'Unable to load Thread.', 'Last status: Done'],
    ['zh-CN', '给这个线程发消息', '线程加载失败。', '上次状态：完成'],
  ]) {
    const copy = getMobileMessages(locale)
    assert.equal(copy.MobileCore.messageThread, input)
    assert.equal(copy.MobileCore.readFailed.replace('{label}', copy.IssueThreads.hidden), readError)
    assert.equal(copy.MobileCore.lastThreadStatus.replace('{status}', copy.MobileCore.attempts.done), lastStatus)
  }
})
