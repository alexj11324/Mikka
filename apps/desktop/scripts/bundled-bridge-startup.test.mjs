import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../../..', import.meta.url))
async function fixture() {
  const handlers = new Map()
  const output = await build({
    absWorkingDir: root, entryPoints: ['apps/desktop/src/main/bundled-bridge.ts'],
    write: false, bundle: true, platform: 'node', format: 'cjs',
    tsconfig: join(root, 'apps/desktop/tsconfig.json'),
    plugins: [{ name: 'electron-ipc-boundary', setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'ipc', namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const ipcMain = globalThis.fixtureIPC', loader: 'js' }))
    } }],
  })
  const module = { exports: {} }
  runInNewContext(output.outputFiles[0].text, { module, exports: module.exports, URL,
    fixtureIPC: { handle: (name, fn) => { handlers.set(name, fn) } },
  })
  let restore, reads = 0
  const restoring = new Promise(resolve => { restore = resolve })
  const auth = { whenRestored: () => restoring, session: () => { reads++; return { user: { id: 'retained' }, session: { id: 'public-session' } } } }
  const channels = { closeOwner: () => {} }
  module.exports.registerBundledBridge(auth, channels, channels)
  const sessionHandler = [...handlers.entries()].find(([key]) => key.includes('session') && !key.includes('changed'))?.[1]
  assert.equal(typeof sessionHandler, 'function')
  const frame = { url: 'mikka://app/mikka', parent: null }
  let destroyed = false
  const event = { senderFrame: frame, sender: { id: 1, once: () => {}, on: () => {}, isDestroyed: () => destroyed } }
  return { sessionHandler, event, restore, state: () => ({ reads }), destroy: () => { destroyed = true } }
}

test('bundled IPC does not return a false signed-out projection while the vault is restoring', async () => {
  const { sessionHandler, event, restore, state } = await fixture()
  let finished = false
  const result = sessionHandler(event).then(value => { finished = true; return value })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(finished, false)
  assert.equal(state().reads, 0)
  restore()
  assert.equal((await result).user.id, 'retained')
  assert.equal(state().reads, 1)
})

test('a destroyed or newly untrusted sender cannot run queued IPC after restoration', async t => {
  for (const reason of ['destroyed', 'navigation']) await t.test(reason, async () => {
    const { sessionHandler, event, restore, state, destroy } = await fixture()
    const result = sessionHandler(event)
    if (reason === 'destroyed') destroy()
    else event.senderFrame = { url: 'https://foreign.invalid/', parent: null }
    const rejected = assert.rejects(result, error => error.message === 'desktop_request_failed')
    restore()
    await rejected
    assert.equal(state().reads, 0)
  })
})
