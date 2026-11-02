import assert from 'node:assert/strict'
import test from 'node:test'
import { ModelMenuRead } from '../lib/model-menu-read.ts'
import { modelMenuLabel, modelMenuReadLabel, type ModelMenu } from '../lib/model-menu-view.ts'

function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
test('repeated taps share a pending model read rather than racing snapshots', async () => {
  const response = deferred(); let calls = 0
  const reader = new ModelMenuRead(() => { calls++; return response.promise })
  const first = reader.retry(), second = reader.retry()
  assert.equal(first, second)
  assert.equal(reader.snapshot(), true)
  await Promise.resolve(); assert.equal(calls, 1)
  response.resolve(); await first
  assert.equal(reader.snapshot(), false)
})
test('a failed initial model read can be retried after the error', async () => {
  const response = deferred(); let calls = 0
  const reader = new ModelMenuRead(async () => { calls++; if (calls === 1) await response.promise })
  const first = reader.retry()
  response.reject(new Error('offline')); await assert.rejects(first, /offline/)
  assert.equal(reader.snapshot(), false)
  await reader.retry()
  assert.equal(calls, 2)
})
test('a model chosen during generation is explicitly for the next message', () => {
  const current: ModelMenu['current'] = { id: 'fixture', modelId: 'chosen-model', provider: 'claude', kind: 'subscription', chosen: true, available: true }
  assert.match(modelMenuLabel(current, true), /^下一条 · chosen-model/)
  assert.doesNotMatch(modelMenuLabel(current, false), /下一条/)
})
test('the absent-menu chip has explicit loading and retry states', () => {
  assert.equal(modelMenuReadLabel(true), '正在读取模型')
  assert.equal(modelMenuReadLabel(false), '模型加载失败，重试')
})
