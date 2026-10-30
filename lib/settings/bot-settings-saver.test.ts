import assert from 'node:assert/strict'
import test from 'node:test'
import { createBotSettingsSaver, type BotSettingsChange } from './bot-settings-saver'
import type { WorkspaceBotModel as BotModelId } from '../db/schema'

/** Drives the saver with promises the test resolves by hand, in any order. */
function setup() {
  const state = { model: null as BotModelId | null, repository: 'r1' as string | null }
  const pending: { change: BotSettingsChange; resolve: (ok: boolean | 'reject') => void }[] = []
  const events = { saved: 0, failed: [] as BotSettingsChange[] }
  const history: (BotModelId | null)[] = []
  const owner = { active: true }
  const saver = createBotSettingsSaver({
    update: change => new Promise((resolve, reject) => pending.push({ change, resolve: ok => ok === 'reject' ? reject(new Error('network')) : resolve(ok ? { model: state.model, repository: state.repository, ...change } as never : { error: 'generic' } as never) })),
    apply: patch => { Object.assign(state, patch); history.push(state.model) },
    onSaved: () => { events.saved++ },
    onFailed: change => { events.failed.push(change) },
    isActive: () => owner.active,
  })
  saver.confirm({ model: null, repository: 'r1' })
  const runs: Promise<void>[] = []
  const save = (model: BotModelId | null) => { runs.push(saver.save({ model: model })) }
  const saveRepository = (repository: string) => { runs.push(saver.save({ repository: repository })) }
  const answer = async (index: number, ok: boolean | 'reject') => { pending[index]!.resolve(ok); await new Promise(resolve => setImmediate(resolve)) }
  return { saver, owner, history, state, events, save, saveRepository, answer, done: () => Promise.all(runs) }
}

test('in order: an older failure after a newer choice changes nothing', async () => {
  const s = setup(); s.save('codex'); s.save('claude')
  await s.answer(0, false); await s.answer(1, true); await s.done()
  assert.equal(s.state.model, 'claude'); assert.deepEqual(s.events.failed, []); assert.equal(s.events.saved, 1)
})

test('out of order: the newer success lands first, the older failure is ignored', async () => {
  const s = setup(); s.save('codex'); s.save('claude')
  await s.answer(1, true); await s.answer(0, false); await s.done()
  assert.equal(s.state.model, 'claude'); assert.deepEqual(s.events.failed, []); assert.equal(s.events.saved, 1)
})

test('Codex succeeds (older) → Claude fails (latest) → rolls back to Codex, the last confirmed value, and reports once', async () => {
  const s = setup(); s.save('codex'); s.save('claude')
  await s.answer(0, true); await s.answer(1, false); await s.done()
  assert.equal(s.state.model, 'codex'); assert.deepEqual(s.events.failed, [{ model: 'claude' }]); assert.equal(s.events.saved, 0)
})

test('ABA: Codex (fails late) → Mikka → Codex keeps Codex without an error', async () => {
  const s = setup(); s.save('codex'); s.save(null); s.save('codex')
  await s.answer(1, true); await s.answer(2, true); await s.answer(0, false); await s.done()
  assert.equal(s.state.model, 'codex'); assert.deepEqual(s.events.failed, []); assert.equal(s.events.saved, 1)
})

test('ABA: Codex fails first, then Mikka and Codex succeed', async () => {
  const s = setup(); s.save('codex'); s.save(null); s.save('codex')
  await s.answer(0, false); await s.answer(1, true); await s.answer(2, true); await s.done()
  assert.equal(s.state.model, 'codex'); assert.deepEqual(s.events.failed, [])
})

test('ABA: the latest Codex fails after Mikka succeeded, so the UI returns to Mikka', async () => {
  const s = setup(); s.save('codex'); s.save(null); s.save('codex')
  await s.answer(0, false); await s.answer(1, true); await s.answer(2, false); await s.done()
  assert.equal(s.state.model, null); assert.deepEqual(s.events.failed, [{ model: 'codex' }])
})

