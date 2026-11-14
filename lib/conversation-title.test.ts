import assert from 'node:assert/strict'
import test from 'node:test'
import { conversationTitlePlan, manualConversationTitle } from './conversation-title'

const none = { title: null, titleSource: null }
const generated = { title: '登录回调修复', titleSource: 'generated' as const }
const manual = { title: '我起的名字', titleSource: 'manual' as const }

test('a new conversation is named from what it was asked; a run that continues one takes its title', () => {
  assert.deepEqual(conversationTitlePlan('created', none, none, 1), { do: 'generate' })
  assert.deepEqual(conversationTitlePlan('created', none, generated, 2), { do: 'copy', title: '登录回调修复', source: 'generated' })
  assert.deepEqual(conversationTitlePlan('created', generated, generated, 1), { do: 'keep' }, 'a repeated job writes nothing')
})

test('the first run\'s end and an opened PR name it again only while its title is a generated one', () => {
  assert.deepEqual(conversationTitlePlan('first_run_ended', generated, generated, 1), { do: 'generate' })
  assert.deepEqual(conversationTitlePlan('first_run_ended', none, none, 1), { do: 'generate' }, 'a conversation the model never named gets its first title here')
  assert.deepEqual(conversationTitlePlan('first_run_ended', generated, generated, 2), { do: 'keep' }, 'only the first run\'s end')
  assert.deepEqual(conversationTitlePlan('pull_opened', generated, generated, 3), { do: 'generate' })
  for (const trigger of ['created', 'first_run_ended', 'pull_opened'] as const) {
    assert.deepEqual(conversationTitlePlan(trigger, manual, manual, 1), { do: 'keep' }, `${trigger} never replaces a manual title`)
    assert.deepEqual(conversationTitlePlan(trigger, none, manual, 2), { do: 'copy', title: '我起的名字', source: 'manual' }, `${trigger}: a later run takes the person's title`)
  }
})

test('regenerate is the person asking: it is the one trigger that replaces a manual title', () => {
  assert.deepEqual(conversationTitlePlan('regenerate', manual, manual, 2), { do: 'generate' })
})

test('a title a person types is held to the short-title bound', () => {
  assert.equal(manualConversationTitle('  登录回调  修复  '), '登录回调 修复')
  assert.equal([...manualConversationTitle('修复登录后的工作区前缀和查询参数丢失问题')!].length, 12)
  assert.equal(manualConversationTitle('Fix the workspace prefix that is lost after sign in'), 'Fix the workspace prefix that is')
  assert.equal(manualConversationTitle('   '), null)
})
