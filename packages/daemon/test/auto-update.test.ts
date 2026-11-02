import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkLatestVersion, managedAutoUpdateRuntime, newerStableVersion, recordUpdateFailure, reportedUpdateFailure, updateAllowed } from '../src/auto-update'
import { Daemon } from '../src/main'
import { RunNotPinnedHereError } from '../src/errors'
import * as service from '../src/service'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllEnvs() })
function stateFile() {
  const dir = mkdtempSync(join(tmpdir(), 'mikka-update-')); dirs.push(dir)
  return join(dir, 'auto-update.json')
}
it.each([
  ['1.2.4', '1.2.3', true], ['2.0.0', '1.9.9', true], ['1.10.0', '1.9.0', true],
  ['1.2.3', '1.2.3', false], ['1.1.9', '1.2.0', false], ['1.2.4-beta.1', '1.2.3', false],
  ['01.2.4', '1.2.3', false], ['1.2.4;touch /tmp/oops', '1.2.3', false], ['1.2.4', '1.2.3-dev', false],
])('stable upgrade %s from %s = %s', (candidate, current, expected) => {
  expect(newerStableVersion(candidate, current)).toBe(expected)
})
it('persists failed attempts before I/O and retries only after an hour, including across restarts', async () => {
  const file = stateFile(), now = 1_800_000_000_000
  const runtime = { latest: vi.fn(async (): Promise<string> => { expect(JSON.parse(readFileSync(file, 'utf8')).lastAttemptAt).toBe(now); throw new Error('registry unavailable') }), install: vi.fn() }
  await expect(checkLatestVersion(file, '1.0.0', runtime, now)).rejects.toThrow('unavailable')
  runtime.latest.mockImplementation(async () => '1.0.1')
  expect(await checkLatestVersion(file, '1.0.0', runtime, now + 1)).toBeUndefined()
  expect(await checkLatestVersion(file, '1.0.0', runtime, now + 3_599_999)).toBeUndefined()
  expect(await checkLatestVersion(file, '1.0.0', runtime, now + 3_600_000)).toBe('1.0.1')
  expect(runtime.latest).toHaveBeenCalledTimes(2)
})
it('a server asking for a newer daemon shortens the wait to five minutes', async () => {
  const file = stateFile(), now = 1_800_000_000_000
  const runtime = { latest: vi.fn(async () => '1.0.1'), install: vi.fn() }
  expect(await checkLatestVersion(file, '1.0.0', runtime, now)).toBe('1.0.1')
  expect(await checkLatestVersion(file, '1.0.0', runtime, now + 299_999, true)).toBeUndefined()
  expect(await checkLatestVersion(file, '1.0.0', runtime, now + 300_000, true)).toBe('1.0.1')
  expect(runtime.latest).toHaveBeenCalledTimes(2)
})
it('a failed install of a version backs off 5 minutes, 30 minutes, then 2 hours, and is reported until a newer daemon runs', () => {
  const file = stateFile(), now = 1_800_000_000_000
  expect(updateAllowed(file, '1.0.1', now)).toBe(true)
  expect(reportedUpdateFailure(file, '1.0.0')).toBeNull()
  let at = now
  for (const wait of [300_000, 1_800_000, 7_200_000, 7_200_000]) {
    recordUpdateFailure(file, '1.0.1', 'install_failed', at)
    expect(updateAllowed(file, '1.0.1', at + wait - 1)).toBe(false)
    expect(updateAllowed(file, '1.0.1', at + wait)).toBe(true)
    at += wait
  }
  expect(updateAllowed(file, '1.0.2', now)).toBe(true)
  expect(reportedUpdateFailure(file, '1.0.0')).toEqual({ version: '1.0.1', code: 'install_failed', at: new Date(at - 7_200_000).toISOString() })
  expect(reportedUpdateFailure(file, '1.0.1')).toBeNull()
})
it('a version check keeps the recorded failure', async () => {
  const file = stateFile(), now = 1_800_000_000_000
  recordUpdateFailure(file, '1.0.1', 'restart_failed', now)
  await checkLatestVersion(file, '1.0.0', { latest: async () => '1.0.1', install: vi.fn() }, now)
  expect(reportedUpdateFailure(file, '1.0.0')?.code).toBe('restart_failed')
})
it('excludes foreground, development, opted-out and source CLIs', async () => {
  vi.stubEnv('MIKKA_SERVICE', '')
  expect(await managedAutoUpdateRuntime(import.meta.filename, 'prod', true)).toBeUndefined()
  vi.stubEnv('MIKKA_SERVICE', 'launchd')
  expect(await managedAutoUpdateRuntime(import.meta.filename, 'dev', true)).toBeUndefined()
  expect(await managedAutoUpdateRuntime(import.meta.filename, 'prod', false)).toBeUndefined()
  expect(await managedAutoUpdateRuntime(import.meta.filename, 'prod', true)).toBeUndefined()
})

