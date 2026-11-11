const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const id = (value: unknown) => typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null

/** A notification is never interpreted under another server/account. */
export function pushBelongsToAccount(data: unknown, account: { id: string; server: { url: string }; user: { id: string } | null }): boolean {
  if (!account.user || !data || typeof data !== 'object') return false
  const fields = data as Record<string, unknown>
  if (fields.serverUrl === undefined && fields.userId === undefined) return account.id === 'legacy' && account.server.url === 'https://app.aspectlylabs.com/mikka'
  return fields.serverUrl === account.server.url && fields.userId === account.user.id
}

/**
 * Where a tapped push opens, from its `data` (lib/mobile-push.ts on the
 * server): a proposal waiting for the person opens its chat scrolled to that
 * card; a thread of a task (等你回复, 待审阅) opens its task, which then opens
 * that attempt (2026-11-07: a thread opens only inside its task); a thread
 * without a task opens the thread; anything else opens the chat it came from.
 * Fields the server does not send yet are simply absent.
 */
export function pushTarget(data: unknown): string {
  const fields = data && typeof data === 'object' ? data as Record<string, unknown> : {}
  const bot = id(fields.botId)
  const chat = `/bots/${bot ?? 'coordinator'}`
  const action = id(fields.pendingActionId)
  if (action) return `${chat}?action=${action}`
  const run = id(fields.runId)
  const task = id(fields.issueId)
  if (task) return run ? `/task/${task}?attempt=${run}` : `/task/${task}`
  if (run) return `/thread/${run}`
  return chat
}

/** A task push's target (#1659 item 4): the task, the workspace it lives in and, for a thread, the attempt. */
export interface TaskPushTarget { workspaceId: string; issueId: string; runId: string | null }

/**
 * The task a full task push points at (#1659 item 4), in this order:
 * - a proposal (`pendingActionId`) keeps its chat card: null;
 * - no `workspaceId` field at all (a generic push, a privacy-mode reminder with serverUrl, userId and botId only, or a
 *   legacy server's task push): null, so pushTarget keeps the old entry;
 * - a `workspaceId` field, with both it and `issueId` valid: the target;
 * - a `workspaceId` field with either one empty, null or not a UUID: 'invalid'. It is refused, never degraded into
 *   the legacy task or thread entry, so nothing opens without confirming a workspace.
 */
export function pushTaskTarget(data: unknown): TaskPushTarget | 'invalid' | null {
  const fields = data && typeof data === 'object' ? data as Record<string, unknown> : {}
  if (id(fields.pendingActionId)) return null
  if (fields.workspaceId === undefined) return null
  const workspaceId = id(fields.workspaceId), issueId = id(fields.issueId)
  return workspaceId && issueId ? { workspaceId, issueId, runId: id(fields.runId) } : 'invalid'
}
