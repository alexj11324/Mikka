import { createHash } from 'node:crypto'
import { z } from 'zod'
import { agentImageQuery, type AgentImageResult } from './agent-images'

const publicURL = (hosts: string[]) => z.string().url().refine(value => {
  const url = new URL(value)
  return url.protocol === 'https:' && hosts.includes(url.hostname) && !url.username && !url.password
})
const image = z.object({
  src: publicURL(['upload.wikimedia.org', 'thumb.wikimedia.org']), source: publicURL(['commons.wikimedia.org']),
  width: z.number().int().positive().max(30000), height: z.number().int().positive().max(30000),
  title: z.string(), author: z.string().max(300), license: z.string().min(1).max(300),
}).strict().nullable()
const entry = z.object({ at: z.number().finite().nonnegative(), value: image }).strict()
export type PublicImageCacheEntry = z.infer<typeof entry>
type Store = { get(key: string): Promise<unknown>; set(key: string, value: PublicImageCacheEntry): Promise<unknown> }
const day = 86_400_000

/** This cache accepts only a validated keyword and the fixed Commons loader's
 * public projection. No request headers, user, bearer or arbitrary URL enter
 * either the key or the stored value. Matches the previous one-day stale-
 * while-revalidate policy; failed background refresh keeps the last value. */
export function publicImageLookup(store: Store, load: (query: string, signal?: AbortSignal) => Promise<AgentImageResult | null>,
  schedule: (work: () => Promise<void>) => void, now = Date.now) {
  const pending = new Set<string>()
  return async (query: string, signal?: AbortSignal): Promise<AgentImageResult | null> => {
    const keyword = agentImageQuery.parse(query)
    signal?.throwIfAborted()
    const key = createHash('sha256').update(keyword).digest('hex')
    let cached: PublicImageCacheEntry | undefined
    try { const parsed = entry.safeParse(await store.get(key)); if (parsed.success && parsed.data.at <= now()) cached = parsed.data } catch { /* A public cache outage must not deny the existing upstream lookup. */ }
    const refresh = async (requestSignal?: AbortSignal) => {
      const value = image.parse(await load(keyword, requestSignal))
      try { await store.set(key, { at: now(), value }) } catch { /* Successful public content still serves when persistence fails. */ }
      return value
    }
    if (!cached) return refresh(signal)
    if (now() - cached.at >= day && !pending.has(key)) {
      pending.add(key)
      try { schedule(async () => {
        try { await refresh() } catch { /* Preserve stale content on upstream failure, as before. */ }
        finally { pending.delete(key) }
      }) } catch (error) { pending.delete(key); throw error }
    }
    return cached.value
  }
}
