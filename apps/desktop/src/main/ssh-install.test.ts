import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LOCAL_RECONNECT, LOCAL_TARGET } from '@mikka/protocol/bridge'
import { CommandFailed } from '../../../../lib/local-setup-failure'
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

test('cancelled and timed out commands stop their own installer descendants', { skip: process.platform === 'win32', timeout: 10_000 }, async () => {
  for (const mode of ['cancel', 'timeout']) {
    const directory = await mkdtemp(join(tmpdir(), 'mikka-installer-process-'))
    const pidFile = join(directory, 'child.pid')
    const beatFile = join(directory, 'heartbeat')
    const controller = new AbortController()
    let pid: number | undefined
    let failure: unknown
    try {
      const leaf = `const fs=require('node:fs');setInterval(()=>fs.writeFileSync(${JSON.stringify(beatFile)},String(Date.now())),20)`
      const parent = `const{spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000)`
      const running = runProcess(process.execPath, ['-e', parent], undefined, mode === 'timeout' ? 1500 : 5000, controller.signal)
      // Attach before waiting for the child, so an actual early failure is not
      // an unhandled rejection. The assertion below still observes the result.
      running.catch(() => {})
      const deadline = Date.now() + 1000
      let heartbeat: string | undefined
      while (!heartbeat && Date.now() < deadline) {
        try { pid = Number(await readFile(pidFile, 'utf8')); heartbeat = await readFile(beatFile, 'utf8') } catch { /* Child has not started yet. */ }
        if (!heartbeat) await new Promise(done => setTimeout(done, 20))
      }
      assert.ok(heartbeat && Number.isSafeInteger(pid) && pid! > 1, 'The real descendant must be running before cancellation')
      if (mode === 'cancel') controller.abort()
      await assert.rejects(running, { message: mode === 'cancel' ? 'cancelled' : 'SSH operation timed out' })
      const stopped = await readFile(beatFile, 'utf8')
      await new Promise(done => setTimeout(done, 120))
      assert.equal(await readFile(beatFile, 'utf8'), stopped, 'A completed cancellation must leave no installer descendant writing')
    } catch (error) { failure = error
    } finally {
      controller.abort()
      // Only the exact test-owned descendant is eligible for fallback cleanup
      // if the regression reappears; no scan or broad process matching.
      if (pid) { try { process.kill(pid, 'SIGKILL') } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure = new AggregateError([...(failure ? [failure] : []), error], 'Fixture process cleanup failed')
      } }
      await rm(directory, { recursive: true, force: true })
    }
    if (failure) throw failure
  }
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

function localInstaller(flavor: 'prod' | 'dev', status = '{"server":"online","deviceId":"this-mac"}', respond?: (script: string) => string | undefined) {
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
    const answer = respond?.(args.at(-1) ?? '')
    if (answer !== undefined) return answer
    if (args.at(-1)?.includes('mikka daemon status')) return status
    return ''
  }, '/home/nobody', undefined, undefined, flavor, { command: '/bin/zsh', args: script => ['-lc', script] }, async () => true)
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

test('automatic repair never reports another account\'s recovered daemon as this person\'s device', async () => {
  const events: SshInstallState[] = []
  let deviceId = 'device-a', minted = 0
  let finish!: () => void
  const done = new Promise<void>(resolve => { finish = resolve })
  const installer = new SshInstaller('https://example.com/mikka', async () => { minted++; return 'private-token-b' }, state => {
    events.push(state)
    if (state.status === 'online' || state.status === 'failed') finish()
  }, async (_command, args) => {
    const script = args[1]
    if (script.startsWith('mikka daemon login')) deviceId = 'device-b'
    if (script.startsWith('mikka daemon status')) return JSON.stringify({ server: 'online', deviceId })
    return ''
  }, '/home/nobody', undefined, undefined, 'prod', { command: '/bin/zsh', args: script => ['-lc', script] }, async (id: string) => id === 'device-b')
  await installer.repairLocal()
  await done
  assert.equal(installer.state()?.deviceId, 'device-b')
  assert.equal(minted, 1)
  assert.ok(events.every(state => state.status !== 'online' || state.deviceId === 'device-b'))
})

test('an unconfirmed account fails repair without registering again or reporting online', async () => {
  let minted = 0
  let finish!: () => void
  const done = new Promise<void>(resolve => { finish = resolve })
  const installer = new SshInstaller('https://example.com/mikka', async () => { minted++; return 'private-token' }, state => {
    if (state.status === 'online' || state.status === 'failed') finish()
  }, async (_command, args) => args[1].startsWith('mikka daemon status') ? '{"server":"online","deviceId":"device-a"}' : '',
  '/home/nobody', undefined, undefined, 'prod', { command: '/bin/sh', args: script => ['-lc', script] }, async () => { throw new Error('session changed or unavailable') })
  await installer.repairLocal('owner-a')
  await done
  assert.equal(installer.state()?.status, 'failed')
  assert.equal(installer.state()?.reason, 'Device account could not be confirmed')
  assert.equal(minted, 0)
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
  }, '/home/nobody', undefined, undefined, 'prod', { command: '/bin/zsh', args: script => ['-lc', script] }, async () => true)
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
    if (args[1] === 'npm install --global @aspectlylabs/mikka' && attempt++ === 0) throw new Error('npm ERR! code ETIMEDOUT')
    if (args[1].startsWith('mikka daemon status')) return '{"server":"online","deviceId":"this-mac"}'
    return ''
  }, '/home/nobody', undefined, undefined, 'prod', { command: '/bin/zsh', args: script => ['-lc', script] }, async () => true)
  await installer.beginLocal()
  const failed = await settled
  assert.equal(failed.status, 'failed')
  assert.equal(failed.step, 'install')
  assert.match(failed.reason ?? '', /ETIMEDOUT/)
  settled = new Promise<SshInstallState>(resolve => { settle = resolve })
  await installer.beginLocal()
  assert.equal((await settled).status, 'online')
})


