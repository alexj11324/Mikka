import { deleteE2BKey as deleteKey, getE2BKey as getKey, saveE2BKey as saveKey } from '@/app/actions/workspace-secrets'
import type { E2BKeyStatus } from '@/lib/secrets/e2b'
import type { SettingsActionResult } from '@/lib/workspace-admin/settings-action'

/*
 * The settings screens call #538's actions through this file only. Until each
 * backend point merges, the body below stands in for it; when it does, the
 * body becomes the real call with the same name and nothing else changes.
 */

/** #538 point 2: the key status says whether the workspace's own key is used (`MIKKA_BYO_E2B_KEY`). `null` until the backend says. */
export type E2BKeyStatusWithByo = E2BKeyStatus & { byoEnabled: boolean | null }

/** #538 point 3: whether this person may set the workspace key, whether BYO is on, and the key status. */
export interface E2BKeyCapability { canSet: boolean; byoEnabled: boolean | null; status: E2BKeyStatus }

/** #538 point 1: E2B key actions take the workspace the page shows. Today they act on the cookie's workspace. */
export async function getE2BKey(_workspaceId: string): Promise<SettingsActionResult<E2BKeyStatusWithByo>> {
  const result = await getKey()
  return result.error ? result : { ...result, byoEnabled: null }
}
export async function saveE2BKey(input: { apiKey: string }, _workspaceId: string): Promise<SettingsActionResult<E2BKeyStatus>> {
  return saveKey(input)
}
export async function deleteE2BKey(_workspaceId: string): Promise<SettingsActionResult<{ removed: boolean }>> {
  return deleteKey()
}

/** #538 point 3. Stand-in: the section is admin-only, so an admin is looking. */
export async function getE2BKeyCapability(workspaceId: string): Promise<SettingsActionResult<E2BKeyCapability>> {
  const result = await getE2BKey(workspaceId)
  if (result.error) return result
  const { byoEnabled, ...status } = result
  return { canSet: true, byoEnabled, status }
}

/** #538 point 4: deletes the person's own completion row, so the first-run guide shows again on the next load. */
export async function resetOnboarding(): Promise<void> {
  throw new Error('resetOnboarding is not available until #538 lands')
}
