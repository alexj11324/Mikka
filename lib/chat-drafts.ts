/**
 * Unsent drafts and scoped browsing state belong to the authenticated window
 * session. A successful logout clears them without removing browser preferences.
 */
export const CHAT_DRAFT_PREFIX = 'mikka:draft:'
export const VIEW_STATE_PREFIX = 'mikka:view:'
export const CLEAR_VIEW_STATE_EVENT = 'mikka:clear-view-state'

export function clearChatDrafts() {
  // Logout awaits read-cache cleanup before navigation can unmount the current
  // views. Retire their writers synchronously before removing their stored state.
  if (typeof window !== 'undefined') window.dispatchEvent(new window.Event(CLEAR_VIEW_STATE_EVENT))
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith(CHAT_DRAFT_PREFIX) || key.startsWith(VIEW_STATE_PREFIX)) sessionStorage.removeItem(key)
    }
  } catch { /* storage may be unavailable */ }
}
