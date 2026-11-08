import { selectedWorkspaceId } from '../workspace-selection'

/**
 * A per-call Workspace selection for one action request (#1661): the existing
 * `x-mikka-workspace-id` preference header (lib/workspace-selection.ts), which
 * the server checks against fresh membership like any other selection. It is
 * a preference, never an identity or a grant.
 *
 * The scope is synchronous: only an action call started inside `call` (its
 * request is built before the first await of callRemoteAction) carries it.
 */
let pinned: string | null = null

export function withWorkspaceSelection<T>(workspaceId: string, call: () => T): T {
  const id = selectedWorkspaceId(workspaceId)
  if (!id) throw new Error('workspace_selection_invalid')
  const previous = pinned
  pinned = id
  try { return call() } finally { pinned = previous }
}

/** Read once, synchronously, when an action call starts. */
export function pinnedWorkspaceSelection(): string | null { return pinned }
