import { DEVICE_SESSION_HEADER, DEVICE_SESSION_VERSION, MIN_DAEMON_VERSION, SOURCE_DAEMON_VERSION, type DaemonVersions } from '@mikka/protocol/device'
import { UPDATE_REQUIRED_STATUS, meetsMinimumVersion } from '@mikka/protocol/version'
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

/**
 * What a report, a commands read or a refused claim tells the daemon. The
 * registry is read at most every five minutes per server instance and never
 * delays a request by more than its timeout. Nothing polls it: a daemon learns
 * of a new release on its next report or commands read, which a work signal
 * or its next session triggers.
 */
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

/** Device API admission uses the same floor as claims. Source workers retain
 * the existing source-version contract; an absent/malformed released version
 * cannot bypass admission by signing in again. */
export function daemonRequestTooOld(version: string | null, cloud = false): boolean {
  if (cloud || version === SOURCE_DAEMON_VERSION) return false
  return !meetsMinimumVersion(version, MIN_DAEMON_VERSION)
}

/**
 * Whether a device request comes from a daemon that holds a device session
 * (decision 2026-11-17-2215): it sends DEVICE_SESSION_HEADER at or above
 * DEVICE_SESSION_VERSION. Any other request gets 426 on every device route,
 * with no grace for an existing run or an update channel: the person updates
 * the daemon first.
 */
export function deviceSessionSupported(request: Request): boolean {
  const value = request.headers.get(DEVICE_SESSION_HEADER)?.trim()
  return value !== undefined && /^[0-9]{1,6}$/.test(value) && Number(value) >= DEVICE_SESSION_VERSION
}

/**
 * Public upgrade metadata only. It names the `latest` release when this server
 * instance already knows it (from a report or commands answer), so a refused
 * daemon can install it without another request. It never calls out: a
 * refusal can answer a revoked or unknown credential, and a daemon that gets
 * no `latest` asks npm itself.
 */
export function daemonUpgradeResponse(now = Date.now()): Response {
  const latest = cached && now - cached.at < CACHE_MS ? cached.latest : undefined
  return Response.json({ error: 'update_required', code: 'daemonUpgradeRequired', minVersion: MIN_DAEMON_VERSION,
    daemonVersions: { min: MIN_DAEMON_VERSION, ...(latest ? { latest } : {}) }, message: 'Update the Mikka daemon and sign in again.' },
  { status: UPDATE_REQUIRED_STATUS, headers: { 'Cache-Control': 'private, no-store' } })
}

export function resetDaemonVersionCacheForTest() { cached = null; pending = null }
