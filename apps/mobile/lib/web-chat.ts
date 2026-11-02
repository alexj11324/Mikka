const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A native chat must identify its Bot or workspace before a browser can
 * open it; an unscoped Coordinator could use the browser's old workspace. */
export function webChatPath(botId: string | null, workspaceId?: string): string | null {
  if ((botId && !UUID.test(botId)) || (workspaceId && !UUID.test(workspaceId))) return null
  if (!botId && !workspaceId) return null
  return `/?section=coordinator${botId ? `&bot=${botId.toLowerCase()}` : ''}${workspaceId ? `&workspace=${workspaceId.toLowerCase()}` : ''}`
}
