import assert from 'node:assert/strict'
import { test } from 'node:test'
import { codePushBody, pushAllowed, pushBody } from './mobile-push'
import { DEFAULT_PREFERENCES } from './preferences'

test('defaults push decisions but not finished threads', () => {
  assert.equal(pushAllowed(DEFAULT_PREFERENCES, ['decide']), true)
  assert.equal(pushAllowed(DEFAULT_PREFERENCES, ['finished']), false)
})

test('proactive off pushes nothing', () => {
  assert.equal(pushAllowed({ ...DEFAULT_PREFERENCES, proactive: false }, ['decide']), false)
})

test('push text drops citations and Markdown', () => {
  assert.equal(pushBody('**PR** [[run:12345678-1234-1234-1234-123456789abc]] 修好了，见 [日志](https://x.dev/a)。'), 'PR 修好了，见 日志。')
})

test('long text is cut with an ellipsis', () => {
  const body = pushBody('字'.repeat(400))
  assert.equal(body.length, 180)
  assert.ok(body.endsWith('…'))
})

test('a verification code push comes from the messages, in the person\'s language, without the code', async () => {
  assert.equal(await codePushBody('zh-CN'), '收到一条验证码')
  assert.equal(await codePushBody('en'), 'A verification code arrived')
})

test('a card is pushed as its words, not as OpenUI', () => {
  const card = 'root = Stack([TextContent("Stripe 10 月账单周五到期，没付会停服。"), BeFollowUps([{label:"现在付款", prompt:"帮我付款"}, {label:"晚点再说", prompt:"晚点提醒我"}])])'
  assert.equal(pushBody(card), 'Stripe 10 月账单周五到期，没付会停服。 现在付款 晚点再说')
})
