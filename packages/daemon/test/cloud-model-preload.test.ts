import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { preloadCloudWorker } from '../src/cloud-bootstrap'
import { probeHostedRuntimeModels, reusableHostedModels } from '../src/cloud-model-probe'
import { Daemon } from '../src/main'
import { RpcServer } from '../src/rpc/server'
import { MemoryServer } from '../src/server-link'
import { cleanupTempDirs, tempDir, waitFor } from './helpers'

const daemons: Daemon[] = []
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop()
  vi.restoreAllMocks(); vi.unstubAllEnvs(); cleanupTempDirs()
})

function cli(root: string, harness: 'codex' | 'claude_code', options: { held?: boolean; fail?: boolean; child?: boolean } = {}) {
  const binary = join(root, harness), started = join(root, `${harness}.started`), calls = join(root, `${harness}.calls`)
  writeFileSync(binary, `#!${process.execPath}
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
appendFileSync(${JSON.stringify(calls)}, 'probe\\n')
writeFileSync(${JSON.stringify(started)}, JSON.stringify({ pid: process.pid, home: process.env.HOME, env: Object.keys(process.env).sort() }))
if (${Boolean(options.fail)}) process.exit(3)
const native = ${Boolean(options.child)} ? spawn(process.execPath, ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(join(root, `${harness}.child`))}, String(process.pid)); setInterval(() => {}, 1000)`) }], { stdio: 'inherit' }) : undefined
let buffer = '', waiting
const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
const timer = setInterval(() => {
  if (!waiting || (${Boolean(options.held)} && !existsSync(${JSON.stringify(join(root, 'release'))})) ||
      (native && !existsSync(${JSON.stringify(join(root, `${harness}.child`))}))) return
  const message = waiting; waiting = undefined
  if (message.id === 2) send({ id: 2, result: { data: [{ id: 'fixture-codex', model: 'fixture-codex', isDefault: true }] } })
  else send({ type: 'control_response', response: { subtype: 'success', response: { models: [{ value: 'fixture-claude', resolvedModel: 'fixture-claude' }] } } })
}, 5)
process.stdin.on('data', chunk => {
  buffer += chunk
  let newline
  while ((newline = buffer.indexOf('\\n')) >= 0) {
    const message = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1)
    if (message.id === 1) send({ id: 1, result: {} })
    else waiting = message
  }
})
process.once('exit', () => clearInterval(timer))
`)
  chmodSync(binary, 0o700)
  return { binary, started, calls: () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').length : 0 }
}

function active(pid: number) {
  try {
    // Orphan zombies can await the test container's init reaper, but cannot
    // execute or hold the anonymous CLI's pipes/configuration open.
    if (process.platform === 'linux') return !/\) [ZX] /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))
    process.kill(pid, 0); return true
  } catch { return false }
}

it('probes both official selections concurrently without credentials, then marks ready only after their groups exit', async () => {
  const root = tempDir(), directory = tempDir()
  const codex = cli(root, 'codex', { held: true, child: true }), claude = cli(root, 'claude_code', { held: true })
  vi.stubEnv('ANTHROPIC_API_KEY', 'must-not-enter-snapshot'); vi.stubEnv('GH_TOKEN', 'must-not-enter-probe')
  let accepted: unknown
  const failed = vi.fn()
  const started = preloadCloudWorker(directory, async models => { accepted = models }, failed,
    () => probeHostedRuntimeModels({ codex: codex.binary, claude_code: claude.binary }))
  await waitFor(() => existsSync(codex.started) && existsSync(claude.started))
  expect(existsSync(join(directory, 'preloaded.pid'))).toBe(false)
  expect(readdirSync(directory)).toEqual([])
  writeFileSync(join(root, 'release'), '')
  const close = await started
  try {
    expect(readFileSync(join(directory, 'preloaded.pid'), 'utf8')).toBe(`${process.pid}\n`)
    for (const fixture of [codex, claude]) {
      const receipt = JSON.parse(readFileSync(fixture.started, 'utf8'))
      expect(receipt.env).toEqual(['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HOME', 'LANG', 'PATH'])
      expect(active(receipt.pid)).toBe(false)
      expect(existsSync(receipt.home)).toBe(false)
    }
    expect(active(Number(readFileSync(join(root, 'codex.child'), 'utf8')))).toBe(false)
    expect(accepted).toBeUndefined()
    // The watcher merely receives a handoff here; this test never installs an identity.
    writeFileSync(join(directory, 'bootstrap.json'), '{}')
    await waitFor(() => Boolean(accepted))
    expect(accepted).toMatchObject({ reports: [
      { harness: 'claude_code', models: ['fixture-claude'] }, { harness: 'codex', models: ['fixture-codex'] },
    ] })
    expect(failed).not.toHaveBeenCalled()
  } finally { close() }
  expect(existsSync(join(directory, 'preloaded.pid'))).toBe(false)
})

it('drains the other live probe before rejecting a failed catalogue and never announces ready', async () => {
  const root = tempDir(), directory = tempDir()
  const codex = cli(root, 'codex', { held: true }), claude = cli(root, 'claude_code', { fail: true })
  let settled = false
  const result = preloadCloudWorker(directory, async () => {}, () => {},
    () => probeHostedRuntimeModels({ codex: codex.binary, claude_code: claude.binary }))
  const outcome = result.then(() => { settled = true; return null }, error => { settled = true; return error })
  await waitFor(() => existsSync(codex.started) && existsSync(claude.started))
  await waitFor(() => !active(JSON.parse(readFileSync(claude.started, 'utf8')).pid))
  expect(settled).toBe(false)
  expect(existsSync(join(directory, 'preloaded.pid'))).toBe(false)
  writeFileSync(join(root, 'release'), '')
  expect(await outcome).toEqual(Error('hosted_model_probe_unavailable'))
  const receipt = JSON.parse(readFileSync(codex.started, 'utf8'))
  expect(active(receipt.pid)).toBe(false)
  expect(existsSync(receipt.home)).toBe(false)
  expect(readdirSync(directory)).toEqual([])
})

it('does not reuse models after a binary changes or when a selected CLI is missing from the report', async () => {
  vi.stubEnv('PATH', dirname(process.execPath))
  const root = tempDir(), claude = cli(root, 'claude_code')
  const probe = await probeHostedRuntimeModels({ claude_code: claude.binary })
  expect(reusableHostedModels(probe, probe.binaries)).toBe(probe.reports)
  expect(reusableHostedModels({ ...probe, reports: [] }, probe.binaries)).toBeUndefined()
  writeFileSync(claude.binary, `${readFileSync(claude.binary, 'utf8')}\n// updated CLI\n`)
  expect(reusableHostedModels(probe, probe.binaries)).toBeUndefined()
})

