/**
 * Unsent chat drafts live in sessionStorage, keyed by user and conversation.
 * They must not outlive the session: a later account on the same tab would
 * otherwise find text the previous person typed.
 */
export const CHAT_DRAFT_PREFIX = 'mikka:draft:'

export function clearChatDrafts() {
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith(CHAT_DRAFT_PREFIX)) sessionStorage.removeItem(key)
    }
  } catch { /* storage may be unavailable */ }
}
