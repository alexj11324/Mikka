import { createFirecrawlProvider } from './firecrawl'
import { SearchProviderError, type SearchContext, type SearchOutcome, type SearchProvider, type SearchResponse, type SearchResult } from './types'

export * from './types'

const CACHE_TTL_MS = 60 * 60 * 1000
const CACHE_MAX = 200
const USER_LIMIT_PER_MINUTE = 10

/** Permission hook; allows everything until the tier design lands. */
export type AuthorizeSearch = (ctx: SearchContext) => boolean | Promise<boolean>
export const allowAllSearch: AuthorizeSearch = () => true

export function normalizeQuery(query: string) {
  return query.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** One structured line per search so outcomes can be counted in Vercel logs. */
function logSearch(fields: { provider: string; outcome: SearchOutcome | 'cache_hit' | 'throttled' | 'denied'; ms: number; caller: string }) {
  console.info(JSON.stringify({ event: 'web_search', ...fields }))
}

export function createSearchService({ provider = createFirecrawlProvider(), authorize = allowAllSearch, now = Date.now }: {
  provider?: SearchProvider; authorize?: AuthorizeSearch; now?: () => number
} = {}) {
  // Per-instance cache and throttle: cheap and dependency-free. Swap for a
  // shared cache if hit rates across instances turn out to matter.
  const cache = new Map<string, { at: number; results: SearchResult[] }>()
  const calls = new Map<string, number[]>()

  return async function search(query: string, ctx: SearchContext, options: { limit?: number; signal?: AbortSignal } = {}): Promise<SearchResponse> {
    const started = now()
    const base = { provider: provider.name, caller: ctx.caller }
    if (!(await authorize(ctx))) {
      logSearch({ ...base, outcome: 'denied', ms: 0 })
      return { ok: false, error: 'searchUnavailable', outcome: 'error' }
    }
    const key = `${options.limit ?? 5}:${normalizeQuery(query)}`
    const hit = cache.get(key)
    if (hit && started - hit.at < CACHE_TTL_MS) {
      logSearch({ ...base, outcome: 'cache_hit', ms: 0 })
      return { ok: true, results: hit.results, cached: true }
    }
    const recent = (calls.get(ctx.userId) ?? []).filter(at => started - at < 60_000)
    if (recent.length >= USER_LIMIT_PER_MINUTE) {
      logSearch({ ...base, outcome: 'throttled', ms: 0 })
      return { ok: false, error: 'searchUnavailable', outcome: 'rate_limited' }
    }
    calls.set(ctx.userId, [...recent, started])
    try {
      const results = await provider.search(query, options)
      cache.delete(key)
      cache.set(key, { at: started, results })
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!)
      logSearch({ ...base, outcome: 'ok', ms: now() - started })
      return { ok: true, results, cached: false }
    } catch (error) {
      const outcome = error instanceof SearchProviderError ? error.outcome : 'error'
      logSearch({ ...base, outcome, ms: now() - started })
      return { ok: false, error: 'searchUnavailable', outcome }
    }
  }
}

export const webSearch = createSearchService()
