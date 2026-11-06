// A real Apple Silicon LaunchAgent and npm install; all server responses are an isolated local fixture.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { SshInstaller, runProcess, quote, type SshInstallState } from '../../apps/desktop/src/main/ssh-install'
import { nodeDiscoveryScript } from '../../apps/desktop/src/main/local-install'

assert.equal(process.platform, 'darwin')
assert.equal(process.arch, 'arm64')
const major = Number(process.versions.node.split('.')[0])
assert.ok(major === 18 || major === 22)
const home = await mkdtemp(join(tmpdir(), 'mikka-node22-installer-'))
const originalHome = process.env.HOME, originalPath = process.env.PATH
const selectedBin = dirname(process.execPath)
const deviceId = randomUUID(), workspaceId = randomUUID()
const credential = `orv_${'t'.repeat(43)}`
let registrations = 0, heartbeats = 0, enrollments = 0
const server = createServer(async (request, response) => {
  let raw = ''
  for await (const chunk of request) raw += chunk
  const body = raw ? JSON.parse(raw) : {}
  const route = request.url ?? ''
  response.setHeader('content-type', 'application/json')
  if (route.endsWith('/enroll')) { enrollments++; response.end(JSON.stringify({ credential })); return }
  if (request.headers.authorization !== `Bearer ${credential}`) { response.writeHead(401).end('{}'); return }
  if (route.endsWith('/register')) {
    assert.equal(body.deviceType, 'laptop'); registrations++
    response.end(JSON.stringify({ deviceId, workspaceId })); return
  }
  if (route.endsWith('/heartbeat')) { heartbeats++; response.end('{"leases":{},"daemonVersions":{"min":"0.0.1"}}'); return }
  if (route.endsWith('/repos')) { response.end('{"repos":[]}'); return }
  if (route.includes('/runs?')) { response.end('{"runIds":[]}'); return }
  if (route.includes('/commands')) { response.end('{"commands":[]}'); return }
  if (route.includes('/fs/requests')) { response.end('{"requests":[]}'); return }
  response.writeHead(404).end('{}')
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const address = server.address()
assert.ok(address && typeof address !== 'string')
const states: SshInstallState[] = []
let finish!: () => void
let done = new Promise<void>(resolve => { finish = resolve })
const tarball = process.env.MIKKA_DAEMON_TARBALL ? resolve(process.env.MIKKA_DAEMON_TARBALL) : ''
let npmStarted = false
try {
  process.env.HOME = home
  if (major === 22) {
    // Finder PATH has no Node; nvm is installed but no .zshrc was sourced.
    const nvm = join(home, '.nvm/versions/node/v22.22.1/bin')
    await mkdir(nvm, { recursive: true })
    await symlink(process.execPath, join(nvm, 'node'))
    await symlink(join(selectedBin, 'npm'), join(nvm, 'npm'))
    process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
    assert.ok(tarball)
  } else {
    process.env.PATH = `${selectedBin}:/usr/bin:/bin:/usr/sbin:/sbin`
  }
  const execute: typeof runProcess = async (command, args, input, timeout, signal) => {
    let script = args.at(-1)!
    if (major === 18 && script.includes('MIKKA_NODE_BIN=')) {
      // An isolated Node-18-only search; unrelated preinstalled runner toolchains
      // are not part of the fixture. It executes the production preflight script.
      script = `/bin/sh -c ${quote(nodeDiscoveryScript(22, home, []))}`
    }
    if (script.includes('npm install')) { npmStarted = true; script = script.replace('@aspectlylabs/mikka', quote(tarball)) }
    return runProcess(command, [...args.slice(0, -1), script], input, timeout, signal)
  }
  const installer = new SshInstaller(`http://127.0.0.1:${address.port}/mikka`, async () => 'fixture-registration-token', state => {
    states.push(state)
    if (state.status === 'online' || state.status === 'failed') finish()
  }, execute, home, undefined, undefined, 'prod', { command: '/bin/sh', args: script => ['-c', script] }, async id => id === deviceId)
  await installer.beginLocal('fixture-owner')
  await done
  const state = installer.state()!
  if (major === 18) {
    assert.equal(state.status, 'failed')
    assert.equal(state.step, 'check')
    assert.equal(state.error?.cause, 'node_required')
    assert.equal(state.error?.remedy, 'install_node_22')
    assert.equal(npmStarted, false)
  } else {
    if (state.status !== 'online' && state.error?.logPath) process.stderr.write(await readFile(state.error.logPath, 'utf8'))
    assert.equal(state.status, 'online')
    assert.ok(registrations >= 1 && heartbeats >= 1 && enrollments === 1)
    const plist = await readFile(join(home, 'Library/LaunchAgents/com.aspectlylabs.mikka.daemon.plist'), 'utf8')
    assert.ok(plist.includes('.mikka/npm/lib/node_modules/@aspectlylabs/mikka/mikka.js'))
    assert.ok(plist.includes('node'))
    const manifest = JSON.parse(await readFile(join(home, '.mikka/npm/lib/node_modules/@aspectlylabs/mikka/package.json'), 'utf8'))
    assert.equal(manifest.engines.node, '>=22')
    done = new Promise<void>(resolve => { finish = resolve })
    await installer.restartLocal('fixture-owner')
    await done
    assert.equal(installer.state()?.status, 'online')
    assert.equal(enrollments, 1, 'reconnect must not re-enroll')
  }
  const evidence = { platform: process.platform, arch: process.arch, node: process.versions.node, result: major === 18 ? 'check/node_required' : 'installed/launchagent/online/reconnect',
    npmStarted, registrations, heartbeats, states: states.map(({ step, status, error }) => ({ step, status, cause: error?.cause })) }
  await mkdir('artifacts/local-installer', { recursive: true })
  await writeFile(`artifacts/local-installer/node-${major}.json`, JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify(evidence))
} finally {
  if (major === 22) await runProcess('launchctl', ['bootout', `gui/${process.getuid!()}/com.aspectlylabs.mikka.daemon`]).catch(() => undefined)
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  process.env.HOME = originalHome
  process.env.PATH = originalPath
  await rm(home, { recursive: true, force: true })
}
