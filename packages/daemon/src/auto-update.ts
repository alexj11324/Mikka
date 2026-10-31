import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { readJson, writeJsonAtomic } from './fs-util'

const exec = promisify(execFile)
const PACKAGE = '@aspectlylabs/mikka'
const DAY = 24 * 60 * 60 * 1000

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

export async function checkLatestVersion(file: string, current: string, runtime: AutoUpdateRuntime, now = Date.now()): Promise<string | undefined> {
  const state = readJson(file) as { lastAttemptAt?: number } | undefined
  if (typeof state?.lastAttemptAt === 'number' && now - state.lastAttemptAt < DAY) return
  // Persist before network I/O: a failed registry request must not retry after restart.
  writeJsonAtomic(file, { lastAttemptAt: now })
  const latest = await runtime.latest()
  return newerStableVersion(latest, current) ? latest : undefined
}
