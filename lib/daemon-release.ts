import { MIN_DAEMON_VERSION, SOURCE_DAEMON_VERSION, type DaemonVersions } from '@mikka/protocol/device'
import { meetsMinimumVersion } from '@mikka/protocol/version'
import { daemonTestMode } from '@mikka/protocol/repository'

const REGISTRY_LATEST = 'https://registry.npmjs.org/@aspectlylabs%2fmikka/latest'
const CACHE_MS = 5 * 60_000
const STABLE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/

let cached: { at: number; latest: string | undefined } | null = null
let pending: Promise<string | undefined> | null = null

/** The npm `latest` daemon release, or undefined when the registry answer is missing or not a plain version at or above the minimum. */
export async function readLatestDaemonVersion(fetcher: typeof fetch = fetch): Promise<string | undefined> {
  try {
    const response = await fetcher(REGISTRY_LATEST, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(3_000) })
    if (!response.ok) return undefined
    const version = ((await response.json()) as { version?: unknown } | null)?.version
    return typeof version === 'string' && STABLE.test(version) && meetsMinimumVersion(version, MIN_DAEMON_VERSION) ? version : undefined
  } catch { return undefined }
}

/** What a heartbeat tells the daemon. The registry is read at most every five minutes per server instance and never delays a heartbeat by more than its timeout. */
// Test servers never ask the public registry; their daemons run from source.
const defaultRead = async () => daemonTestMode(process.env) ? undefined : readLatestDaemonVersion()

export async function daemonVersions(now = Date.now(), read: () => Promise<string | undefined> = defaultRead): Promise<DaemonVersions> {
  if (!cached || now - cached.at >= CACHE_MS) {
    pending ??= read().finally(() => { pending = null })
    const latest = await pending
    cached = { at: now, latest }
  }
  return { min: MIN_DAEMON_VERSION, ...(cached.latest ? { latest: cached.latest } : {}) }
}

/**
 * A released local daemon below the minimum gets no runs. Cloud workers and
 * daemons run from source report the source version and run current code.
 */
export function daemonTooOld(device: { kind: string; daemonVersion: string | null }): boolean {
  const version = device.daemonVersion
  if (device.kind !== 'local' || !version || version === SOURCE_DAEMON_VERSION) return false
  return !meetsMinimumVersion(version, MIN_DAEMON_VERSION)
}

export function resetDaemonVersionCacheForTest() { cached = null; pending = null }
