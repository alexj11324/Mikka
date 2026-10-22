import { BlockList, isIP } from 'node:net'

// The pure half of link previews: which addresses are private, and reading
// a page's Open Graph tags. lib/link-preview.ts does the fetching.

export interface LinkPreview {
  url: string
  host: string
  siteName: string | null
  title: string | null
  description: string | null
  image: string | null
  icon: string | null
}

const PRIVATE = new BlockList()
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]] as const) PRIVATE.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) PRIVATE.addSubnet(network, prefix, 'ipv6')

/** Loopback, private, link-local and other non-public addresses. */
export function isPrivateAddress(address: string): boolean {
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1]
  if (mapped) return PRIVATE.check(mapped, 'ipv4')
  return PRIVATE.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4')
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (code[0] !== '#') return ENTITIES[code.toLowerCase()] ?? entity
    const point = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
    return Number.isFinite(point) && point <= 0x10ffff ? String.fromCodePoint(point) : entity
  }).replace(/\s+/g, ' ').trim()
}

function attribute(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))
  return match ? decode(match[1] ?? match[2] ?? match[3] ?? '') : null
}

/** Reads the preview fields from a page's <head>. */
export function parsePreview(html: string, pageUrl: string): Omit<LinkPreview, 'url' | 'host'> {
  const end = html.search(/<\/head>/i)
  const head = end > 0 ? html.slice(0, end) : html
  const meta: Record<string, string> = {}
  for (const [tag] of head.matchAll(/<meta\b[^>]*>/gi)) {
    const key = (attribute(tag, 'property') ?? attribute(tag, 'name'))?.toLowerCase()
    const content = attribute(tag, 'content')
    if (key && content && !(key in meta)) meta[key] = content
  }
  let icon: string | null = null
  for (const [tag] of head.matchAll(/<link\b[^>]*>/gi)) {
    const rel = attribute(tag, 'rel')?.toLowerCase().split(/\s+/) ?? []
    if (rel.includes('icon') || rel.includes('apple-touch-icon')) { icon = attribute(tag, 'href'); if (rel.includes('icon')) break }
  }
  const absolute = (value: string | null | undefined) => {
    if (!value) return null
    try {
      const url = new URL(value, pageUrl)
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
    } catch { return null }
  }
  const titleTag = head.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]
  const title = meta['og:title'] ?? meta['twitter:title'] ?? (titleTag ? decode(titleTag) : null)
  return {
    siteName: meta['og:site_name'] ?? null,
    title: title || null,
    description: meta['og:description'] ?? meta['twitter:description'] ?? meta.description ?? null,
    image: absolute(meta['og:image'] ?? meta['og:image:url'] ?? meta['twitter:image']),
    icon: absolute(icon) ?? absolute('/favicon.ico'),
  }
}
