import assert from 'node:assert/strict'
import { test, mock } from 'node:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import type { MikkaBridge } from '../../packages/protocol/src/bridge'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { SshInstaller, runProcess } from '../../apps/desktop/src/main/ssh-install'

// The runner starts a disposable SSH/systemd container and copies the packed daemon to /tmp/mikka.tgz.
test('real SSH install → systemd → automatic npm update → opt-out/failure → commands → uninstall', { timeout: 480_000 }, async () => {
  const container = process.env.MIKKA_SSH_TEST_CONTAINER
  if (!container || !/^mikka-491-[a-z0-9-]+$/.test(container)) throw new Error('Disposable SSH fixture required')
  const home = await mkdtemp(join(tmpdir(), 'mikka-ssh-e2e-'))
  const key = join(home, 'id_ed25519')
  const deviceId = randomUUID(), workspaceId = randomUUID()
  const credential = `orv_${'t'.repeat(43)}`
  let enrollments = 0, registrations = 0, heartbeats = 0
  let reportedVersion = '', latestVersion = '1.0.0', registryQueries = 0, failedDownloads = 0
  const tarballs = new Map<string, Buffer>()
  for (const [version, path] of Object.entries(JSON.parse(process.env.MIKKA_SSH_TEST_TARBALLS ?? '{}') as Record<string, string>)) tarballs.set(version, await readFile(path))
  assert.deepEqual([...tarballs.keys()], ['1.0.0', '1.0.1'])
  const { dependencies: sourceDependencies } = JSON.parse(await readFile(new URL('../../packages/daemon/package.json', import.meta.url), 'utf8'))
  const dependencies = Object.fromEntries(Object.entries(sourceDependencies).filter(([name]) => name !== '@mikka/protocol'))
  let command: { id: string; kind: 'redetect' | 'restart' | 'uninstall' } | undefined
  let removed = false, revoked = false
  const acked = new Set<string>()
  let tunnel: ChildProcess | undefined
  const server = createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = raw ? JSON.parse(raw) : {}
    response.setHeader('content-type', 'application/json')
    const route = request.url ?? ''
    if (route.startsWith('/registry/')) {
      response.setHeader('cache-control', 'no-store')
      if (route.endsWith('.tgz')) {
        const version = route.split('/').at(-1)!.slice(0, -4)
        const tarball = tarballs.get(version)
        if (!tarball) { failedDownloads++; response.writeHead(503).end('{}'); return }
        response.setHeader('content-type', 'application/octet-stream')
        response.end(tarball); return
      }
      registryQueries++
      const versions = Object.fromEntries(['1.0.0', '1.0.1', '1.0.2'].map(version => [version, {
        name: '@aspectlylabs/mikka', version, dependencies, bin: { mikka: './mikka.js' }, engines: { node: '>=24' },
        dist: { tarball: `http://127.0.0.1:34991/registry/${version}.tgz`, ...(tarballs.has(version) ? { integrity: `sha512-${createHash('sha512').update(tarballs.get(version)!).digest('base64')}` } : {}) },
      }]))
      const suffix = decodeURIComponent(route).split('/').at(-1)
      response.end(JSON.stringify(suffix === 'latest' ? versions[latestVersion] : { name: '@aspectlylabs/mikka', 'dist-tags': { latest: latestVersion }, versions })); return
    }
    if (route.endsWith('/enroll')) { enrollments++; response.end(JSON.stringify({ credential })); return }
    if (request.headers.authorization !== `Bearer ${credential}`) { response.writeHead(401).end('{}'); return }
    if (revoked || (removed && !route.endsWith('/heartbeat'))) { response.writeHead(401).end('{}'); return }
    if (route.endsWith('/register')) {
      assert.equal(body.deviceType, 'server'); registrations++; reportedVersion = body.daemonVersion
      response.end(JSON.stringify({ deviceId, workspaceId })); return
    }
    if (route.endsWith('/heartbeat')) {
      heartbeats++
      if (command) console.log(JSON.stringify({ heartbeat: heartbeats, command: command.kind, acknowledged: (body.completedDeviceCommands ?? []).includes(command.id) }))
      for (const id of body.completedDeviceCommands ?? []) acked.add(id)
      if (command?.kind === 'uninstall' && acked.has(command.id)) revoked = true
      response.end(JSON.stringify({ leases: {}, deviceCommands: command && !acked.has(command.id) ? [command] : [] })); return
    }
    if (route.endsWith('/repos')) { response.end('{"repos":[]}'); return }
    if (route.includes('/runs?')) { response.end('{"runIds":[]}'); return }
    if (route.includes('/fs/requests')) { setTimeout(() => response.end('{"requests":[]}'), 500); return }
    if (route.includes('/commands')) { setTimeout(() => response.end('{"commands":[]}'), 500); return }
    response.writeHead(404).end('{}')
  })
  try {
    await runProcess('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key])
    const pubkey = await readFile(`${key}.pub`, 'utf8')
    await runProcess('docker', ['exec', '-i', container, 'sh', '-c', 'mkdir -p /root/.ssh; chmod 700 /root/.ssh; cat > /root/.ssh/authorized_keys; chmod 600 /root/.ssh/authorized_keys'], pubkey)
    const config = join(home, 'config')
    await writeFile(config, `Host fixture\n HostName 127.0.0.1\n User root\n Port 22491\n IdentityFile ${key}\n IdentitiesOnly yes\n`)
    server.listen(0, '0.0.0.0')
    await once(server, 'listening')
    const port = (server.address() as { port: number }).port
    const installer = new SshInstaller('http://127.0.0.1:34991/mikka', async () => { return `orv_${'g'.repeat(43)}` }, () => {}, runProcess, home, process.env.MIKKA_SSH_TEST_INSTALL_COMMAND ?? 'npm install --global /tmp/mikka.tgz', config)
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    mock.module(createRequire(new URL('../../apps/desktop/package.json', import.meta.url)).resolve('electron'), { namedExports: {
      ipcMain: { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, handler) },
      webContents: { getAllWebContents: () => [] },
    } })
    const { registerBridge } = await import('../../apps/desktop/src/main/bridge')
    const appUrl = 'https://app.example.test/mikka'
    registerBridge({ appUrl, mintEnrollment: async () => '', openExternal: async () => {}, localDevice: async () => ({}), quota: async () => ({}), notifications: {}, consumePendingClick: () => null } as unknown as Parameters<typeof registerBridge>[0], installer)
    let bridge!: MikkaBridge
    runInNewContext(await readFile(new URL('../../apps/desktop/dist/preload.cjs', import.meta.url), 'utf8'), {
      window: { location: { origin: new URL(appUrl).origin } },
      document: { documentElement: { dataset: {} } },
      process: { platform: 'linux', argv: [`--mikka-app-origin=${new URL(appUrl).origin}`] },
      require: () => ({
        contextBridge: { exposeInMainWorld: (_name: string, value: MikkaBridge) => { bridge = value } },
        ipcRenderer: {
          invoke: async (channel: string, ...args: unknown[]) => handlers.get(channel)!({ senderFrame: { parent: null, url: appUrl } }, ...args),
          on: () => {}, removeListener: () => {},
        },
      }),
    })
    assert.throws(() => handlers.get('mikka:ssh:begin')!({ senderFrame: { parent: null, url: 'https://evil.test' } }, 'fixture'), /untrusted/)
    const hosts = await bridge.ssh!.hosts()
    assert.deepEqual(hosts.map(host => ({ ...host })), [{ alias: 'fixture', user: 'root', hostName: '127.0.0.1', port: 22491 }])
    const cancelled = await bridge.ssh!.begin('fixture')
    assert.equal(cancelled?.keyType, 'ED25519')
    assert.equal((await bridge.ssh!.cancel(cancelled!.id))?.reason, 'cancelled')
    assert.equal(enrollments, 0)
    const initial = await bridge.ssh!.begin('fixture')
    assert.equal(initial?.status, 'fingerprint')
    assert.equal(enrollments, 0)
    await bridge.ssh!.accept(initial!.id)
    // Reverse forwarding also works when Docker runs on a separate VM.
    tunnel = spawn('ssh', ['-F', config, '-oBatchMode=yes', '-oStrictHostKeyChecking=yes', `-oUserKnownHostsFile=${join(home, '.ssh/known_hosts')}`, '-oExitOnForwardFailure=yes', '-N', '-R', `34991:127.0.0.1:${port}`, 'fixture'], { stdio: 'ignore' })
    await waitUntil(() => installer.state()?.status !== 'running', 150_000)
    assert.equal(installer.state()?.status, 'online', JSON.stringify(installer.state()))
    assert.equal(installer.state()?.deviceId, deviceId)
    assert.equal(enrollments, 1)
    assert.ok(registrations >= 1 && heartbeats >= 1)
    const pidBefore = await runProcess('docker', ['exec', container, 'systemctl', '--user', '--machine=root@.host', 'show', 'mikka-daemon.service', '--property=MainPID', '--value'])
    // Reinstallation must replace an already-running service, including its server flags.
    await runProcess('ssh', ['-F', config, '-oBatchMode=yes', '-oStrictHostKeyChecking=yes', `-oUserKnownHostsFile=${join(home, '.ssh/known_hosts')}`, 'fixture', "mikka daemon service install --server 'http://127.0.0.1:34991/mikka' --device-type server"])
    const reinstalledPid = await runProcess('docker', ['exec', container, 'systemctl', '--user', '--machine=root@.host', 'show', 'mikka-daemon.service', '--property=MainPID', '--value'])
    assert.notEqual(pidBefore, reinstalledPid)
    const service = (...args: string[]) => runProcess('docker', ['exec', container, 'systemctl', '--user', '--machine=root@.host', ...args])
    const pid = () => service('show', 'mikka-daemon.service', '--property=MainPID', '--value')
    const ssh = (script: string) => runProcess('ssh', ['-F', config, '-oBatchMode=yes', '-oStrictHostKeyChecking=yes', `-oUserKnownHostsFile=${join(home, '.ssh/known_hosts')}`, 'fixture', script])
    const savedDevice = await runProcess('docker', ['exec', container, 'cat', '/root/.config/Mikka/device.json'])
    const savedUnit = await runProcess('docker', ['exec', container, 'cat', '/root/.config/systemd/user/mikka-daemon.service'])
    assert.equal(reportedVersion, '1.0.0')
    await waitUntil(() => registryQueries > 0, 30_000)
    // The persisted daily deadline is advanced only inside this disposable device.
    const due = () => runProcess('docker', ['exec', container, 'sh', '-c', 'printf \'{"lastAttemptAt":0}\' > /root/.config/Mikka/auto-update.json'])
    latestVersion = '1.0.1'
    await due()
    const registrationsBeforeUpdate = registrations, heartbeatsBeforeUpdate = heartbeats
    await waitUntil(() => reportedVersion === '1.0.1' && registrations > registrationsBeforeUpdate && heartbeats > heartbeatsBeforeUpdate, 120_000)
    const updatedPid = await pid()
    assert.notEqual(updatedPid, reinstalledPid)
    assert.equal((await ssh('node -p "require(\'$(npm root -g)/@aspectlylabs/mikka/package.json\').version"')).trim(), '1.0.1')
    assert.ok(await runProcess('docker', ['exec', container, 'cat', '/root/.config/Mikka/device.json']) === savedDevice, 'automatic update must preserve device identity/configuration')
    assert.equal(await runProcess('docker', ['exec', container, 'cat', '/root/.config/systemd/user/mikka-daemon.service']), savedUnit)
    assert.equal(enrollments, 1)
    const queriesAfterUpdate = registryQueries, heartbeatAfterUpdate = heartbeats
    await waitUntil(() => heartbeats >= heartbeatAfterUpdate + 2, 40_000)
    assert.equal(registryQueries, queriesAfterUpdate, 'successful update must retain its daily deadline across restart')

    await ssh("mikka daemon service install --server 'http://127.0.0.1:34991/mikka' --device-type server --no-auto-update")
    const disabledPid = await pid(), queriesBeforeOptOut = registryQueries, heartbeatBeforeOptOut = heartbeats
    latestVersion = '1.0.2'
    await due()
    await waitUntil(() => heartbeats >= heartbeatBeforeOptOut + 2, 40_000)
    assert.equal(registryQueries, queriesBeforeOptOut, 'opt-out must not query npm')
    assert.equal(await pid(), disabledPid, 'opt-out must not install/restart')

    await ssh("mikka daemon service install --server 'http://127.0.0.1:34991/mikka' --device-type server")
    const failedPid = await pid()
    await waitUntil(() => failedDownloads > 0, 45_000)
    const heartbeatBeforeFailure = heartbeats
    await waitUntil(() => heartbeats >= heartbeatBeforeFailure + 2, 40_000)
    assert.equal(await pid(), failedPid, 'failed npm install must not restart the service')
    assert.equal(reportedVersion, '1.0.1')
    assert.ok(await runProcess('docker', ['exec', container, 'cat', '/root/.config/Mikka/device.json']) === savedDevice, 'failed update must preserve device identity/configuration')
    const failedAttempt = JSON.parse(await runProcess('docker', ['exec', container, 'cat', '/root/.config/Mikka/auto-update.json']))
    assert.ok(failedAttempt.lastAttemptAt > Date.now() - 120_000)
    const queriesAfterFailure = registryQueries, heartbeatAfterFailure = heartbeats
    await waitUntil(() => heartbeats >= heartbeatAfterFailure + 2, 40_000)
    assert.equal(registryQueries, queriesAfterFailure, 'failed update must retain its daily deadline')
    assert.equal(await pid(), failedPid)
    console.log(JSON.stringify({ automaticUpdate: { from: '1.0.0', to: reportedVersion, previousPid: reinstalledPid.trim(), updatedPid: updatedPid.trim(), failedPid: failedPid.trim(), enrollments, registrations, heartbeats, failedDownloads } }))
    command = { id: randomUUID(), kind: 'redetect' }
    await waitUntil(() => acked.has(command!.id), 45_000)
    command = { id: randomUUID(), kind: 'restart' }
    await waitUntil(() => acked.has(command!.id), 60_000)
    const pidAfter = await runProcess('docker', ['exec', container, 'systemctl', '--user', '--machine=root@.host', 'show', 'mikka-daemon.service', '--property=MainPID', '--value'])
    assert.notEqual(failedPid, pidAfter)
    assert.ok(registrations >= 2)
    await runProcess('docker', ['exec', container, 'sh', '-c', 'mkdir -p /root/keep-repository /root/.config/Mikka/worktrees; echo keep > /root/keep-repository/file; echo keep > /root/.config/Mikka/worktrees/keep'])
    removed = true
    command = { id: randomUUID(), kind: 'uninstall' }
    await waitUntil(() => acked.has(command!.id), 45_000)
    assert.equal(revoked, true)
    const daemonPid = Number(pidAfter.trim())
    assert.ok(Number.isSafeInteger(daemonPid) && daemonPid > 0)
    await waitUntil(async () => {
      try {
        await runProcess('docker', ['exec', container, 'sh', '-c', `test ! -e /root/.config/systemd/user/mikka-daemon.service && ! systemctl --user --machine=root@.host is-active --quiet mikka-daemon.service && ! kill -0 ${daemonPid} 2>/dev/null`])
        return true
      } catch { return false }
    }, 45_000)
    const device = JSON.parse(await runProcess('docker', ['exec', container, 'cat', '/root/.config/Mikka/device.json']))
    assert.equal(device.credential, undefined)
    await runProcess('docker', ['exec', container, 'sh', '-c', 'test ! -e /root/.config/Mikka/daemon.secret; command -v mikka; test "$(cat /root/keep-repository/file)" = keep; test "$(cat /root/.config/Mikka/worktrees/keep)" = keep'])
  } finally {
    tunnel?.kill()
    server.closeAllConnections(); server.close()
    await rm(home, { recursive: true, force: true })
  }
})
async function waitUntil(check: () => boolean | Promise<boolean>, timeout: number) {
  const deadline = Date.now() + timeout
  while (!await check()) {
    if (Date.now() > deadline) throw new Error('SSH acceptance timed out')
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}