test('saves of different fields never undo each other', async () => {
  const s = setup(); s.save('codex'); s.saveRepository('r2')
  await s.answer(1, true); await s.answer(0, false); await s.done()
  assert.equal(s.state.model, null); assert.equal(s.state.repository, 'r2')
})

test('S5b: latest Claude fails while the older Codex is in flight → wait, then Codex succeeds late → UI ends at Codex', async () => {
  const s = setup(); s.save('codex'); s.save('claude')
  await s.answer(1, false)
  // Rollback waits for the in-flight Codex: no flicker back to the old value, nothing reported yet.
  assert.equal(s.state.model, 'claude'); assert.deepEqual(s.events.failed, [])
  await s.answer(0, true); await s.done()
  assert.equal(s.state.model, 'codex'); assert.deepEqual(s.events.failed, [{ model: 'claude' }]); assert.equal(s.events.saved, 0)
  // The stale pre-save value never flashes in between: Codex → Claude → Codex only.
  assert.deepEqual(s.history, ['codex', 'claude', 'codex'])
})

test('latest fails while the older is in flight, then the older fails too → UI ends at the earlier confirmed value', async () => {
  const s = setup(); s.save('codex'); await s.answer(0, true)
  s.save('mikka'); s.save('claude')
  await s.answer(2, false)
  assert.equal(s.state.model, 'claude'); assert.deepEqual(s.events.failed, [])
  await s.answer(1, false); await s.done()
  assert.equal(s.state.model, 'codex'); assert.deepEqual(s.events.failed, [{ model: 'claude' }])
})

test('a late older success must not overwrite a newer confirmed value', async () => {
  const s = setup(); s.save('codex'); s.save('claude')
  await s.answer(1, true); await s.answer(0, true)
  assert.equal(s.state.model, 'claude')
  s.save('mikka'); await s.answer(2, false); await s.done()
  // The rollback target is Claude (confirmed by the newer request), not the late Codex.
  assert.equal(s.state.model, 'claude'); assert.deepEqual(s.events.failed, [{ model: 'mikka' }])
})

test('a fresh load confirms at the current seq: an older in-flight success cannot replace it as the rollback target', async () => {
  const s = setup(); s.save('codex')
  s.saver.confirm({ model: 'claude', repository: 'r1' }); Object.assign(s.state, { model: 'claude' })
  await s.answer(0, true)
  s.save('mikka'); await s.answer(1, false); await s.done()
  assert.equal(s.state.model, 'claude'); assert.deepEqual(s.events.failed, [{ model: 'mikka' }])
})

test('reject: latest fails while an older save is in flight, then the older one rejects → rolls back once', async () => {
  const s = setup(); s.save('codex'); s.save('claude')
  await s.answer(1, false); await s.answer(0, 'reject'); await s.done()
  assert.equal(s.state.model, null); assert.deepEqual(s.events.failed, [{ model: 'claude' }]); assert.equal(s.events.saved, 0)
})

test('reject: the only save rejects → rolls back and reports, later saves still roll back', async () => {
  const s = setup(); s.save('codex')
  await s.answer(0, 'reject'); await s.done()
  assert.equal(s.state.model, null); assert.deepEqual(s.events.failed, [{ model: 'codex' }])
  s.save('claude'); await s.answer(1, false); await s.done()
  assert.equal(s.state.model, null); assert.equal(s.events.failed.length, 2)
})

test('unmount: a success or failure that lands after unmount changes nothing and reports nothing', async () => {
  const s = setup(); s.save('codex'); s.save('claude')
  const applied = s.history.length
  s.owner.active = false
  await s.answer(0, true); await s.answer(1, false); await s.done()
  assert.equal(s.history.length, applied, 'no apply after unmount')
  assert.equal(s.events.saved, 0); assert.deepEqual(s.events.failed, [])
})
