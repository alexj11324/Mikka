import test from 'node:test'
import assert from 'node:assert/strict'

import { ResponseError } from '@mikka/daemon/client'
import { defaultDataDir } from '@mikka/daemon/paths'

import { updateLocalDaemon, type DaemonUpdateConnect } from './daemon-update'

const env = { HOME: '/home/person', MIKKA_USER_DATA_DIR: '/tmp/mikka-dev-worktree' }

function daemon(answer: () => Promise<unknown>) {
  const calls: Array<{ dataDir: string; method: string }> = []
  let closed = 0
  const connect: DaemonUpdateConnect = async dataDir => ({
    request: async (method: 'daemon.update') => { calls.push({ dataDir, method }); return answer() as never },
    close: () => { closed++ },
  })
  return { connect, calls, closed: () => closed }
}

test('asks the daemon on this computer to update and passes on its answer', async () => {
  for (const state of ['installing', 'waiting', 'current', 'unmanaged'] as const) {
    const local = daemon(async () => ({ state }))
    assert.equal(await updateLocalDaemon('prod', { connect: local.connect, env }), state)
    assert.deepEqual(local.calls.map(call => call.method), ['daemon.update'])
    assert.equal(local.closed(), 1)
  }
})

test('the dev app reaches only the dev daemon; the production app only the production one', async () => {
  const dev = daemon(async () => ({ state: 'unmanaged' }))
  await updateLocalDaemon('dev', { connect: dev.connect, env })
  const prod = daemon(async () => ({ state: 'current' }))
  await updateLocalDaemon('prod', { connect: prod.connect, env })
  assert.equal(dev.calls[0]?.dataDir, defaultDataDir('dev', env))
  assert.equal(prod.calls[0]?.dataDir, defaultDataDir('prod', env))
  assert.notEqual(dev.calls[0]?.dataDir, prod.calls[0]?.dataDir)
  assert.equal(prod.calls[0]?.dataDir.startsWith('/tmp/mikka-dev-worktree'), false)
})

test('no daemon on this computer: nothing is asked', async () => {
  for (const code of ['ENOENT', 'ECONNREFUSED']) {
    const result = await updateLocalDaemon('prod', { connect: async () => { throw Object.assign(new Error('missing'), { code }) }, env })
    assert.equal(result, 'absent')
  }
})

test('an older daemon without daemon.update keeps its own hourly check', async () => {
  const local = daemon(async () => { throw new ResponseError(-32601, 'Unknown method daemon.update') })
  assert.equal(await updateLocalDaemon('prod', { connect: local.connect, env }), 'unsupported')
  assert.equal(local.closed(), 1)
})

test('a failed request never throws into the app launch', async () => {
  const local = daemon(async () => { throw new Error('socket closed') })
  assert.equal(await updateLocalDaemon('prod', { connect: local.connect, env }), 'failed')
  assert.equal(await updateLocalDaemon('prod', { connect: async () => { throw new Error('daemon connect timeout') }, env }), 'failed')
})
