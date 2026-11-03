import { lookup } from 'node:dns/promises'
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici'
import { abortable, isPublicWebAddress, type ResolveHost } from '@/lib/search/url-policy'
import { webUrlSchema } from '@/lib/search/url-schema'

/** Pin the checked address on the wire: the request keeps its URL, so Host and
 * TLS SNI name the original site, and the connection's DNS lookup answers only
 * the address checked here. (fetch drops a caller-set Host header, so a URL
 * rewritten to the IP reached the server as "Host: <IP>" and a CDN answered
 * with its own page instead of the MCP server's response.) With a runtime
 * proxy, the proxy resolves the name itself; the address was still checked.
 * Redirects and SSE endpoint messages cannot forward auth to another origin. */
export function publicMcpFetch(origin: string, signal: AbortSignal, options: {
  resolve?: ResolveHost; send?: typeof undiciFetch; proxy?: string; env?: Record<string, string | undefined>;
} = {}) {
  const dispatchers = new Map<string, Dispatcher>()
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    webUrlSchema.parse(url.href)
    if (url.origin !== origin) throw new Error('mcpOriginChanged')
    const combined = init?.signal ? AbortSignal.any([signal, init.signal]) : signal
    const addresses = await abortable(() => (options.resolve ?? (hostname => lookup(hostname, { all: true })))(url.hostname), combined)
    if (!addresses.length || addresses.some(({ address }) => !isPublicWebAddress(address))) throw new Error('mcpPrivateAddress')
    const address = addresses.find(row => !row.address.includes(':'))?.address ?? addresses[0].address
    const proxy = options.proxy ?? process.env.https_proxy ?? process.env.HTTPS_PROXY ?? process.env.http_proxy ?? process.env.HTTP_PROXY
    // A proxy resolves the name itself, so the checked address would not be the one dialled.
    // Development may use one; a Vercel deployment never sends through one.
    const env = options.env ?? process.env
    if (proxy && (env.VERCEL || env.VERCEL_ENV)) throw new Error('mcpProxyNotAllowed')
    const key = `${url.hostname}:${address}`
    let dispatcher = dispatchers.get(key)
    if (!dispatcher) {
      dispatcher = proxy ? new ProxyAgent({ uri: proxy }) : new Agent({ connect: { lookup: pinnedLookup(address) } })
      dispatchers.set(key, dispatcher)
    }
    const response = await (options.send ?? undiciFetch)(url, { ...init, dispatcher, signal: combined, redirect: 'error', credentials: 'omit' } as Parameters<typeof undiciFetch>[1])
    let bytes = 0
    const body = (response.body as unknown as ReadableStream<Uint8Array> | null)?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
      bytes += chunk.byteLength
      if (bytes > 1_000_000) throw new Error('mcpResponseTooLarge')
      controller.enqueue(chunk)
    } }))
    return new Response(body as ReadableStream<Uint8Array> | undefined, { status: response.status, statusText: response.statusText, headers: new Headers([...response.headers]) })
  }
  return { fetch: fetcher, close: async () => { await Promise.allSettled([...dispatchers.values()].map(dispatcher => dispatcher.destroy())) } }
}

type LookupAnswer = { address: string; family: number }
/** A DNS lookup for net.connect that only ever answers `address`. */
export function pinnedLookup(address: string) {
  const answer: LookupAnswer = { address, family: address.includes(':') ? 6 : 4 }
  return (_hostname: string, options: { all?: boolean } | number | undefined, callback: (error: Error | null, address: string | LookupAnswer[], family?: number) => void) => {
    if (typeof options === 'object' && options?.all) callback(null, [answer])
    else callback(null, answer.address, answer.family)
  }
}
