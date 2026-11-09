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
    assert.equal(messages.MobileCore.conversation.switchedAfterFailure.replace('{previous}', 'Claude Code').replace('{agent}', 'Codex'), 'Claude Code 没跑通 · 换 Codex 继续')
    assert.equal(messages.MobileCore.conversation.switched.replace('{agent}', 'Codex'), '换 Codex 继续')
    assert.doesNotMatch(JSON.stringify(messages.MobileCore), /尝试/)
    assert.equal(messages.MobileCore.threadSteps.commands.replace('{count}', '2'), '已运行 2 条命令')
    assert.equal(messages.MobileCore.steps.replace('{count}', '3'), '执行了 3 步')
  }
})

test('other device languages use the available English core copy', () => {
  assert.equal(getMobileMessages('fr-FR').Nav.tasks, 'Tasks')
})
