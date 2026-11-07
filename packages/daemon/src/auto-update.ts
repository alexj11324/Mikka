import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { readJson, writeJsonAtomic } from './fs-util'

const exec = promisify(execFile)
const PACKAGE = '@aspectlylabs/mikka'

export function newerStableVersion(candidate: unknown, current: string): candidate is string {
  const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
  if (typeof candidate !== 'string' || !stable.test(candidate) || !stable.test(current)) return false
  const a = candidate.split('.').map(BigInt), b = current.split('.').map(BigInt)
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!
  return false
}

/** A desktop-managed install must keep updating its own prefix and private cache. */
export function serviceNpmEnvironment(entry: string, home: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const prefix = join(home, '.mikka/npm')
  return resolve(entry) === join(prefix, 'lib/node_modules/@aspectlylabs/mikka/mikka.js')
    ? { ...env, npm_config_prefix: prefix, npm_config_cache: join(home, '.mikka/npm-cache') }
    : env
}

/** Run npm with the service's Node and configuration, even when PATH selects another Node. */
export async function runServiceNpm(args: string[]): Promise<string> {
  const npm = realpathSync(join(dirname(process.execPath), 'npm'))
  const { stdout } = await exec(process.execPath, [npm, ...args], {
    cwd: homedir(), timeout: 300_000, maxBuffer: 1024 * 1024,
    env: { ...serviceNpmEnvironment(realpathSync(process.argv[1]!), homedir(), process.env), PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` },
  })
  return stdout.trim()
}

/** The server names the release (heartbeat, commands poll, refused claim); the daemon never asks npm which one is latest. */
export interface AutoUpdateRuntime {
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
      install: async version => { await runServiceNpm(['install', '--global', '--engine-strict', `${PACKAGE}@${version}`]) },
    }
  } catch { return undefined }
}

type UpdateFailureCode = 'install_failed' | 'restart_failed'
interface UpdateState {
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
