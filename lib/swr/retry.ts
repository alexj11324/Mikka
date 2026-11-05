import type { SWRConfiguration } from 'swr'

export const MAX_READ_RETRIES = 5
export const MAX_READ_RETRY_MS = 30_000

/** HTTP status and explicit server error contracts survive wrappers through `cause`. */
export function isAutoRetryable(error: unknown): boolean {
  const visited = new Set<unknown>()
  let current = error
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current)
    const failure = current as { status?: number; statusCode?: number; retryable?: boolean; code?: string; kind?: string; cause?: unknown }
    const status = failure.status ?? failure.statusCode
    if (failure.retryable === false || status === 401 || status === 403 || status === 429) return false
    if (['authRequired', 'workspaceAccessDenied', 'workspaceMembershipSuspended', 'issueNotFound', 'botNotFound'].includes(failure.code ?? '')) return false
    if (failure.kind === 'owner' || failure.kind === 'workspace') return false
    current = failure.cause
  }
  return true
}

/** Equal jitter avoids synchronized reconnects while keeping every wait below 30 s. */
export function readRetryDelay(retryCount: number, random: () => number = Math.random): number {
  const ceiling = Math.min(MAX_READ_RETRY_MS, 1_000 * 2 ** Math.max(0, Math.min(30, retryCount - 1)))
  return Math.round(ceiling * (0.5 + Math.max(0, Math.min(1, random())) * 0.5))
}

export const retryRead: NonNullable<SWRConfiguration['onErrorRetry']> = (error, key, config, revalidate, options) => {
  if (!isAutoRetryable(error) || options.retryCount > Math.min(MAX_READ_RETRIES, config.errorRetryCount ?? MAX_READ_RETRIES)) return
  setTimeout(() => {
    const cache = (config as { cache?: { get(key: string): { error?: unknown } | undefined } }).cache
    // A success, a newer attempt or a terminal failure supersedes this timer.
    if (cache && cache.get(key)?.error !== error) return
    if (!config.isPaused?.()) revalidate(options)
  }, readRetryDelay(options.retryCount))
}

/** Safe, typed transport failure: never includes server bodies or URLs. */
export class ReadResponseError extends Error {
  constructor(readonly status: number, options?: ErrorOptions) {
    super('Read request failed', options)
    this.name = 'ReadResponseError'
  }
}
