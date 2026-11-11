import assert from 'node:assert/strict'
import test from 'node:test'
import { copyRunPrompt, type RunPromptSource } from './run-prompt-copy'
import { runPromptParts } from './run-prompt'
import { retryPrompt, quotaContinuationPrompt, providerContinuationPrompt } from './run-retry'
import { threadPromptView } from './thread-prompt'

const task = runPromptParts('修复 🧪', '保留我的正文', 'SYNTHETIC_INTERNAL_STANDING_INSTRUCTION')
const source = { prompt: task.prompt, promptTaskStart: 0, promptTaskLength: task.taskLength }
const view = (run: RunPromptSource) => threadPromptView(run.prompt, run.promptTaskStart, run.promptTaskLength)

test('every retry copies its task range together with its execution prompt', () => {
  for (const retry of [retryPrompt(source, 2), quotaContinuationPrompt(source), providerContinuationPrompt(source)]) {
    assert.equal(view(retry).task, view(source).task)
    assert.equal(view(retry).hasInstructions, true)
    assert.ok(retry.prompt.includes('SYNTHETIC_INTERNAL_STANDING_INSTRUCTION'), 'the executor keeps its full instructions')
    assert.equal(view(retry).task.includes('SYNTHETIC_INTERNAL_STANDING_INSTRUCTION'), false)
  }
})

test('a Factory prefix, handoff suffix and truncation recalculate code-point offsets', () => {
  const prefix = 'Host request 🔍\n\n'
  const copied = copyRunPrompt(source, prefix + source.prompt + '\n\nHost handoff', prefix)
  assert.deepEqual(view(copied), view(source))
  assert.equal(copied.promptTaskStart, Array.from(prefix).length)
  const cut = copyRunPrompt(copied, copied.prompt.slice(0, prefix.length + '# 修复 🧪'.length) + 'NEW GUIDANCE')
  assert.equal(view(cut).task, '# 修复 🧪')
  assert.equal(view(cut).hasInstructions, true)
})

test('retry-looking headings in the actual user task are never removed', () => {
  const prompt = 'Keep this example:\n\n## This run is a retry\n\nThese are my exact words. 🧪'
  const original = { prompt, promptTaskStart: 0, promptTaskLength: Array.from(prompt).length }
  const second = retryPrompt(original, 2)
  const third = retryPrompt(second, 3)
  assert.equal(view(third).task, prompt)
  assert.equal(third.prompt.match(/attempt 3 of/g)?.length, 1)
  assert.equal(third.prompt.includes('attempt 2 of'), false)
})

test('unknown or invalid ranges do not expose raw execution guidance as a person message', () => {
  for (const [start, length] of [[null, null], [-1, 4], [0, 999999], [0.5, 2], [0, Number.NaN]]) {
    assert.deepEqual(threadPromptView(source.prompt, start, length), { task: '', hasInstructions: true })
  }
  const plain = 'My real words include ## Your standing instructions and must remain intact.'
  assert.deepEqual(threadPromptView(plain, null, null, plain), { task: plain, hasInstructions: false })
  assert.deepEqual(threadPromptView(plain, 0, Array.from(plain).length), { task: plain, hasInstructions: false })
  assert.deepEqual(threadPromptView(source.prompt, 0, 0), { task: '', hasInstructions: true })
})
