import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkLatestVersion, managedAutoUpdateRuntime, newerStableVersion } from '../src/auto-update'
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
    claimAndStart(id: string): Promise<unknown>; claimAndStartInternal(id: string): Promise<unknown>
    updateCheck: Promise<void> | null; paths: { dataDir: string }
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
  internal.updateVersion = '1.0.1'
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
