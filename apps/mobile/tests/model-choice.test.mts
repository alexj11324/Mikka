// A pick that did not save names the model and why; the chip keeps the saved one (Figma 843:2 #3).
import assert from 'node:assert/strict'
import test from 'node:test'
import { choiceFailureLine } from '../lib/model-choice.ts'

test('each refusal reads as its reason, anything else as no connection', () => {
  assert.equal(choiceFailureLine('claude-sonnet-5-5', 'modelUnavailable'), '没换成 claude-sonnet-5-5：这个模型现在不可用')
  assert.equal(choiceFailureLine('deepseek-chat', 'botNotFound'), '没换成 deepseek-chat：找不到这个 bot')
  assert.equal(choiceFailureLine('deepseek-chat', 'invalidModel'), '没换成 deepseek-chat：需要更新 App')
  assert.equal(choiceFailureLine('Mikka 默认', null), '没换成 Mikka 默认：连不上 Mikka')
})
