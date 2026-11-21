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

// The fixture speaks the device session protocol (decision 2026-11-17-2215):
// a gateway ticket, one WebSocket that answers pings and pushes `work`, and
// reports instead of a heartbeat. The daemon sends nothing on a timer.
const rootRequire = createRequire(import.meta.url)
type FixtureSocket = { readonly OPEN: number; readyState: number; send(data: string): void; terminate(): void; on(event: 'message', listener: (data: unknown) => void): void }
type FixtureSocketServer = { clients: Set<FixtureSocket>; close(): void; emit(event: 'connection', socket: FixtureSocket, request: unknown): boolean
  on(event: 'connection', listener: (socket: FixtureSocket) => void): void
  handleUpgrade(request: unknown, socket: unknown, head: Buffer, done: (socket: FixtureSocket) => void): void }
const { WebSocketServer } = createRequire(createRequire(rootRequire.resolve('nitro/package.json')).resolve('crossws/adapters/node'))('ws') as { WebSocketServer: new (options: { noServer: true }) => FixtureSocketServer }

// The runner starts a disposable SSH/systemd container and copies the packed daemon to /tmp/mikka.tgz.
test('real SSH install → systemd → automatic npm update → opt-out/failure → commands → uninstall', { timeout: 480_000 }, async () => {
  const container = process.env.MIKKA_SSH_TEST_CONTAINER
  if (!container || !/^mikka-491-[a-z0-9-]+$/.test(container)) throw new Error('Disposable SSH fixture required')
  const home = await mkdtemp(join(tmpdir(), 'mikka-ssh-e2e-'))
  const key = join(home, 'id_ed25519')
  const deviceId = randomUUID(), workspaceId = randomUUID()
  const credential = `orv_${'t'.repeat(43)}`
  let enrollments = 0, registrations = 0, reports = 0, tickets = 0, commandReads = 0, deviceRequests = 0
  let reportedVersion = '', latestVersion = '1.0.0', registryQueries = 0, downloads = 0, failedDownloads = 0, pollsAskingForReleases = 0
  let updateFailure: unknown = null
  // The server names the release; the daemon never asks the registry which one is latest.
  const daemonVersions = () => ({ min: '1.0.0', latest: latestVersion })
  const tarballs = new Map<string, Buffer>()
  for (const [version, path] of Object.entries(JSON.parse(process.env.MIKKA_SSH_TEST_TARBALLS ?? '{}') as Record<string, string>)) tarballs.set(version, await readFile(path))
  assert.deepEqual([...tarballs.keys()], ['1.0.0', '1.0.1'])
  const { dependencies: sourceDependencies } = JSON.parse(await readFile(new URL('../../packages/daemon/package.json', import.meta.url), 'utf8'))
  const dependencies = Object.fromEntries(Object.entries(sourceDependencies).filter(([name]) => name !== '@mikka/protocol'))
  let command: { id: string; kind: 'redetect' | 'restart' | 'uninstall' } | undefined
  let removed = false, revoked = false
  const acked = new Set<string>()
  let tunnel: ChildProcess | undefined
  const sockets = new WebSocketServer({ noServer: true })
  sockets.on('connection', socket => socket.on('message', data => { if (String(data) === 'ping') socket.send('pong') }))
  // Signal work to every open device socket, as the gateway does after a server write.
  const push = () => { for (const socket of sockets.clients) if (socket.readyState === socket.OPEN) socket.send('work') }
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
        downloads++
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
    deviceRequests++
    // A removed device's credential reaches only its report, which carries the uninstall.
    if (revoked || (removed && !route.endsWith('/report'))) { response.writeHead(401).end('{}'); return }
    if (route.endsWith('/gateway')) {
      tickets++
      response.end(JSON.stringify({ url: 'ws://127.0.0.1:34991/socket', protocol: `mikka-ticket-1-${'0'.repeat(64)}` })); return
    }
    if (route.endsWith('/register')) {
      assert.equal(body.deviceType, 'server'); registrations++; reportedVersion = body.daemonVersion
      response.end(JSON.stringify({ deviceId, workspaceId })); return
    }
    if (route.endsWith('/report')) {
      reports++
      if (command) console.log(JSON.stringify({ report: reports, command: command.kind, acknowledged: (body.completedDeviceCommands ?? []).includes(command.id) }))
      for (const id of body.completedDeviceCommands ?? []) acked.add(id)
      if (body.updateFailure !== undefined) updateFailure = body.updateFailure
      if (command?.kind === 'uninstall' && acked.has(command.id)) revoked = true
      response.end(JSON.stringify({ deviceCommands: command && !acked.has(command.id) ? [command] : [], daemonVersions: daemonVersions() })); return
    }
    if (route.endsWith('/repos')) { response.end('{"repos":[]}'); return }
    if (route.includes('/runs?')) { response.end('{"runIds":[]}'); return }
    if (route.includes('/fs/requests')) { setTimeout(() => response.end('{"requests":[]}'), 500); return }
    if (route.includes('/commands/ack')) { response.end('{}'); return }
    if (route.includes('/commands')) {
      // Read once per push or socket open, never polled. A daemon that sends
      // the newest release it knows reads the releases from this answer.
      commandReads++
      const known = new URL(route, 'http://fixture').searchParams.get('daemonLatest')
      if (known) pollsAskingForReleases++
      response.end(JSON.stringify({ commands: [], deviceCommands: command && !acked.has(command.id) ? [command] : [], ...(known ? { daemonVersions: daemonVersions() } : {}) })); return
    }
    response.writeHead(404).end('{}')
  })
  try {
    await runProcess('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key])
    const pubkey = await readFile(`${key}.pub`, 'utf8')
    await runProcess('docker', ['exec', '-i', container, 'sh', '-c', 'mkdir -p /root/.ssh; chmod 700 /root/.ssh; cat > /root/.ssh/authorized_keys; chmod 600 /root/.ssh/authorized_keys'], pubkey)
    const config = join(home, 'config')
    await writeFile(config, `Host fixture\n HostName 127.0.0.1\n User root\n Port 22491\n IdentityFile ${key}\n IdentitiesOnly yes\n`)
    server.on('upgrade', (request, socket, head) => {
      if (request.url !== '/socket') { socket.destroy(); return }
      sockets.handleUpgrade(request, socket, head, client => sockets.emit('connection', client, request))
    })
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
    // The hardened preload checks the complete URL and top-frame identity.
    const preloadWindow: { location: URL; top?: unknown } = { location: new URL(appUrl) }
    preloadWindow.top = preloadWindow
    runInNewContext(await readFile(new URL('../../apps/desktop/dist/preload.cjs', import.meta.url), 'utf8'), {
      window: preloadWindow,
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
    assert.ok(registrations >= 1 && tickets >= 1 && reports >= 1)
    const ticketsBeforeReinstall = tickets
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
    // The reinstalled daemon opens its own session, reports and reads once.
    // Already the release the server names: no registry read, no install.
    await waitUntil(() => tickets > ticketsBeforeReinstall && pollsAskingForReleases > 0, 60_000)
    // Its startup reports (a harness or model change found after start) end
    // once it settles. From then on an idle session sends nothing on a
    // timer: no report, no read and no ticket without a push.
    await settled(() => deviceRequests, 10_000, 120_000)
    const idleRequests = deviceRequests, idleCounts = { reports, commandReads, tickets }
    await new Promise(resolve => setTimeout(resolve, 30_000))
    assert.deepEqual({ requests: deviceRequests, reports, commandReads, tickets }, { requests: idleRequests, ...idleCounts }, 'an idle device makes no requests')
    assert.equal(registryQueries, 0, 'the daemon never asks the registry on its own')
    assert.equal(downloads, 0)
    // The server names 1.0.1 and pushes; the idle daemon reads it and installs exactly that version.
    latestVersion = '1.0.1'
    const registrationsBeforeUpdate = registrations, reportsBeforeUpdate = reports
    push()
    await waitUntil(() => reportedVersion === '1.0.1' && registrations > registrationsBeforeUpdate && reports > reportsBeforeUpdate, 120_000)
    assert.ok(registryQueries > 0 && downloads > 0, 'npm installs the named version from the registry')
    const updatedPid = await pid()
    assert.notEqual(updatedPid, reinstalledPid)
    assert.equal((await ssh('node -p "require(\'$(npm root -g)/@aspectlylabs/mikka/package.json\').version"')).trim(), '1.0.1')
    assert.ok(await runProcess('docker', ['exec', container, 'cat', '/root/.config/Mikka/device.json']) === savedDevice, 'automatic update must preserve device identity/configuration')
    assert.equal(await runProcess('docker', ['exec', container, 'cat', '/root/.config/systemd/user/mikka-daemon.service']), savedUnit)
    assert.equal(enrollments, 1)
    const queriesAfterUpdate = registryQueries, downloadsAfterUpdate = downloads, readsAfterUpdate = commandReads
    await waitUntil(() => commandReads > readsAfterUpdate || (push(), false), 40_000)
    assert.equal(registryQueries, queriesAfterUpdate, 'an up-to-date daemon reads nothing from the registry after its restart')
    assert.equal(downloads, downloadsAfterUpdate)

    await ssh("mikka daemon service install --server 'http://127.0.0.1:34991/mikka' --device-type server --no-auto-update")
    const disabledPid = await pid(), queriesBeforeOptOut = registryQueries, readsBeforeOptOut = commandReads
    latestVersion = '1.0.2'
    await waitUntil(() => commandReads > readsBeforeOptOut || (push(), false), 40_000)
    await new Promise(resolve => setTimeout(resolve, 5_000))
    assert.equal(registryQueries, queriesBeforeOptOut, 'opt-out must not query npm when the server names a newer release')
    assert.equal(failedDownloads, 0)
    assert.equal(await pid(), disabledPid, 'opt-out must not install/restart')

    // 1.0.2 has no tarball in the registry: the install fails.
    await ssh("mikka daemon service install --server 'http://127.0.0.1:34991/mikka' --device-type server")
    const failedPid = await pid()
    await waitUntil(() => failedDownloads > 0, 45_000)
    await waitUntil(() => updateFailure !== null, 40_000)
    assert.equal(await pid(), failedPid, 'failed npm install must not restart the service')
    assert.equal(reportedVersion, '1.0.1')
    assert.ok(await runProcess('docker', ['exec', container, 'cat', '/root/.config/Mikka/device.json']) === savedDevice, 'failed update must preserve device identity/configuration')
    const failedAttempt = JSON.parse(await runProcess('docker', ['exec', container, 'cat', '/root/.config/Mikka/auto-update.json']))
    assert.deepEqual({ version: failedAttempt.failure?.version, code: failedAttempt.failure?.code }, { version: '1.0.2', code: 'install_failed' })
    assert.ok(failedAttempt.failure.at > Date.now() - 120_000)
    assert.deepEqual({ ...(updateFailure as object), at: undefined }, { version: '1.0.2', code: 'install_failed', at: undefined }, 'the failure is reported once, on a report')
    const queriesAfterFailure = registryQueries, failuresAfterFailure = failedDownloads, readsAfterFailure = commandReads
    await waitUntil(() => commandReads > readsAfterFailure || (push(), false), 40_000)
    await new Promise(resolve => setTimeout(resolve, 5_000))
    assert.equal(registryQueries, queriesAfterFailure, 'a failed version backs off although the server keeps naming it')
    assert.equal(failedDownloads, failuresAfterFailure)
    assert.equal(await pid(), failedPid)
    console.log(JSON.stringify({ automaticUpdate: { from: '1.0.0', to: reportedVersion, previousPid: reinstalledPid.trim(), updatedPid: updatedPid.trim(), failedPid: failedPid.trim(), enrollments, registrations, tickets, reports, commandReads, pollsAskingForReleases, registryQueries, downloads, failedDownloads } }))
    // The server pushes after it queues a device command, as enqueueDeviceCommand does.
    command = { id: randomUUID(), kind: 'redetect' }
    push()
    await waitUntil(() => acked.has(command!.id), 45_000)
    command = { id: randomUUID(), kind: 'restart' }
    push()
    await waitUntil(() => acked.has(command!.id), 60_000)
    const pidAfter = await runProcess('docker', ['exec', container, 'systemctl', '--user', '--machine=root@.host', 'show', 'mikka-daemon.service', '--property=MainPID', '--value'])
    assert.notEqual(failedPid, pidAfter)
    assert.ok(registrations >= 2)
    await runProcess('docker', ['exec', container, 'sh', '-c', 'mkdir -p /root/keep-repository /root/.config/Mikka/worktrees; echo keep > /root/keep-repository/file; echo keep > /root/.config/Mikka/worktrees/keep'])
    removed = true
    command = { id: randomUUID(), kind: 'uninstall' }
    push()
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
    for (const socket of sockets.clients) socket.terminate()
    sockets.close(); server.closeAllConnections(); server.close()
    await rm(home, { recursive: true, force: true })
  }
})
/** Waits until the value has not changed for `quiet` milliseconds. */
async function settled(value: () => number, quiet: number, timeout: number) {
  const deadline = Date.now() + timeout
  let last = value(), since = Date.now()
  while (Date.now() - since < quiet) {
    if (Date.now() > deadline) throw new Error('SSH acceptance did not settle')
    await new Promise(resolve => setTimeout(resolve, 200))
    if (value() !== last) { last = value(); since = Date.now() }
  }
}
async function waitUntil(check: () => boolean | Promise<boolean>, timeout: number) {
  const deadline = Date.now() + timeout
  while (!await check()) {
    if (Date.now() > deadline) throw new Error('SSH acceptance timed out')
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}
