import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SshInstaller, parseHostDetails, parseHosts, parseTarget, runProcess, type SshInstallState } from './ssh-install'

test('SSH host parsing rejects options, commands and invalid ports', () => {
  assert.deepEqual(parseTarget('deploy@build-01:2222'), { destination: 'deploy@build-01', host: 'build-01', port: '2222' })
  for (const bad of ['-oProxyCommand=bad', 'host;id', 'user@-host', 'host:0', 'host:65536', 'host:22 extra', 'x\ncommand']) assert.throws(() => parseTarget(bad))
  assert.deepEqual(parseHosts('# Host fake\nHost build-01 build-02 *.internal !except\n User root\nHost build-01\nHost *\n'), ['build-01', 'build-02'])
})

test('first key requires explicit confirmation, then follows all steps without exposing the token', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mikka-ssh-'))
  const events: SshInstallState[] = []
  const calls: { command: string; args: string[]; input?: string }[] = []
  let minted = 0
  let finish!: () => void
  const done = new Promise<void>(resolve => { finish = resolve })
  const installer = new SshInstaller('https://example.com/mikka', async () => { minted++; return 'private-token' }, state => {
    events.push(state)
    if (state.status === 'online' || state.status === 'failed') finish()
  }, async (command, args, input) => {
    calls.push({ command, args, input })
    if (args.includes('-G')) return 'hostname example.com\nport 2222'
    if (command === 'ssh-keygen') throw new Error('not found')
    if (command === 'ssh-keyscan') return '[example.com]:2222 ssh-ed25519 YWJj'
    if (args.at(-1) === 'mikka daemon status') return '{"server":"online","deviceId":"connected-device"}'
    return ''
  }, home)
  try {
    const first = await installer.begin('deploy@example.com:2222')
    assert.equal(first?.status, 'fingerprint')
    assert.match(first!.fingerprint!, /^SHA256:/)
    assert.equal(first!.keyType, 'ED25519')
    assert.equal(minted, 0)
    assert.equal(calls.some(call => call.args.at(-1)?.includes('npm install')), false)
    await assert.rejects(installer.accept('wrong-id'))
    await installer.accept(first!.id)
    await done
    assert.equal(installer.state()?.status, 'online')
    assert.equal(installer.state()?.deviceId, 'connected-device')
    assert.deepEqual([...new Set(events.map(state => state.step))], ['login', 'check', 'install', 'service', 'connect'])
    assert.match(await readFile(join(home, '.ssh/known_hosts'), 'utf8'), /ssh-ed25519 YWJj/)
    assert.equal(minted, 1)
    assert.equal(calls.filter(call => call.input === 'private-token\n').length, 1)
    assert.equal(JSON.stringify(events).includes('private-token'), false)
    assert.equal(calls.some(call => call.args.join(' ').includes('private-token')), false)
    assert.ok(calls.find(call => call.args.at(-1) === 'npm install --global @aspectlylabs/mikka'))
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('host check failure names the step, keeps the reason and allows retry', async () => {
  let finish!: () => void
  const done = new Promise<void>(resolve => { finish = resolve })
  const installer = new SshInstaller('https://example.com/mikka', async () => { throw new Error('must not mint') }, state => {
    if (state.status === 'failed') finish()
  }, async (command, args) => {
    if (args.includes('-G')) return 'hostname example.com\nport 22'
    if (command === 'ssh-keygen') return 'known key'
    if (args.at(-1)?.includes('uname')) throw new Error('Node.js >=24 required')
    return ''
  })
  await installer.begin('example.com')
  await done
  assert.equal(installer.state()?.step, 'check')
  assert.equal(installer.state()?.retryable, true)
  assert.equal(installer.state()?.reason, 'Node.js >=24 required')
})

test('failures identify the exact installation step and never advance past it', async () => {
  for (const step of ['login', 'check', 'install', 'service', 'connect'] as const) {
    let finish!: () => void
    const done = new Promise<void>(resolve => { finish = resolve })
    const events: SshInstallState[] = []
    const installer = new SshInstaller('https://example.com/mikka', async () => { throw new Error('registration denied') }, state => {
      events.push(state)
      if (state.status === 'failed') finish()
    }, async (command, args) => {
      if (args.includes('-G')) return 'hostname example.com\nport 22'
      if (command === 'ssh-keygen') return 'known key'
      const remote = args.at(-1) ?? ''
      if ((step === 'login' && remote === 'true') || (step === 'check' && remote.includes('uname')) || (step === 'install' && remote.startsWith('npm install')) || (step === 'service' && remote.includes('service install'))) throw new Error(`${step} rejected`)
      return ''
    })
    await installer.begin('example.com')
    await done
    assert.equal(installer.state()?.step, step)
    assert.equal(installer.state()?.status, 'failed')
    assert.equal(events.at(-1)?.retryable, true)
    assert.equal(events.some(event => event.status === 'online'), false)
  }
})

test('process runner returns output and maps failures and timeouts', async () => {
  assert.equal(await runProcess(process.execPath, ['-e', 'console.log("ready")']), 'ready')
  await assert.rejects(runProcess(process.execPath, ['-e', 'console.error("permission denied");process.exit(1)']), /permission denied/)
  await assert.rejects(runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], undefined, 50), /timed out/)
})

