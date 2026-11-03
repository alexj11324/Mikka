import { MIN_DAEMON_VERSION, SOURCE_DAEMON_VERSION, type DaemonVersions } from '@mikka/protocol/device'
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
 * The cached answer, without waiting: a long-poll compares it every idle check,
 * so it never touches the database or the registry itself. A stale cache starts
 * one refresh in the background; the next check sees its result.
 */
export function cachedDaemonVersions(now = Date.now(), read: () => Promise<string | undefined> = defaultRead): DaemonVersions | undefined {
  if (!cached || now - cached.at >= CACHE_MS) void daemonVersions(now, read).catch(() => undefined)
  return cached ? { min: MIN_DAEMON_VERSION, ...(cached.latest ? { latest: cached.latest } : {}) } : undefined
}

/** Whether `versions` names a release newer than `known`, the newest one the daemon already has word of. */
export function newerDaemonRelease(versions: DaemonVersions | undefined, known: string): boolean {
  const latest = versions?.latest
  return Boolean(latest && STABLE.test(known) && latest !== known && meetsMinimumVersion(latest, known))
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

/** Upgrade transport only; these cannot claim a new run. */
export function daemonUpdateControlRequest(request: Request): boolean {
  const path = new URL(request.url).pathname.replace(/^\/mikka(?=\/)/, '')
  return (request.method === 'POST' && /^\/v1\/devices\/[^/]+\/heartbeat$/.test(path))
    || (request.method === 'GET' && /^\/v1\/devices\/[^/]+\/commands$/.test(path))
}

/** Only an existing run's own transport can receive lease-scoped grace. */
export function daemonRunRequestId(request: Request): string | undefined {
  const path = new URL(request.url).pathname.replace(/^\/mikka(?=\/)/, '')
  const match = /^\/v1\/(?:devices\/[^/]+\/)?runs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/(.*))?$/i.exec(path)
  return match && match[2] !== 'claim' ? match[1] : undefined
}

/** Public upgrade metadata only; never wait for npm on a refused request. */
export function daemonUpgradeResponse(): Response {
  return Response.json({ error: 'update_required', code: 'daemonUpgradeRequired', minVersion: MIN_DAEMON_VERSION,
    daemonVersions: { min: MIN_DAEMON_VERSION }, message: 'Update the Mikka daemon and sign in again.' },
  { status: UPDATE_REQUIRED_STATUS, headers: { 'Cache-Control': 'private, no-store' } })
}

export function resetDaemonVersionCacheForTest() { cached = null; pending = null }
