import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Daemon } from '../src/main'
import { runCli } from '../src/cli'
import { createLogger } from '../src/log'
import { daemonPaths } from '../src/paths'
import { MemoryServer } from '../src/server-link'
import { connectDaemonInDataDir } from '../src/rpc/client'
import { writeJsonAtomic } from '../src/fs-util'
import { cleanupTempDirs, tempDir, waitFor } from './helpers'

const credential = `orv_${'n'.repeat(43)}`
const oldCredential = `orv_${'o'.repeat(43)}`
const daemons: Daemon[] = []
const io = { out() {}, err() {} }

afterEach(async () => {
  vi.restoreAllMocks()
  for (const daemon of daemons.splice(0)) await daemon.stop()
  cleanupTempDirs()
})

function daemon(dataDir: string) {
  const server = new MemoryServer('startup-device')
  const link = server.link()
  const register = vi.spyOn(link, 'registerDevice')
  const process = new Daemon({ dataDir, flavor: 'prod', link, harnesses: [{ harness: 'mock', installed: true, version: 'fixture' }],
    quotaSource: null, heartbeatMs: 60_000, log: createLogger({ level: 'silent' }) })
  daemons.push(process)
  return { process, register, link, server }
}

it('keeps the no-daemon login persisted for a later normal start', async () => {
  const root = tempDir()
  expect(await runCli(['daemon', 'login', '--data-dir', root, '--token', credential], io)).toBe(0)
  expect(JSON.parse(readFileSync(daemonPaths(root).device, 'utf8')).credential).toBe(credential)
  const { process, register } = daemon(root)
  await process.start()
  await process.syncWithServer()
  expect(process.status().server).toBe('online')
  expect(register).toHaveBeenCalledWith(credential, expect.any(Object), undefined)
})

it.each([undefined, oldCredential])('hands login to a daemon paused after reading its previous credential (%s)', async prior => {
  const root = tempDir()
  if (prior) writeJsonAtomic(daemonPaths(root).device, { credential: prior })
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const paused = new Promise<void>(resolve => { entered = resolve })
  // This is the production await after PID publication/device-file read and
  // before rpc.listen. No service-manager timing or arbitrary sleep is used.
  vi.spyOn(Daemon.prototype as unknown as { createAgentSandbox(): Promise<null> }, 'createAgentSandbox')
    .mockImplementation(async () => { entered(); await gate; return null })
  const { process, register } = daemon(root)
  const startup = process.start()
  await paused
  let reportedSuccess = false
  const login = runCli(['daemon', 'login', '--data-dir', root, '--token', credential], io).then(result => { reportedSuccess = true; return result })
  try {
    await waitFor(() => {
      try { return JSON.parse(readFileSync(daemonPaths(root).device, 'utf8')).credential === credential } catch { return false }
    })
    expect(reportedSuccess).toBe(false)
    release()
    await startup
    expect(await login).toBe(0)
    await process.syncWithServer()
    expect(process.status().server).toBe('online')
    expect(register.mock.calls.at(-1)?.[0]).toBe(credential)
    // A revoked/cleared live session must never re-import a stale disk value.
    const client = await connectDaemonInDataDir(root, { name: 'startup-test', version: 'fixture' })
    try { await client.request('device.clearCredential') } finally { client.close() }
    const count = register.mock.calls.length
    writeJsonAtomic(daemonPaths(root).device, { credential: oldCredential })
    await process.syncWithServer()
    expect(process.status().server).toBe('unregistered')
    expect(register).toHaveBeenCalledTimes(count)
  } finally { release(); await startup }
})

it.each(['replace', 'clear', 'workspace'] as const)('discards an in-flight registration after %s changes the device session', async change => {
  const root = tempDir()
  const workspaceId = '11111111-1111-4111-8111-111111111111'
  const nextWorkspaceId = '22222222-2222-4222-8222-222222222222'
  writeJsonAtomic(daemonPaths(root).device, { credential: oldCredential, workspaceId })
  vi.spyOn(Daemon.prototype as unknown as { createAgentSandbox(): Promise<null> }, 'createAgentSandbox').mockResolvedValue(null)
  const { process, register, link, server } = daemon(root)
  let release!: () => void, entered!: () => void, releaseNext!: () => void, enteredNext!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const paused = new Promise<void>(resolve => { entered = resolve })
  const nextGate = new Promise<void>(resolve => { releaseNext = resolve })
  const nextPaused = new Promise<void>(resolve => { enteredNext = resolve })
  register.mockImplementationOnce(async () => { entered(); await gate; return { deviceId: 'stale-device' } })
  register.mockImplementationOnce(async (...args) => { enteredNext(); await nextGate; return server.link().registerDevice(...args) })
  const heartbeat = vi.spyOn(link, 'heartbeat')
  await process.start()
  const oldSync = process.syncWithServer()
  const client = await connectDaemonInDataDir(root, { name: 'registration-test', version: 'fixture' })
  try {
    await paused
    if (change === 'clear') await client.request('device.clearCredential')
    else await client.request('device.setCredential', {
      credential: change === 'replace' ? credential : oldCredential,
      workspaceId: change === 'workspace' ? nextWorkspaceId : workspaceId,
    })
    release()
    await oldSync
    const saved = JSON.parse(readFileSync(daemonPaths(root).device, 'utf8'))
    expect(saved.deviceId).toBeUndefined()
    expect(saved.credential).toBe(change === 'clear' ? undefined : change === 'replace' ? credential : oldCredential)
    expect(saved.workspaceId).toBe(change === 'workspace' ? nextWorkspaceId : workspaceId)
    expect(heartbeat).not.toHaveBeenCalled()
    expect(register.mock.calls[0]?.[1].workspaceId).toBe(workspaceId)
    if (change === 'clear') {
      await process.syncWithServer()
      expect(process.status().server).toBe('unregistered')
      expect(register).toHaveBeenCalledTimes(1)
    } else {
      await nextPaused
      expect(register.mock.calls[1]?.[0]).toBe(change === 'replace' ? credential : oldCredential)
      expect(register.mock.calls[1]?.[1].workspaceId).toBe(change === 'workspace' ? nextWorkspaceId : workspaceId)
      expect(register.mock.calls[1]?.[2]).toBeUndefined()
      releaseNext()
      await process.syncWithServer()
      expect(JSON.parse(readFileSync(daemonPaths(root).device, 'utf8')).deviceId).toBe('startup-device')
      expect(heartbeat.mock.calls.every(([deviceId]) => deviceId === 'startup-device')).toBe(true)
      expect(process.status().server).toBe('online')
    }
  } finally { release(); releaseNext(); client.close(); await oldSync }
})

it('does not report success when a live holder never opens its RPC socket', async () => {
  const root = tempDir()
  writeFileSync(join(root, 'daemon.pid'), `${process.pid}\n`)
  await expect(runCli(['daemon', 'login', '--data-dir', root, '--token', credential], io))
    .rejects.toThrow('control socket did not become ready within 6 seconds')
}, 10_000)