function maintenanceDaemon() {
  const log = { warn: vi.fn() }
  const daemon = new Daemon({ dataDir: join(stateFile(), '..'), flavor: 'prod', link: {} as never, log: log as never })
  const internal = daemon as unknown as {
    supervisor: { heartbeatRuns: () => unknown[] }
    claimsInFlight: number; stopped: boolean; updating: boolean
    maintenance: Promise<void> | null; updateVersion?: string
    options: { autoUpdate?: { latest(): Promise<string>; install(version: string): Promise<void> } }
    startMaintenance(work: () => Promise<void>): void; checkAutoUpdate(): void
    claimAndStart(id: string): Promise<unknown>; claimAndStartInternal(id: string): Promise<unknown>; offerUpdate(latest: string | undefined): void
    updateCheck: Promise<void> | null; paths: { dataDir: string }
    handlers(): { 'daemon.update'(params: object): Promise<{ state: string }> }
  }
  internal.supervisor = { heartbeatRuns: () => [] }
  return { daemon, internal, log }
}
it('waits for runs and in-flight claims, then blocks admissions during background installation', async () => {
  const { internal } = maintenanceDaemon()
  let finish!: () => void
  const work = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
  internal.supervisor.heartbeatRuns = () => [{}]
  internal.startMaintenance(work)
  internal.supervisor.heartbeatRuns = () => []
  internal.claimsInFlight = 1
  internal.startMaintenance(work)
  expect(work).not.toHaveBeenCalled()
  internal.claimsInFlight = 0
  internal.startMaintenance(work)
  expect(work).toHaveBeenCalledOnce()
  await expect(internal.claimAndStart('new-run')).rejects.toThrow('draining')
  finish(); await internal.maintenance
})
it('failed installs reopen admissions and never restart; teardown cannot restart after successful installation', async () => {
  const restart = vi.spyOn(service, 'restartService').mockResolvedValue(undefined)
  const { internal } = maintenanceDaemon()
  internal.options.autoUpdate = { latest: async () => '1.0.1', install: vi.fn(async () => { throw new Error('npm failure') }) }
  internal.updateVersion = '1.0.1'
  internal.checkAutoUpdate()
  await internal.maintenance
  expect(internal.updating).toBe(false)
  expect(restart).not.toHaveBeenCalled()
  let finish!: () => void
  internal.options.autoUpdate.install = () => new Promise<void>(resolve => { finish = resolve })
  // 1.0.1 is backing off after its failure; the next release installs.
  internal.updateVersion = '1.0.2'
  internal.checkAutoUpdate()
  internal.stopped = true
  finish(); await internal.maintenance
  expect(restart).not.toHaveBeenCalled()
})
it('restarts only after a successful exact-version install', async () => {
  const events: string[] = []
  vi.spyOn(service, 'restartService').mockImplementation(async () => { events.push('restart') })
  const { internal } = maintenanceDaemon()
  internal.options.autoUpdate = { latest: async () => '1.0.1', install: async version => { events.push(version) } }
  internal.updateVersion = '1.0.1'
  internal.checkAutoUpdate()
  await internal.maintenance
  expect(events).toEqual(['1.0.1', 'restart'])
})
it('keeps heartbeat syncs responsive while an install is held', async () => {
  const { daemon, internal } = maintenanceDaemon()
  const heartbeat = vi.fn(async () => ({ leases: [] }))
  Object.assign(internal, {
    device: { credential: 'fixture', deviceId: 'device-1' }, registered: true,
    options: { link: { heartbeat, listRepos: async () => [] } },
    worktrees: { diskUsage: async () => 0 }, outbox: { flushAll: async () => {} },
    journal: { all: () => [] }, pruneWorktrees: async () => {}, sweepEmptyRuns: async () => {},
    supervisor: { heartbeatRuns: () => [], renewLeases: () => {} },
  })
  let finish!: () => void
  internal.startMaintenance(() => new Promise<void>(resolve => { finish = resolve }))
  await daemon.syncWithServer()
  await daemon.syncWithServer()
  expect(heartbeat).toHaveBeenCalledTimes(2)
  expect(internal.updating).toBe(true)
  finish(); await internal.maintenance
})
it('counts the whole run claim and start before allowing an update', async () => {
  const { internal } = maintenanceDaemon()
  let finishClaim!: (value: { runId: string }) => void
  const active: unknown[] = []
  Object.assign(internal, {
    device: { deviceId: 'device-1' }, journal: { get: () => undefined },
    options: { link: { claimRun: () => new Promise(resolve => { finishClaim = resolve }) } },
    supervisor: { heartbeatRuns: () => active, start: async () => { active.push({}); return {} } },
  })
  const claim = internal.claimAndStart('run-1')
  const install = vi.fn(async () => {})
  internal.startMaintenance(install)
  expect(internal.claimsInFlight).toBe(1)
  expect(install).not.toHaveBeenCalled()
  finishClaim({ runId: 'run-1' }); await claim
  expect(internal.claimsInFlight).toBe(0)
  internal.startMaintenance(install)
  expect(install).not.toHaveBeenCalled()
  active.length = 0
  internal.startMaintenance(install)
  await internal.maintenance
  expect(install).toHaveBeenCalledOnce()
})
it('a claim refused as daemonUpgradeRequired checks for an update now, not at the next hourly check', async () => {
  const { internal } = maintenanceDaemon()
  writeFileSync(join(internal.paths.dataDir, 'auto-update.json'), JSON.stringify({ lastAttemptAt: Date.now() - 10 * 60_000 }))
  const latest = vi.fn(async () => '999.0.0')
  internal.options.autoUpdate = { latest, install: vi.fn(async () => {}) }
  for (const upgradeRequired of [false, true]) {
    internal.claimAndStartInternal = async id => { throw new RunNotPinnedHereError(id, upgradeRequired) }
    await expect(internal.claimAndStart('run-1')).rejects.toBeInstanceOf(RunNotPinnedHereError)
    await internal.updateCheck
    expect(latest).toHaveBeenCalledTimes(upgradeRequired ? 1 : 0)
  }
  expect(internal.updateVersion).toBe('999.0.0')
})
it('a newer release named by the server installs once, when idle; a failure keeps this version running, backs off and is reported', async () => {
  const restart = vi.spyOn(service, 'restartService').mockResolvedValue(undefined)
  const { internal } = maintenanceDaemon()
  const file = join(internal.paths.dataDir, 'auto-update.json')
  const install = vi.fn(async () => { throw new Error('npm failure') })
  internal.options.autoUpdate = { latest: vi.fn(async () => '999.0.0'), install }
  writeFileSync(file, JSON.stringify({ lastAttemptAt: Date.now() }))
  internal.offerUpdate(undefined)
  internal.offerUpdate('0.0.1')
  expect(internal.updateVersion).toBeUndefined()
  internal.offerUpdate('999.0.0')
  expect(internal.updateVersion).toBe('999.0.0')
  internal.supervisor.heartbeatRuns = () => [{}]
  internal.checkAutoUpdate()
  expect(install).not.toHaveBeenCalled()
  internal.supervisor.heartbeatRuns = () => []
  internal.checkAutoUpdate()
  await internal.maintenance
  expect(install).toHaveBeenCalledOnce()
  expect(restart).not.toHaveBeenCalled()
  expect(internal.updating).toBe(false)
  expect(reportedUpdateFailure(file, '0.0.1')).toMatchObject({ version: '999.0.0', code: 'install_failed' })
  internal.offerUpdate('999.0.0')
  expect(internal.updateVersion).toBeUndefined()
  internal.checkAutoUpdate()
  await internal.maintenance
  expect(install).toHaveBeenCalledOnce()
})

