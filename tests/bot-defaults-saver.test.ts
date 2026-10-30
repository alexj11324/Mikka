import assert from 'node:assert/strict'
import test from 'node:test'
import { createBotDefaultsSaver, type BotDefaultsChange } from '../lib/settings/bot-defaults-saver'
import type { BotModelId } from '../lib/settings/bots-api'

/** Drives the saver with promises the test resolves by hand, in any order. */
function setup() {
  const state = { defaultModel: null as BotModelId | null, defaultRepository: 'r1' as string | null }
  const pending: { change: BotDefaultsChange; resolve: (ok: boolean) => void }[] = []
  const events = { saved: 0, failed: [] as BotDefaultsChange[] }
  const saver = createBotDefaultsSaver({
    update: change => new Promise(resolve => pending.push({ change, resolve: ok => resolve(ok ? { defaultModel: state.defaultModel, defaultRepository: state.defaultRepository, ...change } as never : { error: 'generic' } as never) })),
    apply: patch => Object.assign(state, patch),
    onSaved: () => { events.saved++ },
    onFailed: change => { events.failed.push(change) },
  })
  saver.confirm({ defaultModel: null, defaultRepository: 'r1' })
  const runs: Promise<void>[] = []
  const save = (model: BotModelId | null) => { runs.push(saver.save({ defaultModel: model })) }
  const saveRepository = (repository: string) => { runs.push(saver.save({ defaultRepository: repository })) }
  const answer = async (index: number, ok: boolean) => { pending[index]!.resolve(ok); await new Promise(resolve => setImmediate(resolve)) }
  return { state, events, save, saveRepository, answer, done: () => Promise.all(runs) }
}

test('in order: an older failure after a newer choice changes nothing', async () => {
  const s = setup(); s.save('codex'); s.save('claude')
  await s.answer(0, false); await s.answer(1, true); await s.done()
  assert.equal(s.state.defaultModel, 'claude'); assert.deepEqual(s.events.failed, []); assert.equal(s.events.saved, 1)
})

test('out of order: the newer success lands first, the older failure is ignored', async () => {
  const s = setup(); s.save('codex'); s.save('claude')
  await s.answer(1, true); await s.answer(0, false); await s.done()
  assert.equal(s.state.defaultModel, 'claude'); assert.deepEqual(s.events.failed, []); assert.equal(s.events.saved, 1)
})

test('Codex succeeds (older) → Claude fails (latest) → rolls back to Codex, the last confirmed value, and reports once', async () => {
  const s = setup(); s.save('codex'); s.save('claude')
  await s.answer(0, true); await s.answer(1, false); await s.done()
  assert.equal(s.state.defaultModel, 'codex'); assert.deepEqual(s.events.failed, [{ defaultModel: 'claude' }]); assert.equal(s.events.saved, 0)
})

test('ABA: Codex (fails late) → Mikka → Codex keeps Codex without an error', async () => {
  const s = setup(); s.save('codex'); s.save(null); s.save('codex')
  await s.answer(1, true); await s.answer(2, true); await s.answer(0, false); await s.done()
  assert.equal(s.state.defaultModel, 'codex'); assert.deepEqual(s.events.failed, []); assert.equal(s.events.saved, 1)
})

test('ABA: Codex fails first, then Mikka and Codex succeed', async () => {
  const s = setup(); s.save('codex'); s.save(null); s.save('codex')
  await s.answer(0, false); await s.answer(1, true); await s.answer(2, true); await s.done()
  assert.equal(s.state.defaultModel, 'codex'); assert.deepEqual(s.events.failed, [])
})

test('ABA: the latest Codex fails after Mikka succeeded, so the UI returns to Mikka', async () => {
  const s = setup(); s.save('codex'); s.save(null); s.save('codex')
  await s.answer(0, false); await s.answer(1, true); await s.answer(2, false); await s.done()
  assert.equal(s.state.defaultModel, null); assert.deepEqual(s.events.failed, [{ defaultModel: 'codex' }])
})

test('saves of different fields never undo each other', async () => {
  const s = setup(); s.save('codex'); s.saveRepository('r2')
  await s.answer(1, true); await s.answer(0, false); await s.done()
  assert.equal(s.state.defaultModel, null); assert.equal(s.state.defaultRepository, 'r2')
})
