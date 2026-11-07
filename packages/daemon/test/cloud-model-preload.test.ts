import { chmodSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { preloadCloudWorker } from '../src/cloud-bootstrap'
import { probeHostedRuntimeModels, reusableHostedModels } from '../src/cloud-model-probe'
import { Daemon } from '../src/main'
import { RpcServer } from '../src/rpc/server'
import { MemoryServer } from '../src/server-link'
import * as fsUtil from '../src/fs-util'
import { cleanupTempDirs, tempDir, waitFor } from './helpers'

const identity = { sourceCommit: 'a'.repeat(40), workerSha: 'b'.repeat(40) }

async function receiptProbe(binaries: Partial<Record<'codex' | 'claude_code', string>>) {
  const probe = await probeHostedRuntimeModels(binaries)
  return { ...probe, manifest: { version: 1 as const, kind: 'desktop' as const,
    original: Object.fromEntries(['claude_code', 'codex'].map(harness => {
      const path = binaries[harness as keyof typeof binaries]
      return [harness, path ? { path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') } : null]
    })) as { claude_code: { path: string; sha256: string } | null; codex: { path: string; sha256: string } | null },
    added: {},
  } }
}

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

function active(pid: number, readState = () => readFileSync(`/proc/${pid}/stat`, 'utf8')) {
  // A container's /proc view can retain a readable entry after this PID has
  // exited in the caller's process namespace. Check that namespace first.
  try { process.kill(pid, 0) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error }
  try {
    // Orphan zombies can await the test container's init reaper, but cannot
    // execute or hold the anonymous CLI's pipes/configuration open.
    if (process.platform === 'linux') return !/\) [ZX] /.test(readState())
    return true
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}

it('checks the caller PID namespace before trusting a surviving proc entry and preserves observation errors', () => {
  const state = vi.fn(() => '77 (node) S 1 1 ')
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) })
  expect(active(77, state)).toBe(false)
  expect(kill).toHaveBeenCalledWith(77, 0)
  expect(state).not.toHaveBeenCalled()
  const denied = Object.assign(new Error('denied'), { code: 'EPERM' })
  kill.mockImplementation(() => { throw denied })
  expect(() => active(77, state)).toThrow(denied)
  expect(state).not.toHaveBeenCalled()
  kill.mockReturnValue(true)
  expect(active(77, state)).toBe(true)
  if (process.platform === 'linux') {
    state.mockReturnValue('77 (node) Z 1 1 ')
    expect(active(77, state)).toBe(false)
    state.mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }) })
    expect(active(77, state)).toBe(false)
    const io = Object.assign(new Error('failed to inspect'), { code: 'EIO' })
    state.mockImplementation(() => { throw io })
    expect(() => active(77, state)).toThrow(io)
  }
})

it('probes both official selections concurrently without credentials, then marks ready only after their groups exit', async () => {
  const root = tempDir(), directory = tempDir()
  const codex = cli(root, 'codex', { held: true, child: true }), claude = cli(root, 'claude_code', { held: true })
  vi.stubEnv('ANTHROPIC_API_KEY', 'must-not-enter-snapshot'); vi.stubEnv('GH_TOKEN', 'must-not-enter-probe')
  let accepted: unknown
  const failed = vi.fn()
  const atomicWrite = fsUtil.writeFileAtomic
  const record = vi.spyOn(fsUtil, 'writeFileAtomic').mockImplementation((file, data, mode) => {
    expect(file).toBe(join(directory, 'preloaded-models.json'))
    expect(existsSync(join(directory, 'preloaded.pid'))).toBe(false)
    for (const fixture of [codex, claude]) expect(active(JSON.parse(readFileSync(fixture.started, 'utf8')).pid)).toBe(false)
    expect(active(Number(readFileSync(join(root, 'codex.child'), 'utf8')))).toBe(false)
    atomicWrite(file, data, mode)
  })
  const started = preloadCloudWorker(directory, async models => { accepted = models }, failed,
    () => receiptProbe({ codex: codex.binary, claude_code: claude.binary }), () => identity)
  await waitFor(() => existsSync(codex.started) && existsSync(claude.started))
  expect(existsSync(join(directory, 'preloaded.pid'))).toBe(false)
  expect(readdirSync(directory)).toEqual([])
  writeFileSync(join(root, 'release'), '')
  const close = await started
  try {
    expect(record).toHaveBeenCalledTimes(1)
    expect(readFileSync(join(directory, 'preloaded.pid'), 'utf8')).toBe(`${process.pid}\n`)
    const catalogue = join(directory, 'preloaded-models.json')
    expect(statSync(catalogue).mode & 0o777).toBe(0o444)
    const saved = JSON.parse(readFileSync(catalogue, 'utf8'))
    expect(Object.keys(saved).sort()).toEqual(['binaries', 'manifest', 'reports', 'sourceCommit', 'version', 'workerSha'])
    expect(saved).toMatchObject({ version: 1, ...identity,
      binaries: { claude_code: claude.binary, codex: codex.binary },
      reports: [{ harness: 'claude_code', models: ['fixture-claude'] }, { harness: 'codex', models: ['fixture-codex'] }],
    })
    expect(readFileSync(catalogue, 'utf8')).not.toContain('must-not-enter')
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
  expect(existsSync(join(directory, 'preloaded-models.json'))).toBe(false)
})

it('drains the other live probe before rejecting a failed catalogue and never announces ready', async () => {
  const root = tempDir(), directory = tempDir()
  const codex = cli(root, 'codex', { held: true }), claude = cli(root, 'claude_code', { fail: true })
  let settled = false
  const result = preloadCloudWorker(directory, async () => {}, () => {},
    () => receiptProbe({ codex: codex.binary, claude_code: claude.binary }), () => identity)
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

it('never publishes PID-ready or installs a handoff watcher if the read-only receipt cannot be written', async () => {
  const root = tempDir(), directory = tempDir()
  const codex = cli(root, 'codex'), claude = cli(root, 'claude_code')
  const before = process.listenerCount('SIGUSR1'), error = Object.assign(new Error('fixture write failed'), { code: 'ENOSPC' })
  vi.spyOn(fsUtil, 'writeFileAtomic').mockImplementation(() => { throw error })
  await expect(preloadCloudWorker(directory, async () => {}, () => {},
    () => receiptProbe({ codex: codex.binary, claude_code: claude.binary }), () => identity)).rejects.toBe(error)
  expect(readdirSync(directory)).toEqual([])
  expect(process.listenerCount('SIGUSR1')).toBe(before)
  for (const fixture of [codex, claude]) expect(active(JSON.parse(readFileSync(fixture.started, 'utf8')).pid)).toBe(false)
})

it('refuses a release switch during the probe without writing a receipt or announcing ready', async () => {
  const root = tempDir(), directory = tempDir()
  const codex = cli(root, 'codex'), claude = cli(root, 'claude_code')
  const identify = vi.fn().mockReturnValueOnce(identity).mockReturnValueOnce({ ...identity, sourceCommit: 'c'.repeat(40) })
  const before = process.listenerCount('SIGUSR1')
  await expect(preloadCloudWorker(directory, async () => {}, () => {},
    () => receiptProbe({ codex: codex.binary, claude_code: claude.binary }), identify)).rejects.toThrow('cloud_model_receipt_identity_changed')
  expect(readdirSync(directory)).toEqual([])
  expect(process.listenerCount('SIGUSR1')).toBe(before)
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
