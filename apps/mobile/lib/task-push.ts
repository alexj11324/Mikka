import type { TaskPushTarget } from './push-route'
import { switchWorkspace } from './workspace-switch'

/** The request preference the server checks live (lib/workspace-selection.ts); never an identity or a grant. */
export const WORKSPACE_SELECTION_HEADER = 'x-mikka-workspace-id'

/** Where a confirmed task push opens: the task, marked with the workspace it was confirmed in, then its attempt. */
export function taskPushHref(target: TaskPushTarget): string {
  return `/task/${target.issueId}?workspace=${target.workspaceId}${target.runId ? `&attempt=${target.runId}` : ''}`
}

export type TaskPushResult = 'opened' | 'refused' | 'superseded'

export interface TaskPushDeps {
  /** The workspace the server has selected now: a fresh GET /api/mobile/settings. Throws when it cannot be read. */
  current: () => Promise<string>
  /** Saves the pick the way 设置 › 工作区 does (lib/api.ts saveWorkspace). */
  save: (id: string) => Promise<void>
  /** The account/workspace context (lib/api-cache.ts): it moves on every switch and sign-out. */
  context: () => number
  open: (href: string) => void
}

/**
 * Opens tapped task pushes in their own workspace (#1659 item 4), one at a time, in three steps:
 * 1. the target is captured from the push (pushTaskTarget);
 * 2. the workspace selection is read fresh and, when it is another workspace, switched through the existing switch
 *    (lib/workspace-switch.ts), which reads the selection back and restores the old one when the server refuses;
 * 3. only a confirmed selection opens the task.
 * A refused or unreadable confirmation stops: nothing opens and no other workspace is tried. A newer tap supersedes an
 * older one still waiting, and a selection that moved while confirming (another switch, a sign-out) stops it too.
 */
export function taskPushOpener(deps: TaskPushDeps) {
  let latest = 0
  let queue: Promise<unknown> = Promise.resolve()
  const confirm = async (target: TaskPushTarget, ticket: number): Promise<TaskPushResult> => {
    if (ticket !== latest) return 'superseded'
    let fence = deps.context()
    let selected: string
    try { selected = await deps.current() } catch { return 'refused' }
    if (selected !== target.workspaceId) {
      const failed = await switchWorkspace({ id: target.workspaceId, name: '' }, selected, {
        // The fence is the context the confirmed save made; any later move belongs to someone else.
        save: async id => { await deps.save(id); fence = deps.context() },
        current: deps.current,
      })
      if (failed) return 'refused'
    }
    if (deps.context() !== fence) return 'refused'
    if (ticket !== latest) return 'superseded'
    deps.open(taskPushHref(target))
    return 'opened'
  }
  return (target: TaskPushTarget): Promise<TaskPushResult> => {
    const ticket = ++latest
    const next = queue.then(() => confirm(target, ticket))
    queue = next.catch(() => undefined)
    return next
  }
}

/** A task read refused before or after the request: shown as the server's own 404 for a task it will not show. */
export class TaskWorkspaceRefused extends Error {
  readonly status = 404
  readonly code = 'issueNotFound'
  constructor() { super('issueNotFound') }
}

export interface TaskReadDeps<T> {
  /** The workspace saved as the selection (the one the cookie carries), or null when there is none to send. */
  selected: () => Promise<string | null>
  context: () => number
  /** GET /api/mobile/tasks/{id} with the selection header. */
  read: (path: string, headers: Record<string, string>) => Promise<T>
}

/**
 * Reads a task opened from a push in the workspace it was confirmed in. It sends the selected workspace as
 * x-mikka-workspace-id, so the server refuses a task outside it (404 issueNotFound), and never the push's own field.
 * A selection that is not that workspace is refused without a request, and an answer that arrives after the selection
 * or context moved is dropped, so another workspace's detail is never shown.
 */
export async function readTaskInWorkspace<T>(issueId: string, workspaceId: string, deps: TaskReadDeps<T>): Promise<T> {
  const context = deps.context()
  const selected = await deps.selected()
  if (!selected || selected !== workspaceId) throw new TaskWorkspaceRefused()
  const value = await deps.read(`/api/mobile/tasks/${issueId}`, { [WORKSPACE_SELECTION_HEADER]: selected })
  if (deps.context() !== context || await deps.selected() !== selected) throw new TaskWorkspaceRefused()
  return value
}
