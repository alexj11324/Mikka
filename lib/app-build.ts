import { meetsMinimumVersion } from '@mikka/protocol/version'
import { withBasePath } from '@/lib/base-path'

// Which deployment this page was built by. A page left open across a deploy
// (a desktop window, a long-lived tab) keeps calling the old deployment's
// server actions; once the new one has removed them they fail. The page
// compares its build with the server's and offers a reload instead.

/** Inlined at build time (next.config.mjs); empty in a build without one. */
export const APP_BUILD = process.env.NEXT_PUBLIC_MIKKA_BUILD ?? ''

/** True only when both builds are known and differ. */
export function isStaleBuild(page: string, server: unknown): boolean {
  return Boolean(page) && typeof server === 'string' && server !== '' && server !== page
}

type AppVersion = { build?: unknown; minDesktopVersion?: unknown }

/** A stable public GET, shared by navigation and explicit actions. Never a
 * Server Action: its deployment header could pin this check to the old build. */
export function createAppVersionReader({ fetch: read = (input, init) => globalThis.fetch(input, init), now = Date.now }: {
  fetch?: (input: string, init: RequestInit) => Promise<Response>
  now?: () => number
} = {}) {
  let checkedAt = -Infinity
  let last: AppVersion | null = null
  let pending: Promise<AppVersion | null> | null = null
  return () => {
    if (pending) return pending
    if (now() - checkedAt < 60_000) return Promise.resolve(last)
    checkedAt = now()
    pending = Promise.resolve()
      .then(() => read(withBasePath('/api/version'), { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(5_000) }))
      .then(async response => {
        const body: unknown = response.ok ? await response.json() : null
        last = body && typeof body === 'object' ? body as AppVersion : null
        return last
      })
      .catch(() => { last = null; return null })
      .finally(() => { pending = null })
    return pending
  }
}

export const readAppVersion = createAppVersionReader()

/** Leave inputs untouched when an explicit action would target an old build.
 * Unknown versions keep the existing request/error path; they are not stale. */
export async function checkPageBuildBeforeAction(): Promise<boolean> {
  if (!APP_BUILD || typeof window === 'undefined') return true
  const version = await readAppVersion()
  if (!isStaleBuild(APP_BUILD, version?.build)) return true
  window.dispatchEvent(new Event(STALE_BUILD_EVENT))
  return false
}

const RELOADED_AT = 'mikka-stale-build-reload'
const RELOAD_GAP_MS = 60_000

/**
 * Reload once for a server action the server no longer has. A second miss
 * within a minute does not reload again (the new page has the same gap), so
 * the caller falls back to asking.
 */
export function reloadOnce(storage: Pick<Storage, 'getItem' | 'setItem'> | null, now: number, reload: () => void): boolean {
  if (!storage) return false
  try {
    const last = Number(storage.getItem(RELOADED_AT) ?? 0)
    if (now - last < RELOAD_GAP_MS) return false
    storage.setItem(RELOADED_AT, String(now))
  } catch {
    return false
  }
  reload()
  return true
}

/** Next answers a server action it does not have with this response header. */
export const ACTION_NOT_FOUND_HEADER = 'x-nextjs-action-not-found'

/** Raised when a removed action could not reload the page; VersionGuard offers 刷新. */
export const STALE_BUILD_EVENT = 'mikka:stale-build'

/**
 * Watches window.fetch, which every server action goes through, for a removed
 * action, however its caller handles the error. Installed from
 * instrumentation-client.ts so it is in place before any component calls one.
 */
export function watchRemovedActions(target: Window) {
  const original = target.fetch.bind(target)
  const session = () => { try { return target.sessionStorage } catch { return null } }
  target.fetch = async (...args: Parameters<typeof fetch>) => {
    const response = await original(...args)
    if (response.headers.has(ACTION_NOT_FOUND_HEADER) && !reloadOnce(session(), Date.now(), () => { target.location.reload() })) {
      target.dispatchEvent(new Event(STALE_BUILD_EVENT))
    }
    return response
  }
}

/**
 * The oldest desktop app the server still serves (ADR 0011's MIN_CLIENT_VERSION),
 * or null when unset or not a valid version.
 */
export function minDesktopVersion(value: string | undefined): string | null {
  const version = value?.trim()
  if (!version) return null
  try {
    meetsMinimumVersion('0.0.0', version)
    return version
  } catch {
    return null
  }
}

/** True when this desktop build is older than the server's minimum. */
export function desktopBelowMinimum(appVersion: string | undefined, minimum: unknown): boolean {
  if (typeof minimum !== 'string' || !appVersion || minDesktopVersion(minimum) === null) return false
  return !meetsMinimumVersion(appVersion, minimum)
}

