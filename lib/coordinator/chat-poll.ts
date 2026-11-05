import type { ListLiveRead } from '@/lib/live/list-read'

/** A poll whose version matched: only the chat's live state, the conversation itself is as before. */
export type UnchangedChat = { unchanged: true; version: string; cursor: number; streamRunId?: string; working: boolean; error: string | null; botId: string; enabled: boolean; live?: ListLiveRead }

/**
 * At most this long between decoration refreshes: cited names and artifact
 * cards can change independently. The server still uses the history cursor.
 */
export const FULL_READ_EVERY_MS = 60_000

/** Omit the known version when card metadata needs refreshing; retain the history continuation. */
export function knownVersion(previous: { version?: string } | undefined, fullReadAt: number, now: number): string | undefined {
  return previous?.version && now - fullReadAt < FULL_READ_EVERY_MS ? previous.version : undefined
}

/** The chat to show after a poll: the full chat it returned, or the previous one with the poll's live state. */
type ChatCache = { version?: string; streamRunId?: string; cursor?: number; items: { position: number; pending?: true }[]; sources?: object; artifacts?: object; persistedStreamIds?: string[]; historyBefore?: number; after?: number; baseCursor?: number; metadataRefresh?: boolean }

export function mergeChat<T extends ChatCache>(previous: T | undefined, next: T | UnchangedChat): T {
  if (!('unchanged' in next)) {
    if (next.after === undefined || !previous) return next
    if (previous.cursor !== next.baseCursor) return previous
    const { after, baseCursor: _base, ...rest } = next
    return { ...rest, items: [...previous.items.filter(item => !item.pending && item.position <= after), ...next.items],
      sources: next.metadataRefresh ? next.sources : { ...previous.sources, ...next.sources },
      artifacts: next.metadataRefresh ? next.artifacts : { ...previous.artifacts, ...next.artifacts },
      persistedStreamIds: [...new Set([...previous.persistedStreamIds ?? [], ...next.persistedStreamIds ?? []])],
      historyBefore: previous.historyBefore,
    } as T
  }
  // The cache moved on while the poll was out (a send revalidated it): keep the newer chat.
  if (!previous || previous.version !== next.version) return previous as T
  const { unchanged: _, streamRunId, ...state } = next
  const { streamRunId: _previousRun, ...rest } = previous
  return { ...rest, ...state, ...(streamRunId ? { streamRunId } : {}) } as unknown as T
}
