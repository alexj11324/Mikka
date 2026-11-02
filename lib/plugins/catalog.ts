import { isToolkitSlug, OWN_INTEGRATIONS } from '@/lib/composio-accounts'
import { PluginError } from './contracts'
import { connectKind, type ConnectKind } from './connect-kind'

// The 插件 store: every Composio toolkit (decisions 2026-10-31 and
// 2026-11-02), whether it connects in one click (Composio-managed auth), with
// the person's own API key, or needs nothing. Order, categories and dates are
// Composio's own (v3 GET /toolkits); nothing here ranks apps itself.

export type StoreCategory = { id: string; name: string }
/** `connect`: one click (managed), the person's own credentials, nothing to connect, or not connectable from Mikka yet. */
export type StoreApp = { id: string; name: string; description: string; iconUrl: string | null; categories: StoreCategory[]; createdAt: string | null; connect: ConnectKind }
export type StoreCatalog = {
  /** In Composio's usage order (`sort_by=usage`), most used first. */
  apps: StoreApp[]
  /** 热门: the first apps in Composio's usage order. */
  popular: string[]
  /** 新品推荐: the apps Composio added most recently (`meta.created_at`). */
  latest: string[]
  /** Composio's categories, largest first; each lists its apps in usage order. */
  categories: (StoreCategory & { apps: string[] })[]
}

type RawToolkit = {
  slug: string
  name: string
  is_local_toolkit?: boolean | null
  no_auth?: boolean | null
  composio_managed_auth_schemes?: string[] | null
  auth_schemes?: string[] | null
  meta?: { description?: string | null; logo?: string | null; created_at?: string | null; categories?: { id?: string | null; name?: string | null }[] | null } | null
}
type RawPage = { items: RawToolkit[]; next_cursor?: string | null }
/** The one call the store needs: `composio.getClient().toolkits.list`. */
export type ToolkitLister = (query: { sort_by: 'usage'; limit: number; cursor?: string }) => Promise<RawPage>

export const SECTION_SIZE = 12
const PAGE_LIMIT = 1000
const MAX_PAGES = 10
const CACHE_MS = 60 * 60 * 1000

const clean = (value: unknown, max: number) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : ''

function publicIcon(value: unknown) {
  try { const url = new URL(typeof value === 'string' ? value : ''); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null } catch { return null }
}

/** Every Composio toolkit is in the store, except local ones and Composio's copies of Mikka's own integrations. */
function listed(item: RawToolkit) {
  return isToolkitSlug(item.slug) && !OWN_INTEGRATIONS.has(item.slug) && !item.is_local_toolkit
}

export function toStoreApp(item: RawToolkit): StoreApp {
  const categories = (item.meta?.categories ?? []).flatMap(category => {
    const id = clean(category?.id, 80), name = clean(category?.name, 80)
    return id && name ? [{ id, name }] : []
  })
  const created = item.meta?.created_at && !Number.isNaN(Date.parse(item.meta.created_at)) ? new Date(item.meta.created_at).toISOString() : null
  return { id: item.slug, name: clean(item.name, 200) || item.slug, description: clean(item.meta?.description, 300), iconUrl: publicIcon(item.meta?.logo), categories, createdAt: created, connect: connectKind(item) }
}

/** Sections from Composio's own data. `apps` must already be in usage order. */
export function storeSections(apps: StoreApp[]): StoreCatalog {
  const latest = apps.filter(app => app.createdAt).sort((a, b) => b.createdAt!.localeCompare(a.createdAt!)).slice(0, SECTION_SIZE).map(app => app.id)
  const byCategory = new Map<string, StoreCategory & { apps: string[] }>()
  for (const app of apps) for (const category of app.categories) {
    const entry = byCategory.get(category.id) ?? { ...category, apps: [] }
    if (!entry.apps.includes(app.id)) entry.apps.push(app.id)
    byCategory.set(category.id, entry)
  }
  const categories = [...byCategory.values()].sort((a, b) => b.apps.length - a.apps.length || a.name.localeCompare(b.name))
  return { apps, popular: apps.slice(0, SECTION_SIZE).map(app => app.id), latest, categories }
}

export async function fetchStoreCatalog(list: ToolkitLister): Promise<StoreCatalog> {
  const apps: StoreApp[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await list({ sort_by: 'usage', limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) })
    for (const item of result.items ?? []) if (listed(item) && !seen.has(item.slug)) { seen.add(item.slug); apps.push(toStoreApp(item)) }
    cursor = result.next_cursor ?? undefined
    if (!cursor) break
  }
  return storeSections(apps)
}

let cached: { at: number; value: Promise<StoreCatalog> } | null = null

/** The store, read from Composio at most once an hour per server. A failed read is not kept. */
export function listStoreCatalog(list: ToolkitLister, now = Date.now()): Promise<StoreCatalog> {
  if (cached && now - cached.at < CACHE_MS) return cached.value
  const value = fetchStoreCatalog(list)
  const entry = { at: now, value }
  cached = entry
  value.catch(() => { if (cached === entry) cached = null })
  return value
}

export function resetStoreCatalogCache() { cached = null }

/** The real Composio client's lister, with a timeout per page. */
export function composioToolkitLister(client: { getClient: () => { toolkits: { list: (query: never, options?: { signal?: AbortSignal }) => Promise<unknown> } } }): ToolkitLister {
  return query => client.getClient().toolkits.list(query as never, { signal: AbortSignal.timeout(10_000) }) as Promise<RawPage>
}

/** A new connection must be a store app that connects that way. */
export async function assertCatalogToolkit(list: ToolkitLister, id: string, kind: ConnectKind = 'managed') {
  if (!(await listStoreCatalog(list)).apps.some(app => app.id === id && app.connect === kind)) throw new PluginError('integrationToolkitNotSupported', 400)
}

/** Whether an app needs no connection at all (its tools run on the person's id alone). */
export async function isNoAuthToolkit(list: ToolkitLister, id: string) {
  return (await listStoreCatalog(list)).apps.some(app => app.id === id && app.connect === 'none')
}
