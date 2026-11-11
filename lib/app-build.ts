import { meetsMinimumVersion } from '@mikka/protocol/version'
import { withBasePath } from '@/lib/base-path'

// Which deployment this page was built by. A page left open across a deploy
// (a desktop window, a long-lived tab) keeps calling the old deployment's
// server actions; once the new one has removed them they fail. The page
// compares its build with the server's and offers a reload instead.

/** Inlined at build time (apps/frontend/vite.config.mjs); empty without one. */
export const APP_BUILD = process.env.NEXT_PUBLIC_MIKKA_BUILD ?? ''

let refreshRequired = false
const refreshAbort = new AbortController()
export const pageRefreshSignal = () => refreshAbort.signal
export const pageNeedsRefresh = () => refreshRequired
export function markPageNeedsRefresh() { refreshRequired = true; refreshAbort.abort() }

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
  markPageNeedsRefresh()
  window.dispatchEvent(new Event(STALE_BUILD_EVENT))
  return false
}

/** Next answers a server action it does not have with this response header. */
export const ACTION_NOT_FOUND_HEADER = 'x-nextjs-action-not-found'

/** Raised when an action targets an obsolete build; VersionGuard offers an explicit 刷新. */
export const STALE_BUILD_EVENT = 'mikka:stale-build'

/** Subscribe first, then catch a marker raised before the update view mounted. */
export function subscribePageRefresh(target: Pick<Window, 'addEventListener' | 'removeEventListener'>, offer: () => void) {
  target.addEventListener(STALE_BUILD_EVENT, offer)
  if (pageNeedsRefresh()) offer()
  return () => { target.removeEventListener(STALE_BUILD_EVENT, offer) }
}

/**
 * Watches window.fetch, which every server action goes through, for a removed
 * action, however its caller handles the error. Installed from
 * instrumentation-client.ts so it is in place before any component calls one.
 */
export function watchRemovedActions(target: Window) {
  const original = target.fetch.bind(target)
  target.fetch = async (...args: Parameters<typeof fetch>) => {
    const input = args[0]
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, target.location.href)
    const business = url.origin === target.location.origin && url.pathname !== withBasePath('/api/version')
    if (business && pageNeedsRefresh()) throw new Error('App refresh required')
    const callerSignal = args[1]?.signal ?? (input instanceof Request ? input.signal : undefined)
    const init = business ? { ...args[1], signal: callerSignal ? AbortSignal.any([callerSignal, pageRefreshSignal()]) : pageRefreshSignal() } : args[1]
    const response = await original(input, init)
    if (business && response.headers.has(ACTION_NOT_FOUND_HEADER)) {
      // Retire the old request stream, not the page. A background response must
      // never discard unsaved input by reloading or replaying the user's action.
      markPageNeedsRefresh()
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

