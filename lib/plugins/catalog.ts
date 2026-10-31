import type { Composio } from '@composio/core'
import { COMPOSIO_TOOLKIT_IDS } from '@/lib/composio-accounts'
import { COMPOSIO_ACTIONS } from '@/lib/composio-actions'
import { PluginError } from './contracts'

export type CatalogApp = { id: string; name: string; description: string; iconUrl: string | null; authKind: string[]; actions: string[] }

/** The supported action registry is the allowlist, never the provider's tool
 * count or model-supplied toolkit/tool names. Metadata comes from Composio. */
export async function listAppCatalog(client: Pick<Composio, 'toolkits'>): Promise<CatalogApp[]> {
  const supported = COMPOSIO_TOOLKIT_IDS.filter(id => Object.values(COMPOSIO_ACTIONS).some(action => action.toolkit === id))
  const items = await client.toolkits.getMany([...supported], { limit: 100 }, { signal: AbortSignal.timeout(10_000) })
  return items.filter(item => supported.some(id => id === item.slug) && !item.isLocalToolkit).map(item => ({
    id: item.slug, name: item.name.slice(0, 200), description: (item.meta.description ?? '').replace(/\s+/g, ' ').slice(0, 300),
    iconUrl: publicIcon(item.meta.logo), authKind: item.noAuth ? ['none'] : item.composioManagedAuthSchemes ?? item.authSchemes ?? [],
    actions: Object.entries(COMPOSIO_ACTIONS).filter(([, action]) => action.toolkit === item.slug).map(([name]) => name),
  })).sort((a, b) => a.name.localeCompare(b.name))
}
function publicIcon(value?: string) {
  try { const url = new URL(value ?? ''); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null } catch { return null }
}
export async function assertCatalogToolkit(client: Pick<Composio, 'toolkits'>, id: string) {
  if (!(await listAppCatalog(client)).some(app => app.id === id)) throw new PluginError('integrationToolkitNotSupported', 400)
}
