import type { TaskPushTarget } from './push-route'
import { switchWorkspace } from './workspace-switch'

/** The request preference the server checks live (lib/workspace-selection.ts); never an identity or a grant. */
export const WORKSPACE_SELECTION_HEADER = 'x-mikka-workspace-id'

/** Where a confirmed task push opens: the task, marked with the workspace it was confirmed in, then its attempt. */
export function taskPushHref(target: TaskPushTarget): string {
  return `/task/${target.issueId}?workspace=${target.workspaceId}${target.runId ? `&attempt=${target.runId}` : ''}`
}

export type TaskPushResult = 'opened' | 'refused' | 'signedOut' | 'superseded' | 'stale'

/** The account and cache context (lib/api-cache.ts) an action owns; the context moves on every switch and sign-out. */
export type TaskPushOwner = { account: string; context: number }

export interface TaskPushDeps {
  /** The workspace the server has selected now: a fresh GET /api/mobile/settings. Throws when it cannot be read. */
  current: () => Promise<string>
  /**
   * Saves the pick the way 设置 › 工作区 does (lib/api.ts saveWorkspace), only while `owner` is still current. Returns
   * the context this save itself produced, or null when it wrote nothing or the context moved meanwhile.
   */
  save: (id: string, owner: TaskPushOwner) => Promise<number | null>
  /** The current account and context. */
  owner: () => TaskPushOwner
  open: (href: string) => void
  /**
   * Brief feedback after a stop (「无法确认工作区」). It never opens anything; `retry`, when given, taps the same push
   * again. Not called for a 401 (the app's sign-in handling takes over), a tap superseded by a newer one, or an action
   * stopped because the account or workspace changed under it.
   */
  unconfirmed: (retry?: () => void) => void
}

const status = (error: unknown) => error && typeof error === 'object' ? (error as { status?: unknown }).status : undefined
const same = (a: TaskPushOwner, b: TaskPushOwner) => a.account === b.account && a.context === b.context
/** Thrown inside the switch when the action no longer owns its context; it stops every later stage. */
const STALE = new Error('taskPushStale')

/**
 * Opens tapped task pushes in their own workspace (#1659 item 4), one at a time, in three steps:
 * 1. the target is captured from the push (pushTaskTarget);
 * 2. the workspace selection is read fresh and, when it is another workspace, switched through the existing switch
 *    (lib/workspace-switch.ts), which reads the selection back and restores the old one when the server refuses;
 * 3. only a confirmed selection opens the task.
 * Every stage is bound to the account and context the action owns. They are captured when the tap is accepted, not
 * when the queue reaches it, so a tap that waited behind another while the account or context moved stops before its
 * first read; its own save hands it the exact context that save produced, and nothing else does. A read that answers, or fails, after
 * the account or context moved (the person picked a workspace, another account was selected, a sign-out) stops the
 * action ('stale') before any save or rollback, so a stale action never writes a selection, never restores an old
 * `previous` into a new context and never opens. A refusal within the owned context still restores the previous pick.
 * A refused or unreadable confirmation stops: nothing opens and no other workspace is tried; the person sees
 * `unconfirmed` with a retry. A newer tap supersedes an older one, waiting or under way: the older one stops before
 * its next read, save or rollback and opens nothing. `invalid` refuses a push whose task target is malformed.
 */
export function taskPushOpener(deps: TaskPushDeps) {
  let latest = 0
  let queue: Promise<unknown> = Promise.resolve()
  const confirm = async (target: TaskPushTarget, ticket: number, tapped: TaskPushOwner): Promise<TaskPushResult> => {
    if (ticket !== latest) return 'superseded'
    if (!same(deps.owner(), tapped)) return 'stale'
    let owned = tapped
    let stale = false, signedOut = false, superseded = false
    const owns = () => {
      if (ticket !== latest) superseded = true
      return !stale && !superseded && same(deps.owner(), owned)
    }
    const current = async () => {
      const asked = owned
      if (!owns()) { stale = !superseded; throw STALE }
      try {
        const value = await deps.current()
        if (!owns() || !same(owned, asked)) { stale = !superseded; throw STALE }
        return value
      } catch (error) {
        if (error !== STALE) {
          if (!same(deps.owner(), asked)) stale = true
          else if (status(error) === 401) signedOut = true
        }
        throw error
      }
    }
    // The save and the switch's rollback alike: written only in the owned context, which then becomes the one it made.
    const save = async (id: string) => {
      if (!owns()) { stale = !superseded; throw STALE }
      const produced = await deps.save(id, owned)
      if (produced === null) { stale = true; throw STALE }
      owned = { account: owned.account, context: produced }
    }
    let selected: string
    try { selected = await current() } catch { return superseded ? 'superseded' : stale ? 'stale' : signedOut ? 'signedOut' : 'refused' }
    if (selected !== target.workspaceId) {
      const failed = await switchWorkspace({ id: target.workspaceId, name: '' }, selected, { save, current })
      if (superseded) return 'superseded'
      if (stale) return 'stale'
      if (signedOut) return 'signedOut'
      if (failed) return 'refused'
    }
    if (!owns()) return superseded ? 'superseded' : 'stale'
    deps.open(taskPushHref(target))
    return 'opened'
  }
  const open = (target: TaskPushTarget): Promise<TaskPushResult> => {
    const ticket = ++latest
    const tapped = deps.owner()
    const next = queue.then(() => confirm(target, ticket, tapped)).then(result => {
      // The feedback is after the stop and changes nothing about it.
      if (result === 'refused') deps.unconfirmed(() => { void open(target) })
      return result
    })
    queue = next.catch(() => undefined)
    return next
  }
  /** A push that names a workspace without a valid task target: nothing opens, and there is nothing to retry. */
  const invalid = (): TaskPushResult => {
    latest++
    deps.unconfirmed()
    return 'refused'
  }
  return { open, invalid }
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
