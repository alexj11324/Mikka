import { z } from 'zod'

/** A request preference, never an identity or a credential's tenant grant. */
export const WORKSPACE_SELECTION_HEADER = 'x-mikka-workspace-id'

export function selectedWorkspaceId(value: unknown): string | null {
  const parsed = z.uuid().safeParse(value)
  return parsed.success ? parsed.data.toLowerCase() : null
}

export function workspaceSelection(headers?: Pick<Headers, 'get'>) {
  const value = headers?.get(WORKSPACE_SELECTION_HEADER)
  return value === null || value === undefined
    ? { present: false as const, workspaceId: null }
    : { present: true as const, workspaceId: selectedWorkspaceId(value) }
}
