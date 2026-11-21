import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as autoUpdate from '../src/auto-update'
import { managedAutoUpdateRuntime, newerStableVersion, recordUpdateFailure, reportedUpdateFailure, updateAllowed } from '../src/auto-update'
import { Daemon } from '../src/main'
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
it('the server names the release; only a daemon the server refused as too old asks npm for latest', async () => {
  expect('checkLatestVersion' in autoUpdate).toBe(false)
  // npm calls: `root --global` (is this the global CLI?), `install` of a named version, and `view` for a refused daemon.
  const source = readFileSync(new URL('../src/auto-update.ts', import.meta.url), 'utf8')
  expect(source).toContain("'install', '--global', '--engine-strict', `${PACKAGE}@${version}`")
  expect(source).toContain("['view', `${PACKAGE}@latest`, 'version']")
  const daemon = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
  expect(daemon.match(/\.latest\?\.\(\)/g)).toHaveLength(1)
  expect(daemon).toMatch(/private async findRequiredUpdate[\s\S]*?runtime\.latest\?\.\(\)/)
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
it('excludes foreground, development, opted-out and source CLIs', async () => {
  vi.stubEnv('MIKKA_SERVICE', '')
  expect(await managedAutoUpdateRuntime(import.meta.filename, 'prod', true)).toBeUndefined()
  vi.stubEnv('MIKKA_SERVICE', 'launchd')
  expect(await managedAutoUpdateRuntime(import.meta.filename, 'dev', true)).toBeUndefined()
  expect(await managedAutoUpdateRuntime(import.meta.filename, 'prod', false)).toBeUndefined()
  expect(await managedAutoUpdateRuntime(import.meta.filename, 'prod', true)).toBeUndefined()
})

function maintenanceDaemon() {
  const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() }
  const daemon = new Daemon({ dataDir: join(stateFile(), '..'), flavor: 'prod', link: {} as never, log: log as never })
  const internal = daemon as unknown as {
    supervisor: { activeRunIds: () => unknown[]; sessionClosed?: () => void }
    claimsInFlight: number; stopped: boolean; updating: boolean
    maintenance: Promise<void> | null; updateVersion?: string
    options: { autoUpdate?: { install(version: string): Promise<void>; latest?(): Promise<string | undefined> } }
    startMaintenance(work: () => Promise<void>): void; checkAutoUpdate(): void
    claimAndStart(id: string): Promise<unknown>; claimAndStartInternal(id: string): Promise<unknown>; offerUpdate(latest: string | undefined): void
    enterUpdateRequired(latest?: string): void; findRequiredUpdate(latest?: string): Promise<void>
    knownLatest?: string; paths: { dataDir: string }
    handlers(): { 'daemon.update'(params: object): Promise<{ state: string }> }
  }
  internal.supervisor = { activeRunIds: () => [], sessionClosed: () => {} }
  return { daemon, internal, log }
}
it('waits for runs and in-flight claims, then blocks admissions during background installation', async () => {
  const { internal } = maintenanceDaemon()
  let finish!: () => void
  const work = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
  internal.supervisor.activeRunIds = () => [{}]
  internal.startMaintenance(work)
  internal.supervisor.activeRunIds = () => []
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
  internal.options.autoUpdate = { install: vi.fn(async () => { throw new Error('npm failure') }) }
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
  internal.options.autoUpdate = { install: async version => { events.push(version) } }
  internal.updateVersion = '1.0.1'
  internal.checkAutoUpdate()
  await internal.maintenance
  expect(events).toEqual(['1.0.1', 'restart'])
})
it('keeps session passes responsive while an install is held', async () => {
  const { daemon, internal } = maintenanceDaemon()
  const report = vi.fn(async () => ({}))
  const fetchCommands = vi.fn(async () => [])
  Object.assign(internal, {
    device: { credential: 'fixture', deviceId: 'device-1' }, registered: true,
    options: { link: { report, fetchCommands, listRepos: async () => [] } },
    worktrees: { diskUsage: async () => 0 }, outbox: { flushAll: async () => {} }, runnerReport: async () => undefined,
    journal: { all: () => [] }, pruneWorktrees: async () => {}, sweepEmptyRuns: async () => {},
    supervisor: { activeRunIds: () => [] },
  })
  let finish!: () => void
  internal.startMaintenance(() => new Promise<void>(resolve => { finish = resolve }))
  await daemon.syncWithServer()
  await daemon.syncWithServer()
  expect(fetchCommands).toHaveBeenCalledTimes(2)
  expect(report).toHaveBeenCalledOnce() // nothing changed after the first
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
    supervisor: { activeRunIds: () => active, start: async () => { active.push({}); return {} } },
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
it('a refusal that names a release updates to it without asking npm; one that names none asks npm', async () => {
  vi.spyOn(service, 'restartService').mockResolvedValue(undefined)
  const named = maintenanceDaemon()
  const install = vi.fn(async () => {})
  const latest = vi.fn(async () => '998.0.0')
  named.internal.options.autoUpdate = { install, latest }
  named.internal.enterUpdateRequired('999.0.0')
  await vi.waitFor(() => expect(install).toHaveBeenCalledOnce())
  await named.internal.maintenance
  expect(install).toHaveBeenCalledExactlyOnceWith('999.0.0')
  expect(latest).not.toHaveBeenCalled()
  expect(named.internal.knownLatest).toBe('999.0.0')
  // A refusal is terminal until the restart into the new release.
  expect(named.daemon.sessionState()).toBe('update_required')

  const unnamed = maintenanceDaemon()
  unnamed.internal.options.autoUpdate = { install, latest }
  unnamed.internal.enterUpdateRequired()
  await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(2))
  await unnamed.internal.maintenance
  expect(latest).toHaveBeenCalledOnce()
  expect(install).toHaveBeenLastCalledWith('998.0.0')

  // Unmanaged, or npm names nothing newer: nothing to install; the person updates by hand.
  const manual = maintenanceDaemon()
  manual.internal.options.autoUpdate = { install, latest: async () => '0.0.1' }
  await manual.internal.findRequiredUpdate()
  expect(manual.internal.maintenance).toBeNull()
})
it('a newer release named by the server installs once, when idle; a failure keeps this version running, backs off and is reported', async () => {
  const restart = vi.spyOn(service, 'restartService').mockResolvedValue(undefined)
  const { internal } = maintenanceDaemon()
  const file = join(internal.paths.dataDir, 'auto-update.json')
  const install = vi.fn(async () => { throw new Error('npm failure') })
  internal.options.autoUpdate = { install }
  internal.offerUpdate(undefined)
  internal.offerUpdate('0.0.1')
  expect(internal.updateVersion).toBeUndefined()
  internal.offerUpdate('999.0.0')
  expect(internal.updateVersion).toBe('999.0.0')
  internal.supervisor.activeRunIds = () => [{}]
  internal.checkAutoUpdate()
  expect(install).not.toHaveBeenCalled()
  internal.supervisor.activeRunIds = () => []
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
  /** With the session open, the ask runs one pass now; its commands read names the release (or none). */
  const serverNames = (daemon: Daemon, latest: string | undefined) => {
    Reflect.set(daemon, 'sessionOpen', true)
    return vi.spyOn(daemon, 'syncWithServer').mockImplementation(async () => { Reflect.get(daemon, 'learnRelease').call(daemon, latest) })
  }
  it('asks the server now and installs the release it names when idle, never npm', async () => {
    const restart = vi.spyOn(service, 'restartService').mockResolvedValue(undefined)
    const { daemon, internal } = maintenanceDaemon()
    const sync = serverNames(daemon, '999.0.0')
    const install = vi.fn(async () => {})
    internal.options.autoUpdate = { install }
    expect(await ask(internal)).toEqual({ state: 'installing' })
    expect(sync).toHaveBeenCalledOnce()
    await internal.maintenance
    expect(install).toHaveBeenCalledWith('999.0.0')
    expect(restart).toHaveBeenCalledOnce()
  })
  it('does nothing when this daemon is already the latest release, or the server names none', async () => {
    const restart = vi.spyOn(service, 'restartService').mockResolvedValue(undefined)
    for (const latest of ['0.0.1', undefined]) {
      const { daemon, internal } = maintenanceDaemon()
      serverNames(daemon, latest)
      const install = vi.fn(async () => {})
      internal.options.autoUpdate = { install }
      expect(await ask(internal)).toEqual({ state: 'current' })
      expect(internal.maintenance).toBeNull()
      expect(install).not.toHaveBeenCalled()
    }
    expect(restart).not.toHaveBeenCalled()
  })
  it('an unreachable server leaves this version running', async () => {
    const { daemon, internal } = maintenanceDaemon()
    vi.spyOn(daemon, 'syncWithServer').mockRejectedValue(new Error('offline'))
    internal.options.autoUpdate = { install: vi.fn(async () => {}) }
    expect(await ask(internal)).toEqual({ state: 'current' })
  })
  it('waits for a running run, then installs on the next idle pass', async () => {
    vi.spyOn(service, 'restartService').mockResolvedValue(undefined)
    const { daemon, internal } = maintenanceDaemon()
    serverNames(daemon, '999.0.0')
    const install = vi.fn(async () => {})
    internal.options.autoUpdate = { install }
    internal.supervisor.activeRunIds = () => [{}]
    expect(await ask(internal)).toEqual({ state: 'waiting' })
    expect(install).not.toHaveBeenCalled()
    expect(internal.updating).toBe(false)
    internal.supervisor.activeRunIds = () => []
    internal.checkAutoUpdate()
    await internal.maintenance
    expect(install).toHaveBeenCalledWith('999.0.0')
  })
  it('a development, foreground or source daemon is not updated and never asks the server', async () => {
    const { daemon, internal } = maintenanceDaemon()
    const sync = serverNames(daemon, '999.0.0')
    internal.options.autoUpdate = undefined
    expect(await ask(internal)).toEqual({ state: 'unmanaged' })
    expect(sync).not.toHaveBeenCalled()
  })
  it('a failed install keeps this version running and is reported to Settings › Devices', async () => {
    const restart = vi.spyOn(service, 'restartService').mockResolvedValue(undefined)
    const { daemon, internal } = maintenanceDaemon()
    serverNames(daemon, '999.0.0')
    const file = join(internal.paths.dataDir, 'auto-update.json')
    internal.options.autoUpdate = { install: vi.fn(async () => { throw new Error('npm failure') }) }
    expect(await ask(internal)).toEqual({ state: 'installing' })
    await internal.maintenance
    expect(restart).not.toHaveBeenCalled()
    expect(internal.updating).toBe(false)
    expect(reportedUpdateFailure(file, '0.0.1')).toMatchObject({ version: '999.0.0', code: 'install_failed' })
  })
})

it('desktop-managed updates keep their private prefix/cache without changing legacy installs', () => {
  const env = { PATH: '/usr/bin', npm_config_cache: '/old/root-owned/cache' }
  expect(autoUpdate.serviceNpmEnvironment('/home/alex/.mikka/npm/lib/node_modules/@aspectlylabs/mikka/mikka.js', '/home/alex', env)).toEqual({ ...env, npm_config_prefix: '/home/alex/.mikka/npm', npm_config_cache: '/home/alex/.mikka/npm-cache' })
  expect(autoUpdate.serviceNpmEnvironment('/usr/local/lib/node_modules/@aspectlylabs/mikka/mikka.js', '/home/alex', env)).toBe(env)
})
