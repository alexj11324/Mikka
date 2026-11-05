import assert from 'node:assert/strict'
import test from 'node:test'
import { ModelMenuWrite } from '../lib/model-menu-write.ts'
import { modelStatusLine, type ModelMenu } from '../lib/model-menu-view.ts'

test('a pending model choice prevents another choice or refresh from racing the saved response', async () => {
  const writer = new ModelMenuWrite()
  let finish!: (value: string) => void
  const answer = new Promise<string>(resolve => { finish = resolve })
  const calls: string[] = []
  const first = writer.run(async () => { calls.push('choose A'); return answer })
  assert.equal(writer.snapshot(), true)
  const second = writer.run(async () => { calls.push('choose B'); return 'B' })
  const refresh = writer.run(async () => { calls.push('refresh'); return 'refresh' })
  assert.equal(await second, undefined)
  assert.equal(await refresh, undefined)
  finish('A'); assert.equal(await first, 'A')
  assert.deepEqual(calls, ['choose A'])
  assert.equal(writer.snapshot(), false)
  assert.equal(await writer.run(async () => 'B'), 'B')
})
test('a refused write releases the guard so an explicit retry can save', async () => {
  const writer = new ModelMenuWrite()
  await assert.rejects(writer.run(async () => { throw new Error('unavailable') }), /unavailable/)
  assert.equal(writer.snapshot(), false)
  assert.equal(await writer.run(async () => true), true)
})
test('unknown quota and unavailable selections have distinct truthful feedback', () => {
  const current: ModelMenu['current'] = { id: 'fixture', modelId: 'fixture-model', provider: 'claude', kind: 'subscription', available: false, chosen: true }
  assert.equal(modelStatusLine({ ...current, availability: 'checking' }), 'fixture-model · 额度待检查')
  assert.equal(modelStatusLine(current), 'fixture-model 现在不可用，请更换模型或刷新。')
})
