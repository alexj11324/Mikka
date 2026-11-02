/** A poll whose version matched: only the chat's live state, the conversation itself is as before. */
export type UnchangedChat = { unchanged: true; version: string; cursor: number; streamRunId?: string; working: boolean; error: string | null; botId: string; enabled: boolean }

/**
 * At most this long between full reads: the names of cited threads and tasks
 * and the artifact cards can change without the conversation changing.
 */
export const FULL_READ_EVERY_MS = 60_000

/** The version a poll sends, or none for a full read. */
export function knownVersion(previous: { version?: string } | undefined, fullReadAt: number, now: number): string | undefined {
  return previous?.version && now - fullReadAt < FULL_READ_EVERY_MS ? previous.version : undefined
}

/** The chat to show after a poll: the full chat it returned, or the previous one with the poll's live state. */
export function mergeChat<T extends { version?: string; streamRunId?: string }>(previous: T | undefined, next: T | UnchangedChat): T {
  if (!('unchanged' in next)) return next
  // The cache moved on while the poll was out (a send revalidated it): keep the newer chat.
  if (!previous || previous.version !== next.version) return previous as T
  const { unchanged: _, streamRunId, ...state } = next
  const { streamRunId: _previousRun, ...rest } = previous
  return { ...rest, ...state, ...(streamRunId ? { streamRunId } : {}) } as unknown as T
}
