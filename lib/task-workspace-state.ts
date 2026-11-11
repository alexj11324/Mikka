import { selectedWorkspaceId } from './workspace-selection'

/** The workspace a task belongs to, as the account menu reports it. */
export type TaskWorkspaceInfo = { id: string; name: string; kind: string }

/**
 * Where a task is created or fixed, as the UI can tell it (#1608, #1661):
 * - `loading`: the current workspace is not known yet, or the read predates
 *   the selection the server confirmed (it is being replaced).
 * - `error`: the current workspace could not be read.
 * - `mismatch`: the target (the dialog's or the task's workspace) is not the
 *   confirmed current one, e.g. another tab switched. `target.name` is null
 *   when the target is not among this account's workspaces.
 * - `ready`: the target is the current workspace (or there is no target and
 *   the current one applies).
 */
export type TaskWorkspaceState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'mismatch'; current: TaskWorkspaceInfo; target: { id: string; name: string | null } }
  | { status: 'ready'; workspace: TaskWorkspaceInfo }

type SwitcherRead = { workspace: TaskWorkspaceInfo; accounts?: readonly { choices: readonly { id: string; name: string }[] }[] }

/**
 * One rule for the dialog, the task properties and the create action's last
 * check. Ids compare through the header contract's normalization
 * (lib/workspace-selection.ts), so a valid id in another case is the same one.
 */
export function taskWorkspaceState({ data, error, target, confirmed }: {
  data?: SwitcherRead | null
  error?: unknown
  /** The workspace the task is created in or fixed to; none: the current one. */
  target?: string | null
  /** The selected server's confirmed choice (lib/web-connection/selection.ts); null when the server decides. */
  confirmed?: string | null
}): TaskWorkspaceState {
  if (!data) return error ? { status: 'error' } : { status: 'loading' }
  const current = data.workspace
  const currentId = selectedWorkspaceId(current.id) ?? current.id
  const confirmedId = confirmed ? selectedWorkspaceId(confirmed) : null
  if (confirmedId && confirmedId !== currentId) return error ? { status: 'error' } : { status: 'loading' }
  if (target === undefined || target === null || target === '') return { status: 'ready', workspace: current }
  const targetId = selectedWorkspaceId(target) ?? target
  if (targetId === currentId) return { status: 'ready', workspace: current }
  const known = data.accounts?.[0]?.choices.find(choice => (selectedWorkspaceId(choice.id) ?? choice.id) === targetId)
  return { status: 'mismatch', current, target: { id: targetId, name: known?.name ?? null } }
}
