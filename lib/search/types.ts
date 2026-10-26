export type SearchResult = { title: string; url: string; snippet: string }

export type SearchOutcome = 'ok' | 'rate_limited' | 'upstream_error' | 'timeout' | 'error'

export type SearchResponse =
  | { ok: true; results: SearchResult[]; cached: boolean; fetchedAt?: string; cacheAgeMs?: number }
  | { ok: false; error: 'searchUnavailable'; outcome: Exclude<SearchOutcome, 'ok'> }

export type SearchOptions = { limit?: number; signal?: AbortSignal }

/** A web search backend. Firecrawl is the first; a keyed provider can replace it later. */
export interface SearchProvider {
  readonly name: string
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>
  scrape?(url: string, options?: SearchOptions): Promise<ScrapeResult>
}

export type ScrapeResult = { url: string; markdown: string }
export type ScrapeResponse =
  | { ok: true; page: ScrapeResult }
  | Extract<SearchResponse, { ok: false }>

/** Thrown by providers so the caller can classify failures for metrics. */
export class SearchProviderError extends Error {
  constructor(readonly outcome: Exclude<SearchOutcome, 'ok'>, message: string) {
    super(message)
  }
}

/** Context for the permission hook (MIK-5, tiers designed by Chief of Staff). */
export type SearchContext = { userId: string; workspaceId?: string; caller: 'coordinator' | 'bot' }
