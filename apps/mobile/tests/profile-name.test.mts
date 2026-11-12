import assert from 'node:assert/strict'
import test from 'node:test'
import { DESKTOP_RPC_VERSION } from '../../../lib/desktop-rpc/wire'
import { saveProfileName } from '../lib/profile-name'

test('the native profile uses the same registered account action as Web and accepts its saved name', async () => {
  let finish!: (receipt: { version: number; ok: boolean; result: { name: string } }) => void
  const pending = new Promise<Parameters<typeof finish>[0]>(resolve => { finish = resolve })
  const write = saveProfileName(' Name ', async (path, init) => {
    assert.equal(path, '/api/rpc')
    assert.deepEqual(init, {
      method: 'POST', body: { version: DESKTOP_RPC_VERSION, action: 'account.updateDisplayName', args: [' Name '] },
    })
    return pending
  })
  finish({ version: DESKTOP_RPC_VERSION, ok: true, result: { name: 'Name' } })
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
