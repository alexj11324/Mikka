'use client'

import { unstable_serialize, type Cache } from 'swr'
import { syncCoordinatorChat, type CoordinatorChat } from '@/app/actions/coordinator'
import { CacheReadError } from '@/lib/cache-read-error'
import { chatKeys } from '@/lib/swr/keys'
import { waitForCacheHydration } from '@/lib/swr/persistent-cache'
import { ListReadScopeError } from '@/lib/live/list-read'
import { diagCurrentRead, diagWithRead } from '@/lib/diagnostics/issue1512-native-reads.mjs'
import { mergeChat } from './chat-poll'

export type CachedCoordinatorChat = CoordinatorChat & { requestedAt?: number }
const checked = new WeakMap<object, Set<string>>()

/** Components that fetch a chat key use this reader; summary-only sidebars
 * never subscribe to it. This keeps another mounted fetcher from replacing
 * the transcript's delta reader with a full snapshot on every refresh. */
export async function readCachedCoordinatorChat(cache: Cache, botId: string | null = null, options: { refreshMetadata?: boolean } = {}): Promise<CachedCoordinatorChat> {
  const diagnosticRead = diagCurrentRead()
  await waitForCacheHydration(cache)
  const key = unstable_serialize(chatKeys.detail(botId))
  const previous = cache.get(key)?.data as CachedCoordinatorChat | undefined
  const restoreToolMetadata = previous?.restoreToolMetadata === true
  const expectedOwner = (cache as Cache & { readonly ownerId?: string }).ownerId ?? previous?.live?.ownerId
  const requestedAt = performance.now()
  let validated = checked.get(cache)
  if (!validated) { validated = new Set(); checked.set(cache, validated) }
  // The first read of a recovered cache replays its tail and current metadata.
  // Tool labels lost on disk are repaired without replaying prefix text;
  // transient pending/stream state is never trusted across a page restart.
  const known = validated.has(key) && !options.refreshMetadata && !restoreToolMetadata ? previous?.version : undefined
  const continuation = previous?.continuation && { ...previous.continuation,
    ...(restoreToolMetadata ? { restoreToolMetadata: true as const } : {}),
    sourceIds: Object.keys(previous.sources).slice(0, 400), artifactIds: Object.keys(previous.artifacts).slice(0, 400) }
  const result = await diagWithRead(diagnosticRead, () => syncCoordinatorChat(botId, known, continuation))
  if (result.error) { validated.delete(key); throw new CacheReadError(result.error) }
  if (expectedOwner && result.chat.live?.ownerId !== expectedOwner) { validated.delete(key); throw new ListReadScopeError('owner') }
  const current = cache.get(key)?.data as CachedCoordinatorChat | undefined
  // A full repair has no baseCursor. Keep a local/newer server write made
  // while it was in flight, and do not mark the old preview validated yet.
  if (current && current.botId === result.chat.botId && !('unchanged' in result.chat)
    && (current !== previous && (result.chat.after === undefined || restoreToolMetadata || result.chat.toolMetadata)
      || result.chat.toolMetadata && (current.cursor !== continuation?.cursor || current.continuation?.prefix !== continuation?.prefix))) return current
  const held = current?.botId === result.chat.botId ? current : previous?.botId === result.chat.botId ? previous : undefined
  const merged = mergeChat(held, result.chat)
  if (!merged) {
    // The current chat changed while an unchanged answer was in flight. One
    // explicit full read restores a valid base; no timer or retry loop is used.
    const baseCursor = current?.cursor, basePrefix = current?.continuation?.prefix
    const full = await diagWithRead(diagnosticRead, () => syncCoordinatorChat(botId))
    if (full.error) { validated.delete(key); throw new CacheReadError(full.error) }
    if (expectedOwner && full.chat.live?.ownerId !== expectedOwner) { validated.delete(key); throw new ListReadScopeError('owner') }
    const latest = cache.get(key)?.data as CachedCoordinatorChat | undefined
    if (latest && latest.botId === full.chat.botId && (latest !== current || restoreToolMetadata && (latest.cursor !== baseCursor || latest.continuation?.prefix !== basePrefix))) return latest
    validated.add(key)
    // With no proof the server always returns a full snapshot. Consume any
    // response-only repair fields before it becomes a durable read model.
    const { toolMetadata: _overlay, restoreToolMetadata: _restore, ...snapshot } = full.chat as CoordinatorChat
    return { ...snapshot, requestedAt }
  }
  validated.add(key)
  return merged === current ? merged : { ...merged, requestedAt }
}
