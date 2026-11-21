import { z } from 'zod'
import { createMcpSchema, PluginError } from './contracts'
import { publicMcpFetch } from './public-fetch'
import type { PersonalPluginStore } from './store'

const registry = 'https://registry.modelcontextprotocol.io'
const remote = z.object({ type: z.enum(['streamable-http', 'sse']), url: z.url() })
const entry = z.object({ server: z.object({ name: z.string().max(200), description: z.string().max(5000), version: z.string().max(200), remotes: z.array(remote).optional() }),
  _meta: z.record(z.string(), z.unknown()).optional() })
export const installMcpCatalog = z.object({ name: z.string().min(1).max(200), remoteIndex: z.number().int().min(0).max(99).default(0) }).strict()

async function read(path: string) {
  const transport = publicMcpFetch(registry, AbortSignal.timeout(15_000))
  try {
    const response = await transport.fetch(new URL(path, registry), { headers: { accept: 'application/json' } })
    if (!response.ok) throw new PluginError('mcpCatalogUnavailable', 503)
    return await response.json() as unknown
  } finally { await transport.close() }
}

/** The official public directory is metadata, never an executable instruction. */
export async function searchMcpCatalog(query = '', cursor?: string) {
  if (query.length > 200 || (cursor?.length ?? 0) > 2048) throw new PluginError('invalidPluginInput', 400)
  const params = new URLSearchParams({ version: 'latest', limit: '50', ...(query ? { search: query } : {}), ...(cursor ? { cursor } : {}) })
  const result = z.object({ servers: z.array(entry), metadata: z.object({ nextCursor: z.string().optional() }).optional() }).parse(await read(`/v0.1/servers?${params}`))
  return { entries: result.servers.map(item => ({ name: item.server.name, description: item.server.description, version: item.server.version,
    remotes: (item.server.remotes ?? []).flatMap((item, index) => {
      const parsed = createMcpSchema.safeParse({ name: 'catalogue', transport: item.type === 'sse' ? 'sse' : 'http', url: item.url })
      return parsed.success ? [{ index, url: item.url, transport: item.type === 'sse' ? 'sse' as const : 'http' as const }] : []
    }) })), nextCursor: result.metadata?.nextCursor ?? null }
}

export async function addCatalogMcp(store: PersonalPluginStore, userId: string, input: z.infer<typeof installMcpCatalog>) {
  const request = installMcpCatalog.parse(input)
  const result = entry.parse(await read(`/v0.1/servers/${encodeURIComponent(request.name)}/versions/latest`))
  if (result.server.name !== request.name) throw new PluginError('mcpCatalogMismatch', 502)
  const remote = result.server.remotes?.[request.remoteIndex]
  if (!remote) throw new PluginError('mcpCatalogRemoteUnavailable', 400)
  return store.createMcp(userId, createMcpSchema.parse({ name: result.server.name.slice(0, 80), url: remote.url, transport: remote.type === 'sse' ? 'sse' : 'http' }))
}
