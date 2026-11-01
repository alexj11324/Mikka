import { lookup } from 'node:dns/promises'
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici'
import { abortable, isPublicWebAddress, type ResolveHost } from '@/lib/search/url-policy'
import { webUrlSchema } from '@/lib/search/url-schema'

/** Pin the checked address on the wire, including the CONNECT destination when
 * a runtime proxy is present. Host and TLS SNI still identify the original site.
 * Redirects and SSE endpoint messages cannot forward auth to another origin. */
export function publicMcpFetch(origin: string, signal: AbortSignal, options: {
  resolve?: ResolveHost; send?: typeof undiciFetch; proxy?: string;
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
    const hostname = url.hostname
    const target = new URL(url)
    target.hostname = address.includes(':') ? `[${address}]` : address
    const proxy = options.proxy ?? process.env.https_proxy ?? process.env.HTTPS_PROXY ?? process.env.http_proxy ?? process.env.HTTP_PROXY
    const key = `${hostname}:${address}`
    let dispatcher = dispatchers.get(key)
    if (!dispatcher) {
      dispatcher = proxy ? new ProxyAgent({ uri: proxy, requestTls: { servername: hostname } }) : new Agent({ connect: { servername: hostname } })
      dispatchers.set(key, dispatcher)
    }
    const headers = new Headers(init?.headers)
    headers.set('host', hostname)
    const response = await (options.send ?? undiciFetch)(target, { ...init, headers, dispatcher, signal: combined, redirect: 'error', credentials: 'omit' } as Parameters<typeof undiciFetch>[1])
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
