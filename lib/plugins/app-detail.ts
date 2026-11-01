import { isToolkitSlug, OWN_INTEGRATIONS } from '@/lib/composio-accounts'
import { PluginError } from './contracts'
import type { StoreCategory } from './catalog'

// One store app's page (decision 2026-10-31, as Codex's app page): Composio's
// own description, tool list and facts, shown whether or not the person has
// connected the app. Mikka writes nothing here; a field Composio does not
// have is left out. Read with the server's key and cached per app.

export type AppTool = { slug: string; name: string; description: string }
export type AppDetail = {
  id: string
  name: string
  description: string
  iconUrl: string | null
  categories: StoreCategory[]
  website: string | null
  version: string | null
  /** Split by Composio's MCP annotations: `readOnlyHint` reads; anything else (including no hint) writes, as in #658. */
  tools: { write: AppTool[]; read: AppTool[] }
}

type RawToolkit = {
  slug?: string | null
  name?: string | null
  meta?: { description?: string | null; logo?: string | null; app_url?: string | null; version?: string | null; categories?: { slug?: string | null; id?: string | null; name?: string | null }[] | null } | null
}
type RawTool = { slug?: string | null; name?: string | null; description?: string | null; tags?: string[] | null; is_deprecated?: boolean | null; toolkit?: { slug?: string | null } | null }
type RawToolPage = { items?: RawTool[] | null; next_cursor?: string | null }
export type AppDetailSource = {
  retrieve: (slug: string) => Promise<RawToolkit>
  listTools: (query: { toolkit_slug: string; limit: number; cursor?: string }) => Promise<RawToolPage>
}

const CACHE_MS = 60 * 60 * 1000
const CACHE_SIZE = 200
const PAGE_LIMIT = 1000
const MAX_PAGES = 5
const clean = (value: unknown, max: number) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : ''
function publicUrl(value: unknown) {
  try { const url = new URL(typeof value === 'string' ? value : ''); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null } catch { return null }
}

export async function fetchAppDetail(source: AppDetailSource, slug: string): Promise<AppDetail> {
  if (!isToolkitSlug(slug) || OWN_INTEGRATIONS.has(slug)) throw new PluginError('integrationToolkitNotSupported', 404)
  const toolkit = await source.retrieve(slug)
  if (toolkit.slug !== slug) throw new PluginError('integrationToolkitNotSupported', 404)
  const tools: { write: AppTool[]; read: AppTool[] } = { write: [], read: [] }
  const seen = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await source.listTools({ toolkit_slug: slug, limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) })
    for (const tool of result.items ?? []) {
      const id = clean(tool.slug, 128)
      if (!id || seen.has(id) || tool.is_deprecated || (tool.toolkit?.slug && tool.toolkit.slug !== slug)) continue
      seen.add(id)
      const entry = { slug: id, name: clean(tool.name, 200) || id, description: clean(tool.description, 600) }
      ;(Array.isArray(tool.tags) && tool.tags.includes('readOnlyHint') ? tools.read : tools.write).push(entry)
    }
    cursor = result.next_cursor ?? undefined
    if (!cursor) break
  }
  const meta = toolkit.meta ?? {}
  const categories = (meta.categories ?? []).flatMap(category => {
    const id = clean(category?.slug ?? category?.id, 80), name = clean(category?.name, 80)
    return id && name ? [{ id, name }] : []
  })
  return {
    id: slug, name: clean(toolkit.name, 200) || slug, description: clean(meta.description, 2000), iconUrl: publicUrl(meta.logo),
    categories, website: publicUrl(meta.app_url), version: clean(meta.version, 40) || null, tools,
  }
}

const cache = new Map<string, { at: number; value: Promise<AppDetail> }>()

/** At most one Composio read per app per hour per server. A failed read is not kept. */
export function readAppDetail(source: AppDetailSource, slug: string, now = Date.now()): Promise<AppDetail> {
  const hit = cache.get(slug)
  if (hit && now - hit.at < CACHE_MS) return hit.value
  const value = fetchAppDetail(source, slug)
  const entry = { at: now, value }
  cache.delete(slug)
  cache.set(slug, entry)
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!)
  value.catch(() => { if (cache.get(slug) === entry) cache.delete(slug) })
  return value
}

export function resetAppDetailCache() { cache.clear() }

type RawClient = { getClient: () => { toolkits: { retrieve: (slug: string, query?: never, options?: { signal?: AbortSignal }) => Promise<unknown> }; tools: { list: (body: never, options?: { signal?: AbortSignal }) => Promise<unknown> } } }
/** The real Composio client, with a timeout per call. */
export function composioAppDetailSource(client: RawClient): AppDetailSource {
  return {
    retrieve: slug => client.getClient().toolkits.retrieve(slug, undefined, { signal: AbortSignal.timeout(10_000) }) as Promise<RawToolkit>,
    listTools: query => client.getClient().tools.list(query as never, { signal: AbortSignal.timeout(10_000) }) as Promise<RawToolPage>,
  }
}