describe('daemon.update: the desktop app on this computer asks after it starts', () => {
  const ask = (internal: ReturnType<typeof maintenanceDaemon>['internal']) => internal.handlers()['daemon.update']({})
  it('checks the release now and installs a newer one when idle', async () => {
    const restart = vi.spyOn(service, 'restartService').mockResolvedValue(undefined)
    const { internal } = maintenanceDaemon()
    // An hourly check ran 10 minutes ago; the desktop's request does not wait for the next one.
    writeFileSync(join(internal.paths.dataDir, 'auto-update.json'), JSON.stringify({ lastAttemptAt: Date.now() - 10 * 60_000 }))
    const install = vi.fn(async () => {})
    internal.options.autoUpdate = { latest: vi.fn(async () => '999.0.0'), install }
    expect(await ask(internal)).toEqual({ state: 'installing' })
    await internal.maintenance
    expect(install).toHaveBeenCalledWith('999.0.0')
    expect(restart).toHaveBeenCalledOnce()
  })
  it('does nothing when this daemon is already the latest release', async () => {
    const restart = vi.spyOn(service, 'restartService').mockResolvedValue(undefined)
    const { internal } = maintenanceDaemon()
    const install = vi.fn(async () => {})
    internal.options.autoUpdate = { latest: vi.fn(async () => '0.0.1'), install }
    expect(await ask(internal)).toEqual({ state: 'current' })
    expect(internal.maintenance).toBeNull()
    expect(install).not.toHaveBeenCalled()
    expect(restart).not.toHaveBeenCalled()
  })
  it('waits for a running run, then installs on the next idle pass', async () => {
    vi.spyOn(service, 'restartService').mockResolvedValue(undefined)
    const { internal } = maintenanceDaemon()
    const install = vi.fn(async () => {})
    internal.options.autoUpdate = { latest: vi.fn(async () => '999.0.0'), install }
    internal.supervisor.heartbeatRuns = () => [{}]
    expect(await ask(internal)).toEqual({ state: 'waiting' })
    expect(install).not.toHaveBeenCalled()
    expect(internal.updating).toBe(false)
    internal.supervisor.heartbeatRuns = () => []
    internal.checkAutoUpdate()
    await internal.maintenance
    expect(install).toHaveBeenCalledWith('999.0.0')
  })
  it('a development, foreground or source daemon is not updated and never asks the registry', async () => {
    const { internal } = maintenanceDaemon()
    internal.options.autoUpdate = undefined
    expect(await ask(internal)).toEqual({ state: 'unmanaged' })
  })
  it('a failed install keeps this version running and is reported to Settings › Devices', async () => {
    const restart = vi.spyOn(service, 'restartService').mockResolvedValue(undefined)
    const { internal } = maintenanceDaemon()
    const file = join(internal.paths.dataDir, 'auto-update.json')
    internal.options.autoUpdate = { latest: vi.fn(async () => '999.0.0'), install: vi.fn(async () => { throw new Error('npm failure') }) }
    expect(await ask(internal)).toEqual({ state: 'installing' })
    await internal.maintenance
    expect(restart).not.toHaveBeenCalled()
    expect(internal.updating).toBe(false)
    expect(reportedUpdateFailure(file, '0.0.1')).toMatchObject({ version: '999.0.0', code: 'install_failed' })
  })
})