test('host details use OpenSSH resolution, with explicit aliases only', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mikka-ssh-hosts-'))
  try {
    await mkdir(join(home, '.ssh'))
    await writeFile(join(home, '.ssh/config'), 'Host build backup *.private\n  User alex\n')
    const installer = new SshInstaller('https://example.com/mikka', async () => '', undefined, async (command, args) => {
      assert.equal(command, 'ssh')
      assert.equal(args[0], '-G')
      return `user alex\nhostname ${args.at(-1) === 'build' ? '10.0.4.12' : '10.0.4.13'}\nport 2222\n`
    }, home)
    assert.deepEqual(await installer.hosts(), [
      { alias: 'build', user: 'alex', hostName: '10.0.4.12', port: 2222 },
      { alias: 'backup', user: 'alex', hostName: '10.0.4.13', port: 2222 },
    ])
    assert.deepEqual(parseHostDetails('user alex\nhostname host\nport 22'), { user: 'alex', hostName: 'host', port: 22 })
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('cancel kills the in-flight process, preserves the step, and retry completes', async () => {
  const events: SshInstallState[] = []
  let installStarted!: () => void
  const installing = new Promise<void>(resolve => { installStarted = resolve })
  let online!: () => void
  const done = new Promise<void>(resolve => { online = resolve })
  let mintCount = 0
  let block = true
  let killed = false
  const installer = new SshInstaller('https://example.com/mikka', async () => { mintCount++; return 'synthetic-grant' }, state => {
    events.push(state)
    if (state.status === 'online') online()
  }, async (command, args, input, timeout, signal) => {
    if (args.includes('-G')) return 'hostname example.com\nport 22'
    if (command === 'ssh-keygen') return 'known key'
    if (args.at(-1)?.startsWith('npm install') && block) {
      installStarted()
      try {
        await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], input, timeout, signal)
      } catch (error) { killed = signal?.aborted === true; throw error }
    }
    if (args.at(-1) === 'mikka daemon status') return '{"server":"online"}'
    return ''
  })
  await installer.begin('example.com')
  await installing
  const id = installer.state()!.id
  await assert.rejects(installer.cancel('foreign-id'))
  const cancelled = await installer.cancel(id)
  assert.equal(killed, true)
  assert.equal(cancelled?.reason, 'cancelled')
  assert.equal(cancelled?.retryable, true)
  assert.equal(cancelled?.status, 'failed')
  assert.equal(cancelled?.step, 'install')
  assert.equal(mintCount, 0)
  assert.equal(events.some(event => event.step === 'service'), false)
  block = false
  await installer.begin('example.com')
  await done
  assert.notEqual(installer.state()?.id, id)
  assert.equal(installer.state()?.status, 'online')
  assert.equal(mintCount, 1)
  assert.equal(events.filter(event => event.id === id).at(-1)?.reason, 'cancelled')
})

test('cancel during host discovery and fingerprint confirmation never installs', async () => {
  for (const phase of ['discovery', 'fingerprint']) {
    let discovered!: () => void
    const discovery = new Promise<void>(resolve => { discovered = resolve })
    let installed = false
    const installer = new SshInstaller('https://example.com/mikka', async () => { throw new Error('must not mint') }, undefined, async (command, args, input, timeout, signal) => {
      if (args.includes('-G')) {
        discovered()
        if (phase === 'discovery') await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], input, timeout, signal)
        return 'hostname example.com\nport 22'
      }
      if (command === 'ssh-keygen') throw new Error('unknown host')
      if (command === 'ssh-keyscan') return 'example.com ssh-ed25519 YWJj'
      installed = true
      return ''
    })
    const starting = installer.begin('example.com')
    await discovery
    if (phase === 'fingerprint') await starting
    await installer.cancel(installer.state()!.id)
    await starting
    assert.equal(installer.state()?.reason, 'cancelled')
    assert.equal(installed, false)
    await assert.rejects(installer.accept(installer.state()!.id))
  }
})
