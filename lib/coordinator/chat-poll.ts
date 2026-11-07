import type { ListLiveRead } from '@/lib/live/list-read'
import type { ChatView } from './store'
import type { ChatTool } from './context'
import { restoreChatToolMetadata, type ChatToolMetadata } from './chat-tool-metadata'

/** A poll whose version matched: only the chat's live state, the conversation itself is as before. */
export type UnchangedChat = { unchanged: true; version: string; cursor: number; streamRunId?: string; working: boolean; error: string | null; cause?: string; botId: string; enabled: boolean; live?: ListLiveRead; metadata?: Pick<ChatView, 'sources' | 'artifacts'> }

function currentChatMetadata(chat: Pick<ChatView, 'sources' | 'artifacts'> | UnchangedChat): Pick<ChatView, 'sources' | 'artifacts'> | undefined {
  return 'unchanged' in chat ? chat.metadata : chat
}

/** A shared transcript never shares its decorations' authority. Each requester
 * authorizes both its retained cards and the shared tail, then replaces those
 * maps on a new response object. Neither a flight nor a sibling is mutated. */
export async function refreshChatMetadata<T extends Pick<ChatView, 'sources' | 'artifacts'> | UnchangedChat>(
  chat: T,
  held: { sourceIds?: readonly string[]; artifactIds?: readonly string[] } | undefined,
  read: (ids: { sourceIds: string[]; artifactIds: string[] }) => Promise<Pick<ChatView, 'sources' | 'artifacts'>>,
): Promise<T> {
  const current = currentChatMetadata(chat)
  const sourceIds = [...new Set([...held?.sourceIds ?? [], ...Object.keys(current?.sources ?? {})])].sort()
  const artifactIds = [...new Set([...held?.artifactIds ?? [], ...Object.keys(current?.artifacts ?? {})])].sort()
  const metadata = sourceIds.length || artifactIds.length ? await read({ sourceIds, artifactIds }) : { sources: {}, artifacts: {} }
  return { ...chat, ...('unchanged' in chat ? { metadata } : { ...metadata, metadataRefresh: true }) }
}

/**
 * Cited task names and artifact cards change without a chat write. Every
 * cursor read rechecks their current authorization. No timer refreshes them (#1212): an
 * artifact's own live key, or the page coming back into view, marks them stale,
 * and the next read omits the version so the server refreshes them. The server
 * still uses the history cursor.
 */
export function knownVersion(previous: { version?: string } | undefined, metadataStale: boolean): string | undefined {
  return previous?.version && !metadataStale ? previous.version : undefined
}

/** At most this many artifact cards listen for their own change; the rest refresh with the next full read. */
export const METADATA_KEYS_MAX = 100

/** The live keys whose change makes the chat's decorations stale: each artifact card, on the owner's home channel. */
export function metadataEntities(chat: { artifacts?: Record<string, unknown> } | undefined) {
  return Object.keys(chat?.artifacts ?? {}).sort().slice(0, METADATA_KEYS_MAX).map(id => ({ kind: 'artifact' as const, id }))
}

/** The chat to show after a poll: the full chat it returned, or the previous one with the poll's live state. */
type ChatCache = { version?: string; streamRunId?: string; cursor?: number; items: { position: number; pending?: true; from?: string; activity?: { tools: ChatTool[] } }[]; sources?: object; artifacts?: object; persistedStreamIds?: string[]; historyBefore?: number; after?: number; baseCursor?: number; metadataRefresh?: boolean; continuation?: { after: number; cursor: number; prefix: string }; restoreToolMetadata?: true; toolMetadata?: ChatToolMetadata }

export function mergeChat<T extends ChatCache>(previous: T | undefined, next: T | UnchangedChat): T | undefined {
  if (!('unchanged' in next)) {
    if (next.after === undefined || !previous) {
      if ('toolMetadata' in next || 'restoreToolMetadata' in next) {
        const { toolMetadata: _overlay, restoreToolMetadata: _restore, ...snapshot } = next
        return snapshot as T
      }
      return next
    }
    if (previous.cursor !== next.baseCursor) return next.toolMetadata || previous.restoreToolMetadata ? undefined : previous
    const { after, baseCursor: _base, toolMetadata, restoreToolMetadata: _restore, ...rest } = next
    let prefix = previous.items.filter(item => !item.pending && item.position <= after)
    if (previous.restoreToolMetadata && !toolMetadata) return undefined
    if (toolMetadata) {
      const proof = previous.continuation
      if (!proof || toolMetadata.baseCursor !== previous.cursor || toolMetadata.prefix !== proof.prefix || after !== proof.after) return undefined
      const restored = restoreChatToolMetadata(prefix, toolMetadata.rows, after, toolMetadata.baseCursor)
      if (!restored) return undefined
      prefix = restored
    }
    return { ...rest, items: [...prefix, ...next.items],
      sources: next.metadataRefresh ? next.sources : { ...previous.sources, ...next.sources },
      artifacts: next.metadataRefresh ? next.artifacts : { ...previous.artifacts, ...next.artifacts },
      persistedStreamIds: [...new Set([...previous.persistedStreamIds ?? [], ...next.persistedStreamIds ?? []])],
      historyBefore: previous.historyBefore,
    } as T
  }
  // The cache moved on while the poll was out (a send revalidated it): keep the newer chat.
  if (!previous || previous.version !== next.version) return previous
  if (previous.restoreToolMetadata) return undefined
  const { unchanged: _, streamRunId, metadata, ...state } = next
  const { streamRunId: _previousRun, ...rest } = previous
  return { ...rest, ...state, ...metadata, ...(streamRunId ? { streamRunId } : {}) } as unknown as T
}
