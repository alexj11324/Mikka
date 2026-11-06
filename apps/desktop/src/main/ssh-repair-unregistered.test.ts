import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { test, type TestContext } from 'node:test'
import { SshInstaller, type SshInstallState } from './ssh-install'

async function settle(t: TestContext, installer: SshInstaller) {
  // Exercise the real async installer. Virtual time only avoids spending the
  // old thirty status sleeps before exposing its unnecessary second install.
  for (let attempt = 0; attempt < 40 && installer.state()?.status === 'running'; attempt++) {
    await setImmediate()
    t.mock.timers.tick(1000)
  }
  await setImmediate()
  assert.notEqual(installer.state()?.status, 'running', 'The installer must settle')
}

function recoveredUnregistered(options: { denied?: boolean; owned?: boolean } = {}) {
  const calls: { script: string; input?: string }[] = []
  const events: SshInstallState[] = []
  const verified: { deviceId: string; ownerId?: string }[] = []
  let serviceInstalls = 0, minted = 0, signedIn = false
  const installer = new SshInstaller('https://example.com/mikka', async () => {
    minted++
    if (options.denied) throw new Error('Sign in to register a device')
    return 'private-registration-token'
  }, state => { events.push(state) }, async (_command, args, input) => {
    const script = args[1]
    calls.push({ script, input })
    if (script.startsWith('mikka daemon service install')) {
      if (++serviceInstalls > 1) throw new Error('Bootstrap failed: 5: Input/output error')
    }
    if (script.startsWith('mikka daemon login')) signedIn = true
    if (script.startsWith('mikka daemon status')) return JSON.stringify(signedIn
      ? { server: 'online', deviceId: 'current-device' }
      : { server: 'unregistered', deviceId: null, signedIn: false })
    return ''
  }, '/home/nobody', undefined, undefined, 'dev',
  { command: '/bin/zsh', args: script => ['-lc', script] },
  async (deviceId, ownerId) => { verified.push({ deviceId, ownerId }); return options.owned !== false })
  return { installer, calls, events, verified, serviceInstalls: () => serviceInstalls, minted: () => minted }
}

test('repair registers an already running unregistered daemon without reinstalling it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const flow = recoveredUnregistered()
  await flow.installer.repairLocal('current-owner')
  await settle(t, flow.installer)
  assert.equal(flow.installer.state()?.status, 'online')
  assert.equal(flow.installer.state()?.deviceId, 'current-device')
  assert.equal(flow.serviceInstalls(), 1)
  assert.equal(flow.minted(), 1)
  assert.deepEqual(flow.verified, [{ deviceId: 'current-device', ownerId: 'current-owner' }])
  assert.deepEqual(flow.calls.map(call => call.script), [
    "mikka daemon service install --server 'https://example.com/mikka' --device-type laptop --dev",
    'mikka daemon status --dev',
    "mikka daemon login --server 'https://example.com/mikka' --registration-token-stdin --dev",
    'mikka daemon status --dev',
  ])
  assert.deepEqual(flow.calls.filter(call => call.input).map(call => call.input), ['private-registration-token\n'])
  assert.equal(JSON.stringify(flow.events).includes('private-registration-token'), false)
  assert.equal(flow.calls.some(call => call.script.includes('private-registration-token')), false)
  assert.deepEqual([...new Set(flow.events.map(state => state.step))], ['service', 'connect'])
})

test('recovered daemon registration denial fails without another install or credential attempt', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const flow = recoveredUnregistered({ denied: true })
  await flow.installer.repairLocal('current-owner')
  await settle(t, flow.installer)
  assert.equal(flow.installer.state()?.status, 'failed')
  assert.equal(flow.installer.state()?.step, 'connect')
  assert.equal(flow.installer.state()?.reason, 'Sign in to register a device')
  assert.equal(flow.serviceInstalls(), 1)
  assert.equal(flow.minted(), 1)
  assert.equal(flow.calls.some(call => call.script.startsWith('npm ') || call.script.startsWith('mikka daemon login')), false)
  assert.deepEqual(flow.verified, [])
})

test('recovered daemon registration still rejects a device owned by another account', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const flow = recoveredUnregistered({ owned: false })
  await flow.installer.repairLocal('current-owner')
  await settle(t, flow.installer)
  assert.equal(flow.installer.state()?.status, 'failed')
  assert.equal(flow.installer.state()?.step, 'connect')
  assert.equal(flow.installer.state()?.reason, 'Device does not belong to the signed-in account')
  assert.equal(flow.serviceInstalls(), 1)
  assert.equal(flow.minted(), 1)
  assert.deepEqual(flow.verified, [{ deviceId: 'current-device', ownerId: 'current-owner' }])
  assert.equal(flow.events.some(state => state.status === 'online'), false)
})

test('repair does not replace a starting or unconfirmed credential based on the initial server state', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const signedIn of [true, undefined]) {
    const scripts: string[] = []
    let reads = 0, minted = 0
    const installer = new SshInstaller('https://example.com/mikka', async () => {
      minted++; throw new Error('must not mint while a credential may exist')
    }, undefined, async (_command, args) => {
      scripts.push(args[1])
      if (args[1].startsWith('mikka daemon status')) return JSON.stringify(++reads === 1
        ? { server: 'unregistered', signedIn, deviceId: 'current-device' }
        : { server: 'online', signedIn: true, deviceId: 'current-device' })
      return ''
    }, '/home/nobody', undefined, undefined, 'dev',
    { command: '/bin/zsh', args: script => ['-lc', script] },
    async (deviceId, ownerId) => deviceId === 'current-device' && ownerId === 'current-owner')
    await installer.repairLocal('current-owner')
    await settle(t, installer)
    assert.equal(installer.state()?.status, 'online')
    assert.equal(minted, 0)
    assert.equal(reads, 2)
    assert.equal(scripts.filter(script => script.startsWith('mikka daemon service install')).length, 1)
    assert.equal(scripts.some(script => script.startsWith('mikka daemon login') || script.startsWith('npm ')), false)
  }
})