it('registers frozen real reports before the first sync, serves its model gate without probing, and refreshes six hours after handoff', async () => {
  vi.stubEnv('PATH', dirname(process.execPath))
  const root = tempDir(), claude = cli(root, 'claude_code')
  const probe = await probeHostedRuntimeModels({ claude_code: claude.binary })
  const realNow = Date.now
  let offset = 14 * 24 * 3600_000
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset)
  vi.spyOn(RpcServer.prototype, 'listen').mockResolvedValue() // The local UI socket is unrelated to model registration.
  if (process.getuid?.() === 0) vi.spyOn(process, 'getuid').mockReturnValue(1000)
  const link = new MemoryServer('preloaded-models').link(), register = vi.spyOn(link, 'registerDevice')
  const daemon = await new Daemon({ dataDir: tempDir(), flavor: 'dev', link, credential: 'fixture-credential',
    hostedSubscriptions: true, harnessBinaries: probe.binaries, preloadedModels: probe, modelProbe: true, quotaSource: null }).start()
  daemons.push(daemon)
  await daemon.syncWithServer()
  expect(register.mock.calls[0]?.[1].harnesses).toEqual(expect.arrayContaining([
    expect.objectContaining({ harness: 'claude_code', models: ['fixture-claude'] }),
  ]))
  expect(await Reflect.get(daemon, 'reportedModels').call(daemon, 'claude_code')).toMatchObject({ models: ['fixture-claude'] })
  expect(claude.calls()).toBe(1)
  offset += 6 * 3600_000 - 60_000
  await daemon.syncWithServer()
  expect(claude.calls()).toBe(1)
  offset += 60_000
  await daemon.syncWithServer()
  await waitFor(() => claude.calls() === 2)
  await Reflect.get(daemon, 'probingModels')
})

it('keeps the normal real-probe path when a cloud worker has no preloaded result', async () => {
  vi.stubEnv('PATH', dirname(process.execPath))
  const root = tempDir(), claude = cli(root, 'claude_code')
  vi.spyOn(RpcServer.prototype, 'listen').mockResolvedValue()
  if (process.getuid?.() === 0) vi.spyOn(process, 'getuid').mockReturnValue(1000)
  const daemon = await new Daemon({ dataDir: tempDir(), flavor: 'dev', link: new MemoryServer('unprepared-models').link(),
    credential: 'fixture-credential', hostedSubscriptions: true, harnessBinaries: { claude_code: claude.binary }, modelProbe: true, quotaSource: null }).start()
  daemons.push(daemon)
  expect(await Reflect.get(daemon, 'reportedModels').call(daemon, 'claude_code')).toMatchObject({ models: ['fixture-claude'] })
  expect(claude.calls()).toBe(1)
})
