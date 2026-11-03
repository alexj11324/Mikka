/** Waits 2s, 4s, 8s, 16s, then 30s between reconnects, and never gives up. */
export function offlineRetryDelay(attempt: number): number {
  return Math.min(30_000, 2_000 * 2 ** Math.max(0, Math.min(attempt, 4)))
}

/**
 * Tells a real app load from the error page Chromium shows for a failed one.
 * After did-fail-load, Chromium still fires did-finish-load for the failed
 * URL's error page, and getURL() is the app URL. Treating that as success
 * cancelled the reconnect timer, so the offline page never retried.
 */
export class AppLoadState {
  private failed = false

  constructor(private readonly appOrigin: string) {}

  /** A new main-frame navigation to the app clears the previous failure. */
  started(url: string): void {
    if (url.startsWith(this.appOrigin)) this.failed = false
  }

  failedLoad(): void {
    this.failed = true
  }

  /** True only when the app itself finished loading. */
  finished(url: string): boolean {
    return url.startsWith(this.appOrigin) && !this.failed
  }
}

// Chromium net errors that mean this computer has no network, not that Mikka is down
// (net/base/net_error_list.h): INTERNET_DISCONNECTED, NETWORK_CHANGED, NAME_NOT_RESOLVED and
// ADDRESS_UNREACHABLE only count when the system also reports no network.
const NO_NETWORK = new Set([-106, -21])
const MAYBE_NETWORK = new Set([-105, -109, -137])

/**
 * Why the app did not load (review C9): this computer is offline, or Mikka's server did not answer.
 * The page never tells someone to check their network when the server is what failed.
 */
export function offlineReason(errorCode: number, online: boolean): 'network' | 'server' {
  if (NO_NETWORK.has(errorCode)) return 'network'
  if (!online && MAYBE_NETWORK.has(errorCode)) return 'network'
  return online ? 'server' : 'network'
}
