import { z } from 'zod'
import { SearchProviderError, type SearchProvider } from './types'
import { abortable, assertPublicWebUrl, webUrlSchema, type ResolveHost } from './url-policy'

const ENDPOINT = 'https://api.firecrawl.dev/v2/'
export const FIRECRAWL_TIMEOUT_MS = 8000
const MAX_RESPONSE_BYTES = 512_000
const searchBody = z.object({ success: z.literal(true), data: z.object({ web: z.array(z.object({
  url: z.string(), title: z.string().optional(), description: z.string().optional(),
})).max(100) }) })
const scrapeBody = z.object({ success: z.literal(true), data: z.object({
  markdown: z.string().min(1), metadata: z.object({
    statusCode: z.number().int().min(200).max(299), sourceURL: z.string(), url: z.string().optional(), error: z.string().optional(),
  }),
}) })

async function readJson(response: Response, signal: AbortSignal) {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Missing body')
  let size = 0
  let body = ''
  const decoder = new TextDecoder()
  try {
    while (true) {
      const { done, value } = await abortable(() => reader.read(), signal)
      if (done) return JSON.parse(body + decoder.decode()) as unknown
      size += value.byteLength
      if (size > MAX_RESPONSE_BYTES) throw new Error('Response too large')
      body += decoder.decode(value, { stream: true })
    }
  } finally {
    // A broken transport must not keep cleanup (or the caller) hanging.
    void reader.cancel().catch(() => {})
  }
}

/** Hosted Firecrawl only. Never forward Mikka cookies, headers or browser profiles. */
export function createFirecrawlProvider(fetchImpl: typeof fetch = fetch, options: { resolve?: ResolveHost; timeoutMs?: number } = {}): SearchProvider {
  async function request<T>(operation: 'search' | 'scrape', signal: AbortSignal | undefined, work: (signal: AbortSignal, post: (body: unknown) => Promise<unknown>) => Promise<T>): Promise<T> {
    signal?.throwIfAborted()
    const timeout = AbortSignal.timeout(options.timeoutMs ?? FIRECRAWL_TIMEOUT_MS)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    try {
      return await abortable(() => work(combined, async body => {
        combined.throwIfAborted()
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        const key = process.env.FIRECRAWL_API_KEY
        if (key) headers.Authorization = `Bearer ${key}`
        const response = await abortable(() => fetchImpl(ENDPOINT + operation, {
          method: 'POST', headers, body: JSON.stringify(body), signal: combined,
          redirect: 'error', credentials: 'omit', cache: 'no-store',
        }), combined)
        if (!response.ok) {
          void response.body?.cancel().catch(() => {})
          const outcome = response.status === 429 ? 'rate_limited' : response.status >= 500 ? 'upstream_error' : 'error'
          throw new SearchProviderError(outcome, 'Firecrawl request failed')
        }
        return readJson(response, combined)
      }), combined)
    } catch (error) {
      signal?.throwIfAborted()
      if (timeout.aborted) throw new SearchProviderError('timeout', 'Firecrawl timed out')
      if (error instanceof SearchProviderError) throw error
      throw new SearchProviderError('error', 'Invalid Firecrawl response')
    }
  }
  return {
    name: 'firecrawl',
    search(query, { limit = 5, signal } = {}) {
      return request('search', signal, async (_signal, post) => {
        const safeQuery = z.string().trim().min(1).max(500).parse(query)
        const safeLimit = z.number().int().min(1).max(10).parse(limit)
        // Search excerpts only: no implicit scraping of unvalidated search targets.
        const body = searchBody.parse(await post({ query: safeQuery, limit: safeLimit, sources: ['web'] }))
        return body.data.web.filter(item => webUrlSchema.safeParse(item.url).success).slice(0, safeLimit)
          .map(item => ({ url: item.url, title: (item.title ?? item.url).slice(0, 300), snippet: (item.description ?? '').slice(0, 7000) }))
      })
    },
    scrape(url, { signal } = {}) {
      return request('scrape', signal, async (combined, post) => {
        await assertPublicWebUrl(url, combined, options.resolve)
        const body = scrapeBody.parse(await post({ url, formats: ['markdown'], onlyMainContent: true,
          timeout: options.timeoutMs ?? FIRECRAWL_TIMEOUT_MS, maxAge: 0, storeInCache: false, skipTlsVerification: false,
        }))
        if (body.data.metadata.error) throw new Error('Page error')
        // sourceURL is the submitted URL; metadata.url, when present, is the final URL.
        // Fail closed on changed targets, including public redirects. Firecrawl owns remote egress enforcement.
        for (const target of [body.data.metadata.sourceURL, body.data.metadata.url].filter((value): value is string => value !== undefined)) {
          if (new URL(target).href !== new URL(url).href) throw new Error('Changed scrape target')
          await assertPublicWebUrl(target, combined, options.resolve)
        }
        return { url, markdown: body.data.markdown.slice(0, 24000) }
      })
    },
  }
}
