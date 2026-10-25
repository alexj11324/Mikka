import { SearchProviderError, type SearchOptions, type SearchProvider, type SearchResult } from './types'

const ENDPOINT = 'https://api.firecrawl.dev/v2/search'
export const FIRECRAWL_TIMEOUT_MS = 8000

type FirecrawlBody = { success?: boolean; data?: { web?: { url?: string; title?: string; description?: string }[] } }

/**
 * Firecrawl search. Keyless by default (free, capped per IP per day, so 429 is
 * expected on shared Vercel egress); uses FIRECRAWL_API_KEY when it is set.
 */
export function createFirecrawlProvider(fetchImpl: typeof fetch = fetch): SearchProvider {
  return {
    name: 'firecrawl',
    async search(query: string, { limit = 5, signal }: SearchOptions = {}): Promise<SearchResult[]> {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      const key = process.env.FIRECRAWL_API_KEY
      if (key) headers.Authorization = `Bearer ${key}`
      const timeout = AbortSignal.timeout(FIRECRAWL_TIMEOUT_MS)
      let response: Response
      try {
        response = await fetchImpl(ENDPOINT, {
          method: 'POST', headers,
          body: JSON.stringify({ query, limit: Math.min(Math.max(limit, 1), 10) }),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        })
      } catch (error) {
        if (timeout.aborted) throw new SearchProviderError('timeout', 'firecrawl timed out')
        throw new SearchProviderError('error', error instanceof Error ? error.message : String(error))
      }
      if (response.status === 429) throw new SearchProviderError('rate_limited', 'firecrawl 429')
      if (response.status >= 500) throw new SearchProviderError('upstream_error', `firecrawl ${response.status}`)
      if (!response.ok) throw new SearchProviderError('error', `firecrawl ${response.status}`)
      const body = await response.json() as FirecrawlBody
      return (body.data?.web ?? []).flatMap(item => {
        if (!item.url || !/^https?:\/\//.test(item.url)) return []
        return [{ url: item.url, title: (item.title ?? item.url).slice(0, 300), snippet: (item.description ?? '').slice(0, 500) }]
      })
    },
  }
}
