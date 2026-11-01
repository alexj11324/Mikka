import { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import { ACTION_ERROR_CODES, type ActionErrorCode, type ActionResult } from '@/lib/action-result'
import { WorkspaceError } from '@/lib/workspace-access'

/** Backend settings codes remain separate from the existing UI message catalogue. */
export const SETTINGS_ACTION_ERROR_CODES = [
  'secretNotFound', 'secretPermissionDenied', 'secretNameReserved', 'secretNameTaken',
  'secretLimitReached', 'secretsUnavailable', 'e2bKeyInvalid', 'e2bKeyUnverifiable',
  'e2bKeyRateLimited', 'botNotFound', 'tokenNotFound', 'tokenLimitReached',
  'apiKeyInvalid', 'apiKeyUnverifiable', 'apiKeyBaseUrlInvalid', 'apiKeyNotFound',
] as const
export type SettingsActionErrorCode = ActionErrorCode | typeof SETTINGS_ACTION_ERROR_CODES[number]
export type SettingsActionResult<T> = ActionResult<T, SettingsActionErrorCode>
const codes = new Set<string>([...ACTION_ERROR_CODES, ...SETTINGS_ACTION_ERROR_CODES])
const knownCode = (code: string): code is SettingsActionErrorCode => codes.has(code)

/** Preserves business codes and the existing auth/Zod handling; unexpected errors propagate. */
export async function settingsWorkspaceAction<T>(fn: () => Promise<T>): Promise<SettingsActionResult<T>> {
  try { return await fn() as T & { error?: undefined } }
  catch (error) {
    if (error instanceof ActionFailureError) return { error: error.code, params: error.params }
    if (error instanceof WorkspaceError) return { error: knownCode(error.code) ? error.code : 'generic' }
    if (error instanceof z.ZodError) return { error: 'validationGeneric' }
    throw error
  }
}
