import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { readJson, writeJsonAtomic } from './fs-util'

const exec = promisify(execFile)
const PACKAGE = '@aspectlylabs/mikka'
// Releases ship on every main push; a daily check left devices hours behind the server.
const CHECK_INTERVAL = 60 * 60 * 1000

export function newerStableVersion(candidate: unknown, current: string): candidate is string {
  const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
  if (typeof candidate !== 'string' || !stable.test(candidate) || !stable.test(current)) return false
  const a = candidate.split('.').map(BigInt), b = current.split('.').map(BigInt)
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!
  return false
}

/** Run npm with the service's Node and configuration, even when PATH selects another Node. */
export async function runServiceNpm(args: string[]): Promise<string> {
  const npm = realpathSync(join(dirname(process.execPath), 'npm'))
  const { stdout } = await exec(process.execPath, [npm, ...args], {
    cwd: homedir(), timeout: 300_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` },
  })
  return stdout.trim()
}

export interface AutoUpdateRuntime {
  latest(): Promise<string>
  install(version: string): Promise<void>
}

/** Only the public global npm CLI may replace its installation. Embedded/source entries stay out. */
export async function managedAutoUpdateRuntime(entry: string, flavor: string, enabled: boolean): Promise<AutoUpdateRuntime | undefined> {
  if (!enabled || flavor !== 'prod' || !['systemd', 'launchd'].includes(process.env.MIKKA_SERVICE ?? '')) return
  try {
    const file = realpathSync(resolve(entry))
    const root = dirname(file)
    const pkg = readJson(join(root, 'package.json')) as { name?: string; private?: boolean } | undefined
    if (pkg?.name !== PACKAGE || pkg.private !== false) return
    const globalRoot = await runServiceNpm(['root', '--global'])
    if (realpathSync(join(globalRoot, PACKAGE)) !== root || file !== join(root, 'mikka.js')) return
    return {
      latest: async () => JSON.parse(await runServiceNpm(['view', `${PACKAGE}@latest`, 'version', '--json'])) as string,
      install: async version => { await runServiceNpm(['install', '--global', '--engine-strict', `${PACKAGE}@${version}`]) },
    }
  } catch { return undefined }
}

// A server that refuses this daemon as too old asks for a check now, at most this often.
const URGENT_CHECK_INTERVAL = 5 * 60 * 1000

type UpdateFailureCode = 'install_failed' | 'restart_failed'
interface UpdateState {
  lastAttemptAt?: number
  /** The last failed install of `version`; cleared by the restart into a newer version. */
  failure?: { version: string; code: UpdateFailureCode; at: number; attempts: number }
}
const readState = (file: string) => (readJson(file) ?? {}) as UpdateState
/** Waits after the 1st, 2nd and later failed installs of the same version. */
const RETRY_AFTER = [5 * 60_000, 30 * 60_000, 2 * 60 * 60_000]

/** False while a failed install of this version is backing off. */
export function updateAllowed(file: string, version: string, now = Date.now()): boolean {
  const failure = readState(file).failure
  if (failure?.version !== version) return true
  return now - failure.at >= RETRY_AFTER[Math.min(failure.attempts, RETRY_AFTER.length) - 1]!
}

export function recordUpdateFailure(file: string, version: string, code: UpdateFailureCode, now = Date.now()) {
  const state = readState(file)
  const attempts = state.failure?.version === version ? state.failure.attempts + 1 : 1
  writeJsonAtomic(file, { ...state, failure: { version, code, at: now, attempts } })
}

/** What the heartbeat reports: the failure of a version newer than the running one, else null. */
export function reportedUpdateFailure(file: string, current: string): { version: string; code: UpdateFailureCode; at: string } | null {
  const failure = readState(file).failure
  return failure && newerStableVersion(failure.version, current) ? { version: failure.version, code: failure.code, at: new Date(failure.at).toISOString() } : null
}

export async function checkLatestVersion(file: string, current: string, runtime: AutoUpdateRuntime, now = Date.now(), urgent = false): Promise<string | undefined> {
  const state = readState(file)
  if (typeof state.lastAttemptAt === 'number' && now - state.lastAttemptAt < (urgent ? URGENT_CHECK_INTERVAL : CHECK_INTERVAL)) return
  // Persist before network I/O: a failed registry request must not retry after restart.
  writeJsonAtomic(file, { ...state, lastAttemptAt: now })
  const latest = await runtime.latest()
  return newerStableVersion(latest, current) ? latest : undefined
}
