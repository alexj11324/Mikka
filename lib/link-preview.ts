import 'server-only'
import { lookup } from 'node:dns/promises'
import { isIP, type LookupFunction } from 'node:net'
import { Agent, type Dispatcher } from 'undici'
import { isPrivateAddress, parsePreview, type LinkPreview } from '@/lib/link-preview-parse'

export type { LinkPreview }

// Title, summary, image and icon for a web page a Coordinator reply links to,
// read from the page's Open Graph tags. Only public http(s) addresses are
// fetched, so a link cannot make the server reach into a private network.

const TIMEOUT_MS = 4000
const MAX_BYTES = 512 * 1024
const MAX_REDIRECTS = 3
const CACHE_MS = 6 * 60 * 60_000
const CACHE_SIZE = 500

export type LookupAnswer = { address: string; family: number }

/** Node's fetch dials through a `dispatcher` when one is given, but the DOM
 * RequestInit this project compiles against does not declare that field. */
export type DispatchedFetchInit = RequestInit & { dispatcher?: Dispatcher }

/** The connection's own DNS answer, refused when it is private. publicUrl
 * checks a name before the fetch and this checks the address the socket
 * actually dials, so a name that answers a public address to that check and a
 * private one to the connection (DNS rebinding) is refused instead of reached. */
export function guardedLookup(resolveAnswers: (hostname: string) => Promise<LookupAnswer[]> = async hostname => lookup(hostname, { all: true })): LookupFunction {
  return (hostname, options, callback) => {
    resolveAnswers(hostname).then(answers => {
      if (!answers.length || answers.some(answer => isPrivateAddress(answer.address))) {
        callback(Object.assign(new Error(`linkPreviewRefusedPrivateAddress: ${hostname}`), { code: 'EPRIVATEADDRESS' }), '', 0)
        return
      }
      if (options.all) callback(null, answers)
      else callback(null, answers[0].address, answers[0].family)
    }, error => callback(error, '', 0))
  }
}

/** Every preview dials through this agent, so a new connection opens only to an
 * address guardedLookup answered and keep-alive reuses only connections that
 * already passed. The URL still names the site, so Host and TLS SNI are its own. */
export const previewDispatcher = new Agent({ connect: { lookup: guardedLookup() } })

/** The URL if it is a public http(s) address on the default port, else null.
 * Every redirect hop comes back through here, so a hop cannot switch protocol
 * or land on an address this refuses; the connection checks the dialled address
 * again (guardedLookup). */
async function publicUrl(raw: string): Promise<URL | null> {
  let url: URL
  try { url = new URL(raw) } catch { return null }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.port || url.username || url.password) return null
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const addresses = isIP(host) ? [host] : await lookup(host, { all: true }).then(rows => rows.map(row => row.address), () => [])
  if (!addresses.length || addresses.some(isPrivateAddress)) return null
  return url
}

async function readHtml(response: Response): Promise<string> {
  if (!response.body || !/text\/html|application\/xhtml/.test(response.headers.get('content-type') ?? '')) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (size < MAX_BYTES) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.byteLength
  }
  void reader.cancel().catch(() => {})
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, MAX_BYTES))
}

async function fetchPreview(raw: string): Promise<LinkPreview | null> {
  let url = await publicUrl(raw)
  if (!url) return null
  const fallback: LinkPreview = { url: url.href, host: url.hostname.replace(/^www\./, ''), siteName: null, title: null, description: null, image: null, icon: new URL('/favicon.ico', url).href }
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const init: DispatchedFetchInit = { dispatcher: previewDispatcher, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'MikkaLinkPreview/1.0 (+https://aspectlylabs.com/mikka)' } }
      const response = await fetch(url, init)
      const location = response.headers.get('location')
      if (response.status >= 300 && response.status < 400 && location) {
        void response.body?.cancel().catch(() => {})
        const next = await publicUrl(new URL(location, url).href)
        if (!next) return fallback
        url = next
        continue
      }
      if (!response.ok) { void response.body?.cancel().catch(() => {}); return fallback }
      return { ...fallback, ...parsePreview(await readHtml(response), url.href) }
    }
  } catch { /* unreachable or slow: show the link without a preview */ }
  return fallback
}

const cache = new Map<string, { at: number; preview: Promise<LinkPreview | null> }>()

/** The preview for `url`, or null when it is not a public web address. Cached for a few hours. */
export function linkPreview(url: string): Promise<LinkPreview | null> {
  const hit = cache.get(url)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.preview
  if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value!)
  const preview = fetchPreview(url)
  cache.set(url, { at: Date.now(), preview })
  return preview
}