test('a failure shows the real npm error, not its warnings, with the whole output kept for 详情', async () => {
  const stderr = 'npm warn deprecated @opentelemetry/sdk-trace-base@2.12.0: Use @opentelemetry/sdk-trace package\nnpm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@aspectlylabs%2fmikka'
  const t = localInstaller('prod', undefined, script => { if (script.startsWith('npm install')) throw new CommandFailed(1, stderr) })
  await t.installer.beginLocal()
  await t.done
  const state = t.installer.state()!
  assert.equal(state.status, 'failed')
  assert.equal(state.detail, 'npm_package_not_found')
  assert.equal(state.reason, 'code E404\n404 Not Found - GET https://registry.npmjs.org/@aspectlylabs%2fmikka')
  assert.equal(state.log, stderr)
})

test('a login shell with an old Node uses a newer installed one for every later step', async () => {
  let checks = 0
  const t = localInstaller('prod', undefined, script => {
    if (script.includes('process.versions.node.split') && !script.startsWith('PATH=') && ++checks) throw new CommandFailed(1, 'Node.js >=24 required (found v22.11.0 at /opt/homebrew/bin/node)')
    if (script.includes('--version 2>/dev/null')) return 'v22.11.0 /opt/homebrew/bin\nv24.1.0 /Users/a/.nvm/versions/node/v24.1.0/bin\nv20.0.0 /usr/local/bin'
  })
  await t.installer.beginLocal()
  await t.done
  assert.equal(t.installer.state()?.status, 'online')
  assert.equal(checks, 1)
  const later = t.calls.map(call => call.args[1]).filter(script => script.includes('npm install') || script.includes('mikka daemon'))
  assert.ok(later.length >= 3)
  for (const script of later) assert.ok(script.startsWith("PATH='/Users/a/.nvm/versions/node/v24.1.0/bin':\"$PATH\"; "), script)
})

test('with no new enough Node the failure names the one the login shell found', async () => {
  const t = localInstaller('prod', undefined, script => {
    if (script.includes('process.versions.node.split')) throw new CommandFailed(1, 'Node.js >=24 required (found v22.11.0 at /opt/homebrew/bin/node)')
    if (script.includes('--version 2>/dev/null')) return 'v22.11.0 /opt/homebrew/bin'
  })
  await t.installer.beginLocal()
  await t.done
  const state = t.installer.state()!
  assert.equal(state.detail, 'node_too_old')
  assert.deepEqual(state.values, { required: '24', found: '22', path: '/opt/homebrew/bin/node' })
})

test('a root-owned npm prefix installs into the user prefix and runs mikka from there', async () => {
  const eacces = 'npm warn deprecated x\nnpm error code EACCES\nnpm error syscall mkdir\nnpm error path /usr/local/lib/node_modules/@aspectlylabs\nnpm error errno -13'
  const t = localInstaller('prod', undefined, script => { if (script === 'npm install --global @aspectlylabs/mikka') throw new CommandFailed(243, eacces) })
  await t.installer.beginLocal()
  await t.done
  assert.equal(t.installer.state()?.status, 'online')
  const scripts = t.calls.map(call => call.args[1])
  assert.ok(!scripts.includes('npm install --global @aspectlylabs/mikka --cache "$HOME/.mikka/npm-cache"'))
  assert.ok(scripts.includes('npm install --global @aspectlylabs/mikka --cache "$HOME/.mikka/npm-cache" --prefix "$HOME/.mikka/npm"'))
  assert.ok(scripts.includes(`PATH="$HOME/.mikka/npm/bin":"$PATH"; mikka daemon service install --server 'https://example.com/mikka' --device-type laptop`))
})

test('a root-owned npm cache retries with Mikka\'s own cache and keeps the global prefix', async () => {
  const cache = 'npm error code EACCES\nnpm error syscall open\nnpm error path /Users/a/.npm/_cacache/tmp/abc\nnpm error Your cache folder contains root-owned files'
  const t = localInstaller('prod', undefined, script => { if (script === 'npm install --global @aspectlylabs/mikka') throw new CommandFailed(1, cache) })
  await t.installer.beginLocal()
  await t.done
  assert.equal(t.installer.state()?.status, 'online')
  const scripts = t.calls.map(call => call.args[1])
  assert.ok(scripts.includes('npm install --global @aspectlylabs/mikka --cache "$HOME/.mikka/npm-cache"'))
  assert.ok(scripts.includes("mikka daemon service install --server 'https://example.com/mikka' --device-type laptop"))
})
