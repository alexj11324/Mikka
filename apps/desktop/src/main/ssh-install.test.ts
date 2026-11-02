import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LOCAL_RECONNECT, LOCAL_TARGET } from '@mikka/protocol/bridge'
import { SshInstaller, loginShell, parseHostDetails, parseHosts, parseTarget, runProcess, type SshInstallState } from './ssh-install'

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

function localInstaller(flavor: 'prod' | 'dev', status = '{"server":"online","deviceId":"this-mac"}') {
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
    if (args.at(-1)?.startsWith('mikka daemon status')) return status
    return ''
  }, '/home/nobody', undefined, undefined, flavor, { command: '/bin/zsh', args: script => ['-lc', script] })
  return { installer, events, calls, done, minted: () => minted }
}

test('添加这台电脑 installs, starts and signs in the daemon here as a laptop, with no SSH', async () => {
  const t = localInstaller('prod')
  const first = await t.installer.beginLocal()
  assert.equal(first?.target, LOCAL_TARGET)
  await t.done
  assert.equal(t.installer.state()?.status, 'online')
  assert.equal(t.installer.state()?.deviceId, 'this-mac')
  assert.ok(t.calls.every(call => call.command === '/bin/zsh' && call.args[0] === '-lc'), 'every step runs in the login shell')
  assert.equal(t.calls.some(call => ['ssh', 'ssh-keygen', 'ssh-keyscan'].includes(call.command)), false)
  const scripts = t.calls.map(call => call.args[1])
  assert.ok(scripts.includes('npm install --global @aspectlylabs/mikka'))
  assert.ok(scripts.includes("mikka daemon service install --server 'https://example.com/mikka' --device-type laptop"))
  assert.equal(t.minted(), 1)
  assert.equal(t.calls.filter(call => call.input === 'private-token\n').length, 1)
  assert.equal(JSON.stringify(t.calls.map(call => call.args)).includes('private-token'), false)
  assert.deepEqual([...new Set(t.events.map(state => state.step))], ['check', 'install', 'service', 'connect'])
})

test('a dev desktop adds its own dev daemon', async () => {
  const t = localInstaller('dev')
  await t.installer.beginLocal()
  await t.done
  const scripts = t.calls.map(call => call.args[1])
  assert.ok(scripts.includes("mikka daemon service install --server 'https://example.com/mikka' --device-type laptop --dev"))
  assert.ok(scripts.includes("mikka daemon login --server 'https://example.com/mikka' --registration-token-stdin --dev"))
  assert.ok(scripts.includes('mikka daemon status --dev'))
})

test('重新连接 for this computer restarts its daemon and waits; it neither installs nor signs in again', async () => {
  const t = localInstaller('prod')
  const first = await t.installer.restartLocal()
  assert.equal(first?.target, LOCAL_RECONNECT)
  await t.done
  assert.equal(t.installer.state()?.status, 'online')
  const scripts = t.calls.map(call => call.args[1])
  assert.deepEqual(scripts, ["mikka daemon service install --server 'https://example.com/mikka' --device-type laptop", 'mikka daemon status'])
  assert.equal(t.minted(), 0)
})

test('the login shell is $SHELL when it is a plain path, else the platform default', () => {
  assert.equal(loginShell({ SHELL: '/opt/homebrew/bin/fish' }, 'darwin').command, '/opt/homebrew/bin/fish')
  assert.equal(loginShell({}, 'darwin').command, '/bin/zsh')
  assert.equal(loginShell({ SHELL: '/bin/bash; rm -rf ~' }, 'linux').command, '/bin/sh')
  assert.deepEqual(loginShell({}, 'linux').args('mikka daemon status'), ['-lc', 'mikka daemon status'])
})

test('automatic repair restarts a daemon that is already set up, without installing or signing in again', async () => {
  const t = localInstaller('prod')
  const first = await t.installer.repairLocal()
  assert.equal(first?.target, LOCAL_TARGET)
  await t.done
  assert.equal(t.installer.state()?.status, 'online')
  assert.deepEqual(t.calls.map(call => call.args[1]), ["mikka daemon service install --server 'https://example.com/mikka' --device-type laptop", 'mikka daemon status'])
  assert.equal(t.minted(), 0)
})

test('automatic repair installs and signs in when the restart fails (first launch)', async () => {
  const events: SshInstallState[] = []
  const scripts: string[] = []
  let restartFailed = false
  let finish!: () => void
  const done = new Promise<void>(resolve => { finish = resolve })
  const installer = new SshInstaller('https://example.com/mikka', async () => 'private-token', state => {
    events.push(state)
    if (state.status === 'online' || state.status === 'failed') finish()
  }, async (_command, args) => {
    scripts.push(args[1])
    if (args[1].startsWith('mikka daemon service install') && !restartFailed) { restartFailed = true; throw new Error('zsh: command not found: mikka') }
    if (args[1].startsWith('mikka daemon status')) return '{"server":"online","deviceId":"this-mac"}'
    return ''
  }, '/home/nobody', undefined, undefined, 'prod', { command: '/bin/zsh', args: script => ['-lc', script] })
  await installer.repairLocal()
  await done
  assert.equal(installer.state()?.status, 'online')
  assert.ok(scripts.includes('npm install --global @aspectlylabs/mikka'))
  assert.ok(scripts.some(script => script.startsWith('mikka daemon login')))
  assert.equal(events.every(state => state.target === LOCAL_TARGET), true)
})

test('a failed automatic install keeps the reason and 重试 installs again', async () => {
  let attempt = 0
  let settle!: (state: SshInstallState) => void
  let settled = new Promise<SshInstallState>(resolve => { settle = resolve })
  const installer = new SshInstaller('https://example.com/mikka', async () => 'private-token', state => {
    if (state.status === 'online' || state.status === 'failed') settle(state)
  }, async (_command, args) => {
    if (args[1] === 'npm install --global @aspectlylabs/mikka' && attempt++ === 0) throw new Error('npm ERR! code EACCES')
    if (args[1].startsWith('mikka daemon status')) return '{"server":"online","deviceId":"this-mac"}'
    return ''
  }, '/home/nobody', undefined, undefined, 'prod', { command: '/bin/zsh', args: script => ['-lc', script] })
  await installer.beginLocal()
  const failed = await settled
  assert.equal(failed.status, 'failed')
  assert.equal(failed.step, 'install')
  assert.match(failed.reason ?? '', /EACCES/)
  settled = new Promise<SshInstallState>(resolve => { settle = resolve })
  await installer.beginLocal()
  assert.equal((await settled).status, 'online')
})

