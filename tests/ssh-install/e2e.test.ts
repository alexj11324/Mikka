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
import { randomUUID } from 'node:crypto'
import { SshInstaller, runProcess } from '../../apps/desktop/src/main/ssh-install'

// The runner starts a disposable SSH/systemd container and copies the packed daemon to /tmp/mikka.tgz.
test('real SSH key confirmation → tarball install → systemd → registration → redetect → restart', { timeout: 240_000 }, async () => {
  const container = process.env.MIKKA_SSH_TEST_CONTAINER
  if (!container || !/^mikka-491-[a-z0-9-]+$/.test(container)) throw new Error('Disposable SSH fixture required')
  const home = await mkdtemp(join(tmpdir(), 'mikka-ssh-e2e-'))
  const key = join(home, 'id_ed25519')
  const deviceId = randomUUID(), workspaceId = randomUUID()
  const credential = `orv_${'t'.repeat(43)}`
  let enrollments = 0, registrations = 0, heartbeats = 0
  let command: { id: string; kind: 'redetect' | 'restart' } | undefined
  const acked = new Set<string>()
  let tunnel: ChildProcess | undefined
  const server = createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = raw ? JSON.parse(raw) : {}
    response.setHeader('content-type', 'application/json')
    const route = request.url ?? ''
    if (route.endsWith('/enroll')) { enrollments++; response.end(JSON.stringify({ credential })); return }
    if (request.headers.authorization !== `Bearer ${credential}`) { response.writeHead(401).end('{}'); return }
    if (route.endsWith('/register')) {
      assert.equal(body.deviceType, 'server'); registrations++
      response.end(JSON.stringify({ deviceId, workspaceId })); return
    }
    if (route.endsWith('/heartbeat')) {
      heartbeats++
      if (command) console.log(JSON.stringify({ heartbeat: heartbeats, command: command.kind, acknowledged: (body.completedDeviceCommands ?? []).includes(command.id) }))
      for (const id of body.completedDeviceCommands ?? []) acked.add(id)
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
      process: { argv: [`--mikka-app-origin=${new URL(appUrl).origin}`] },
      require: () => ({
        contextBridge: { exposeInMainWorld: (_name: string, value: MikkaBridge) => { bridge = value } },
        ipcRenderer: {
          invoke: async (channel: string, ...args: unknown[]) => handlers.get(channel)!({ senderFrame: { parent: null, url: appUrl } }, ...args),
          on: () => {}, removeListener: () => {},
        },
      }),
    })
    assert.throws(() => handlers.get('mikka:ssh:begin')!({ senderFrame: { parent: null, url: 'https://evil.test' } }, 'fixture'), /untrusted/)
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
    command = { id: randomUUID(), kind: 'redetect' }
    await waitUntil(() => acked.has(command!.id), 45_000)
    command = { id: randomUUID(), kind: 'restart' }
    await waitUntil(() => acked.has(command!.id), 60_000)
    const pidAfter = await runProcess('docker', ['exec', container, 'systemctl', '--user', '--machine=root@.host', 'show', 'mikka-daemon.service', '--property=MainPID', '--value'])
    assert.notEqual(pidBefore, pidAfter)
    assert.ok(registrations >= 2)
  } finally {
    tunnel?.kill()
    server.closeAllConnections(); server.close()
    await rm(home, { recursive: true, force: true })
  }
})
async function waitUntil(check: () => boolean, timeout: number) {
  const deadline = Date.now() + timeout
  while (!check()) {
    if (Date.now() > deadline) throw new Error('SSH acceptance timed out')
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}
