import assert from 'node:assert/strict'
import test from 'node:test'
import { DESKTOP_RPC_VERSION } from '../../../lib/desktop-rpc/version'
import { saveProfileName } from '../lib/profile-name'
import { PreferenceWrites } from '../lib/preference-writes.ts'
import { ApiCache } from '../lib/api-cache.ts'

type Preferences = { memory: boolean; push: boolean }
const initial = { memory: true, push: true }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function fixture() {
  let confirmed = { ...initial }, current = true
  const requests: { patch: Partial<Preferences>; response: ReturnType<typeof deferred<Preferences>> }[] = []
  const writer = new PreferenceWrites<Preferences>({
    write: patch => { const response = deferred<Preferences>(); requests.push({ patch, response }); return response.promise },
    confirm: patch => { confirmed = { ...confirmed, ...patch } },
    current: () => current,
  })
  return { writer, requests, confirmed: () => confirmed, leave: () => { current = false } }
}

test('turning memory off keeps the confirmed value until the service confirms it', async () => {
  const f = fixture(), saved = f.writer.save({ memory: false })
  assert.equal(f.confirmed().memory, true)
  assert.deepEqual(f.writer.snapshot(), { status: 'saving', intent: { memory: false } })
  f.requests[0].response.resolve({ ...initial, memory: false }); assert.equal(await saved, true)
  assert.equal(f.confirmed().memory, false)
  assert.deepEqual(f.writer.snapshot(), { status: 'idle', intent: {} })
})

test('a failed privacy change stays unconfirmed with the exact intent ready to retry', async () => {
  const f = fixture(), saved = f.writer.save({ memory: false })
  f.requests[0].response.reject(new Error('response lost')); assert.equal(await saved, false)
  assert.equal(f.confirmed().memory, true)
  assert.deepEqual(f.writer.snapshot(), { status: 'unconfirmed', intent: { memory: false } })
  const retried = f.writer.retry()
  assert.deepEqual(f.requests[1].patch, { memory: false })
  f.requests[1].response.resolve({ ...initial, memory: false }); assert.equal(await retried, true)
  assert.equal(f.confirmed().memory, false)
})

test('concurrent preference intentions are sent in order so full snapshots cannot overwrite a newer save', async () => {
  const f = fixture(), first = f.writer.save({ memory: false }), second = f.writer.save({ push: false })
  assert.equal(f.requests.length, 1)
  f.requests[0].response.resolve({ memory: false, push: true })
  await Promise.resolve(); await Promise.resolve()
  assert.equal(f.requests.length, 2)
  assert.deepEqual(f.requests[1].patch, { push: false })
  f.requests[1].response.resolve({ memory: false, push: false })
  assert.equal(await first, true); assert.equal(await second, true)
  assert.deepEqual(f.confirmed(), { memory: false, push: false })
})

test('a failure pauses queued writes and retry preserves all pending intentions', async () => {
  const f = fixture(), first = f.writer.save({ memory: false }), second = f.writer.save({ push: false })
  assert.equal(f.requests.length, 1)
  f.requests[0].response.reject(new Error('offline'))
  assert.equal(await first, false); assert.equal(await second, false)
  assert.equal(f.requests.length, 1)
  assert.deepEqual(f.writer.snapshot(), { status: 'unconfirmed', intent: { memory: false, push: false } })
  const retried = f.writer.retry()
  assert.deepEqual(f.requests[1].patch, { memory: false, push: false })
  f.requests[1].response.resolve({ memory: false, push: false }); assert.equal(await retried, true)
})

test('a completed response from an old identity never confirms settings in the new context', async () => {
  const f = fixture(), saved = f.writer.save({ memory: false })
  f.leave(); f.requests[0].response.resolve({ ...initial, memory: false })
  assert.equal(await saved, false)
  assert.deepEqual(f.confirmed(), initial)
})

test('account preferences stay pending through a workspace switch but never through an identity switch', async () => {
  const cache = new ApiCache(), response = deferred<Preferences>()
  cache.setIdentity('account A')
  const account = cache.account(); let confirmed = { ...initial }
  const writer = new PreferenceWrites<Preferences>({ write: () => response.promise, confirm: patch => { confirmed = { ...confirmed, ...patch } }, current: () => cache.account() === account })
  const saved = writer.save({ memory: false })
  cache.clear() // Selecting another workspace changes the read context, not the preferences' owner.
  assert.equal(writer.snapshot().status, 'saving')
  response.resolve({ ...initial, memory: false }); assert.equal(await saved, true)
  assert.equal(confirmed.memory, false)
  cache.setIdentity('account B')
  assert.equal(await writer.save({ memory: true }), false)
  assert.equal(confirmed.memory, false)
})

test('the native profile uses the same registered account action as Web and accepts its saved name', async () => {
  const pending = deferred<{ version: number; ok: boolean; result: { name: string } }>()
  const write = saveProfileName(' Name ', async (path, init) => {
    assert.equal(path, '/api/rpc')
    assert.deepEqual(init, {
      method: 'POST', body: { version: DESKTOP_RPC_VERSION, action: 'account.updateDisplayName', args: [' Name '] },
    })
    return pending.promise
  })
  pending.resolve({ version: DESKTOP_RPC_VERSION, ok: true, result: { name: 'Name' } })
  assert.equal(await write, 'Name')
})

test('refusals, unconfirmed responses and transport failures never return a saved name', async () => {
  for (const receipt of [
    null, { ok: true, result: { name: 'Name' } },
    { version: DESKTOP_RPC_VERSION, ok: false, result: { name: 'Name' } },
    { version: DESKTOP_RPC_VERSION, ok: true, result: { error: 'validationNameRequired' } },
    { version: DESKTOP_RPC_VERSION, ok: true, result: {} },
    { version: DESKTOP_RPC_VERSION, ok: true, result: { name: '   ' } },
  ]) {
    await assert.rejects(saveProfileName('Name', async () => receipt))
  }
  await assert.rejects(saveProfileName('Name', async () => { throw new Error('offline') }), /offline/)
})
