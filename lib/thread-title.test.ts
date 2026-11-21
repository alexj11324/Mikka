import assert from 'node:assert/strict'
import test from 'node:test'
import { threadTitlePlan, effectiveTitleSettings, manualThreadTitle, titleTriggerAllows } from './thread-title'

const none = { title: null, titleSource: null }
const generated = { title: '登录回调修复', titleSource: 'generated' as const }
const manual = { title: '我起的名字', titleSource: 'manual' as const }

test('a new thread is named from what it was asked; a run that continues one takes its title', () => {
  assert.deepEqual(threadTitlePlan('created', none, none, 1), { do: 'generate' })
  assert.deepEqual(threadTitlePlan('created', none, generated, 2), { do: 'copy', title: '登录回调修复', source: 'generated' })
  assert.deepEqual(threadTitlePlan('created', generated, generated, 1), { do: 'keep' }, 'a repeated job writes nothing')
})

test('the first run\'s end and an opened PR name it again only while its title is a generated one', () => {
  assert.deepEqual(threadTitlePlan('first_run_ended', generated, generated, 1), { do: 'generate' })
  assert.deepEqual(threadTitlePlan('first_run_ended', none, none, 1), { do: 'generate' }, 'a thread the model never named gets its first title here')
  assert.deepEqual(threadTitlePlan('first_run_ended', generated, generated, 2), { do: 'keep' }, 'only the first run\'s end')
  assert.deepEqual(threadTitlePlan('pull_opened', generated, generated, 3), { do: 'generate' })
  for (const trigger of ['created', 'first_run_ended', 'pull_opened'] as const) {
    assert.deepEqual(threadTitlePlan(trigger, manual, manual, 1), { do: 'keep' }, `${trigger} never replaces a manual title`)
    assert.deepEqual(threadTitlePlan(trigger, none, manual, 2), { do: 'copy', title: '我起的名字', source: 'manual' }, `${trigger}: a later run takes the person's title`)
  }
})

test('regenerate is the person asking: it is the one trigger that replaces a manual title', () => {
  assert.deepEqual(threadTitlePlan('regenerate', manual, manual, 2), { do: 'generate' })
})

test('a title a person types is held to the short-title bound', () => {
  assert.equal(manualThreadTitle('  登录回调  修复  '), '登录回调 修复')
  assert.equal([...manualThreadTitle('修复登录后的工作区前缀和查询参数丢失问题')!].length, 12)
  assert.equal(manualThreadTitle('Fix the workspace prefix that is lost after sign in'), 'Fix the workspace prefix that')
  assert.equal(manualThreadTitle('   '), null)
})

test('Capy\'s thread-title settings: workspace instructions then the member\'s, the member\'s triggers else the workspace\'s', () => {
  const rows = [
    { userId: '', instructions: 'Prefix titles with the customer name when one is mentioned', triggers: 'pull_opened' as const },
    { userId: 'u1', instructions: '  Use English  ', triggers: null },
    { userId: 'u2', instructions: '', triggers: 'first_run_ended' as const },
  ]
  assert.deepEqual(effectiveTitleSettings(rows, 'u1'), { instructions: ['Prefix titles with the customer name when one is mentioned', 'Use English'], triggers: 'pull_opened' })
  assert.deepEqual(effectiveTitleSettings(rows, 'u2'), { instructions: ['Prefix titles with the customer name when one is mentioned'], triggers: 'first_run_ended' })
  assert.deepEqual(effectiveTitleSettings([], 'u3'), { instructions: [], triggers: 'either' })
})

test('creation and Regenerate always name; the other triggers follow the setting', () => {
  for (const triggers of ['first_run_ended', 'pull_opened', 'either'] as const) {
    assert.equal(titleTriggerAllows('created', triggers), true)
    assert.equal(titleTriggerAllows('regenerate', triggers), true)
  }
  assert.equal(titleTriggerAllows('first_run_ended', 'pull_opened'), false)
  assert.equal(titleTriggerAllows('pull_opened', 'first_run_ended'), false)
  assert.equal(titleTriggerAllows('pull_opened', 'either'), true)
})
test('explicitly disabling manual protection permits automatic renaming while a continuation still copies its title', () => {
  assert.deepEqual(threadTitlePlan('pull_opened', manual, manual, 2, false), { do: 'generate' })
  assert.deepEqual(threadTitlePlan('created', none, manual, 2, false), { do: 'copy', title: manual.title, source: 'manual' })
})
