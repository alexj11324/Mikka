import { createFirecrawlProvider } from './firecrawl'
import { abortable } from './url-policy'
import { SearchProviderError, type SearchContext, type SearchOutcome, type SearchProvider, type SearchResponse, type ScrapeResponse } from './types'

export * from './types'
const CACHE_TTL_MS = 60 * 60 * 1000
const CACHE_MAX = 200
const USER_LIMIT_PER_MINUTE = 10
const USER_MAX = 2000
export type AuthorizeSearch = (ctx: SearchContext) => boolean | Promise<boolean>
export const allowAllSearch: AuthorizeSearch = () => true
export function normalizeQuery(query: string) { return query.trim().replace(/\s+/g, ' ').toLowerCase() }

/** Shared search/scrape throttle; per-instance only, not a distributed quota. */
export function createWebService({ provider = createFirecrawlProvider(), authorize = allowAllSearch, now = Date.now, timeoutMs = 15000 }: {
  provider?: SearchProvider; authorize?: AuthorizeSearch; now?: () => number; timeoutMs?: number
} = {}) {
  const cache = new Map<string, { at: number; response: Extract<SearchResponse, { ok: true }> }>()
  const calls = new Map<string, number[]>()
  async function execute(operation: 'search' | 'scrape', input: string, ctx: SearchContext, options: { limit?: number; signal?: AbortSignal }) {
    const started = now()
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
    const log = (outcome: SearchOutcome | 'cache_hit' | 'throttled' | 'denied') => console.info(JSON.stringify({
      event: operation === 'search' ? 'web_search' : 'web_scrape', provider: provider.name, caller: ctx.caller, outcome, ms: now() - started,
    }))
    try {
      signal.throwIfAborted()
      if (!await abortable(async () => authorize(ctx), signal)) {
        log('denied')
        return { ok: false as const, error: 'searchUnavailable' as const, outcome: 'error' as const }
      }
      signal.throwIfAborted()
      if (!ctx.userId || (operation === 'search' && (!input.trim() || input.trim().length > 500))) throw new Error('Invalid input')
      const key = JSON.stringify([ctx.userId, ctx.workspaceId, options.limit ?? 5, input.trim().replace(/\s+/g, ' ')])
      const hit = operation === 'search' ? cache.get(key) : undefined
      if (hit && started - hit.at < CACHE_TTL_MS) {
        cache.delete(key); cache.set(key, hit)
        log('cache_hit')
        return structuredClone({ ...hit.response, cached: true })
      }
      const recent = (calls.get(ctx.userId) ?? []).filter(at => started - at < 60_000)
      if (recent.length >= USER_LIMIT_PER_MINUTE) {
        log('throttled')
        return { ok: false as const, error: 'searchUnavailable' as const, outcome: 'rate_limited' as const }
      }
      calls.delete(ctx.userId); calls.set(ctx.userId, [...recent, started])
      if (calls.size > USER_MAX) calls.delete(calls.keys().next().value!)
      if (operation === 'scrape') {
        if (!provider.scrape) throw new Error('Scrape unsupported')
        const page = await abortable(() => provider.scrape!(input, { ...options, signal }), signal)
        signal.throwIfAborted()
        log('ok')
        return { ok: true as const, page }
      }
      const results = await abortable(() => provider.search(input, { ...options, signal }), signal)
      signal.throwIfAborted()
      const response = { ok: true as const, results, cached: false }
      cache.delete(key); cache.set(key, { at: started, response: structuredClone(response) })
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!)
      log('ok')
      return response
    } catch (error) {
      options.signal?.throwIfAborted()
      const outcome = timeout.aborted ? 'timeout' : error instanceof SearchProviderError ? error.outcome : 'error'
      log(outcome)
      return { ok: false as const, error: 'searchUnavailable' as const, outcome }
    }
  }
  return {
    search: (query: string, ctx: SearchContext, options: { limit?: number; signal?: AbortSignal } = {}) => execute('search', query, ctx, options) as Promise<SearchResponse>,
    scrape: (url: string, ctx: SearchContext, options: { signal?: AbortSignal } = {}) => execute('scrape', url, ctx, options) as Promise<ScrapeResponse>,
  }
}
export function createSearchService(options: Parameters<typeof createWebService>[0] = {}) { return createWebService(options).search }
const web = createWebService()
export const webSearch = web.search
export const webScrape = web.scrape
