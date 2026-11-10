// A real Apple Silicon LaunchAgent and npm install; all server responses are an isolated local fixture.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, open, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { SshInstaller, runProcess, quote, type SshInstallState } from '../../apps/desktop/src/main/ssh-install'
import { InstallProcessError, nodeDiscoveryScript, redactInstallLog } from '../../apps/desktop/src/main/local-install'
import { prepareLaunchctlDiagnostic } from './local-installer-launchctl-diagnostic.mjs'

assert.equal(process.platform, 'darwin')
assert.equal(process.arch, 'arm64')
const major = Number(process.versions.node.split('.')[0])
assert.ok(major === 18 || major === 22)
// macOS TMPDIR is a long /var/folders path. A normal daemon Unix socket under
// that synthetic HOME exceeds macOS's 103-byte IPC path limit.
const home = await mkdtemp('/tmp/mikka-i-')
// Private exact-path handoff to the always-run diagnostic controller. Never uploaded.
const fixtureControl = resolve('.cache/launchctl-fixture-control')
try {
  await mkdir(fixtureControl, { recursive: true, mode: 0o700 })
  await writeFile(join(fixtureControl, 'owned-home'), home + '\n', { mode: 0o600, flag: 'wx' })
} catch (error) {
  await rm(home, { recursive: true, force: true })
  throw error
}
const dataDir = join(home, 'Library/Application Support/Mikka')
const socketPathBytes = Buffer.byteLength(join(dataDir, 'local-computer.sock'))
assert.ok(socketPathBytes <= 103)
const originalHome = process.env.HOME, originalPath = process.env.PATH
const selectedBin = dirname(process.execPath)
const deviceId = randomUUID(), workspaceId = randomUUID()
const registrationToken = `orv_${'r'.repeat(43)}`
const credential = `orv_${'t'.repeat(43)}`
let registrations = 0, heartbeats = 0, enrollments = 0
const server = createServer(async (request, response) => {
  let raw = ''
  for await (const chunk of request) raw += chunk
  const body = raw ? JSON.parse(raw) : {}
  const route = request.url ?? ''
  response.setHeader('content-type', 'application/json')
  if (route.endsWith('/enroll')) {
    assert.equal(request.headers.authorization, `Bearer ${registrationToken}`)
    enrollments++; response.end(JSON.stringify({ credential })); return
  }
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
let lastStatus = ''
let launchctlDiagnostic: Awaited<ReturnType<typeof prepareLaunchctlDiagnostic>> | undefined
const sanitized = (value: string) => redactInstallLog(value).replaceAll(home, '[fixture-home]').replaceAll(deviceId, '[fixture-device]').replaceAll(workspaceId, '[fixture-workspace]')
const evidence = () => ({ platform: process.platform, arch: process.arch, node: process.versions.node,
  npmStarted, registrations, heartbeats, enrollments, socketPathBytes,
  states: states.map(({ step, status, error }) => ({ step, status, cause: error?.cause })) })
async function installerDiagnostic() {
  const path = states.at(-1)?.error?.logPath
  if (!path) return { status: 'unavailable' }
  try {
    const file = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(16_385)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      if (bytesRead === buffer.length) return { status: 'oversized', limitBytes: 16_384 }
      const diagnostic = buffer.subarray(0, bytesRead).toString('utf8')
      const exitCode = /^exitCode=(-?\d+)$/m.exec(diagnostic)?.[1]
      // stdout may contain a response body. Retain only the command's stderr,
      // with the same credential/fixture redaction as the existing service logs.
      const marker = '\n--- stderr ---\n', offset = diagnostic.lastIndexOf(marker)
      const stderr = offset < 0 ? null : sanitized(diagnostic.slice(offset + marker.length))
      return { status: 'captured', exitCode: exitCode === undefined ? null : Number(exitCode),
        stderr: stderr?.slice(0, 4096) ?? null, truncated: stderr !== null && stderr.length > 4096 }
    } finally { await file.close() }
  } catch { return { status: 'unavailable' } }
}
try {
  process.env.HOME = home
  if (major === 22) {
    // Finder PATH has no Node; nvm is installed but no .zshrc was sourced.
    const nvm = join(home, '.nvm/versions/node/v22.22.1/bin')
    await mkdir(nvm, { recursive: true })
    await symlink(process.execPath, join(nvm, 'node'))
    await symlink(join(selectedBin, 'npm'), join(nvm, 'npm'))
    // Wrap launchctl in the already-selected nvm bin; the original Finder PATH remains unchanged.
    launchctlDiagnostic = await prepareLaunchctlDiagnostic(home, process.execPath)
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
    try {
      const result = await runProcess(command, [...args.slice(0, -1), script], input, timeout, signal)
      if (script.includes('mikka daemon status')) lastStatus = sanitized(result)
      return result
    } catch (error) {
      if (script.includes('mikka daemon service install')) launchctlDiagnostic?.probeAfterFailure()
      if (script.includes('mikka daemon status')) lastStatus = sanitized(error instanceof InstallProcessError ? error.stderr : error instanceof Error ? error.message : String(error))
      throw error
    }
  }
  const installer = new SshInstaller(`http://127.0.0.1:${address.port}/mikka`, async () => registrationToken, state => {
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
    assert.equal(state.status, 'online')
    assert.ok(registrations >= 1 && heartbeats >= 1 && enrollments === 1)
    const plist = JSON.parse(await runProcess('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(home, 'Library/LaunchAgents/com.aspectlylabs.mikka.daemon.plist')]))
    const serviceArgs = plist.ProgramArguments as string[]
    assert.equal(await realpath(serviceArgs[0]), await realpath(process.execPath), 'LaunchAgent must use the selected Node 22 binary')
    assert.equal(await realpath(serviceArgs[1]), await realpath(join(home, '.mikka/npm/lib/node_modules/@aspectlylabs/mikka/mikka.js')), 'npm bin symlink must resolve to the tested private package')
    assert.equal(serviceArgs[serviceArgs.indexOf('--data-dir') + 1], dataDir, 'LaunchAgent and login must share the isolated data directory')
    const manifest = JSON.parse(await readFile(join(home, '.mikka/npm/lib/node_modules/@aspectlylabs/mikka/package.json'), 'utf8'))
    assert.equal(manifest.engines.node, '>=22')
    done = new Promise<void>(resolve => { finish = resolve })
    await launchctlDiagnostic?.reconnect()
    await installer.restartLocal('fixture-owner')
    await done
    assert.equal(installer.state()?.status, 'online')
    assert.equal(enrollments, 1, 'reconnect must not re-enroll')
  }
  const result = { ...evidence(), result: major === 18 ? 'check/node_required' : 'installed/launchagent/online/reconnect', launchctl: launchctlDiagnostic?.snapshot() }
  await mkdir('artifacts/local-installer', { recursive: true })
  await writeFile(`artifacts/local-installer/node-${major}.json`, JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result))
} catch (error) {
  // Capture only this isolated fixture, before bootout/removal; no credential
  // files or ambient runner configuration are read or uploaded.
  const logs = Object.fromEntries(await Promise.all([
    ['service', join(home, 'Library/Logs/mikka-daemon.log')],
    ['daemon', join(dataDir, 'logs/daemon.log')],
  ].map(async ([name, path]) => [name, sanitized(await readFile(path, 'utf8').catch(() => 'unavailable'))])))
  const result = { ...evidence(), result: 'failed', lastStatus, logs, installer: await installerDiagnostic(), launchctl: launchctlDiagnostic?.snapshot() }
  await mkdir('artifacts/local-installer', { recursive: true })
  await writeFile(`artifacts/local-installer/node-${major}.json`, JSON.stringify(result, null, 2) + '\n')
  process.stderr.write(JSON.stringify(result, null, 2) + '\n')
  throw error
} finally {
  let bootout: { attempted: boolean; exitCode: number | null; error: boolean } = { attempted: false, exitCode: null, error: false }
  if (major === 22) {
    bootout.attempted = true
    try {
      await runProcess('launchctl', ['bootout', `gui/${process.getuid!()}/com.aspectlylabs.mikka.daemon`])
      bootout.exitCode = 0
    } catch (error) {
      bootout.error = true
      bootout.exitCode = error instanceof InstallProcessError ? error.exitCode : null
    }
  }
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  process.env.HOME = originalHome
  process.env.PATH = originalPath
  await rm(home, { recursive: true, force: true })
  await mkdir('artifacts/local-installer', { recursive: true })
  await writeFile('artifacts/local-installer/fixture-cleanup.json', JSON.stringify({
    schema: 'issue1512.macos-fixture-cleanup.v1', finishedAt: new Date().toISOString(),
    bootout, fixtureServerClosed: true, environmentRestored: true, fixtureHomeRemoved: true,
    limitation: 'A nonzero bootout does not establish service absence. Process absence is not independently probed here.',
  }, null, 2) + '\n')
}
