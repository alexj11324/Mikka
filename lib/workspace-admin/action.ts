import { z } from 'zod'
import { ActionFailureError, runAction } from '@/lib/action-error'
import { ACTION_ERROR_CODES, type ActionErrorCode, type ActionResult } from '@/lib/action-result'
import { WorkspaceError } from '@/lib/workspace-access'

const codes = new Set<string>(ACTION_ERROR_CODES)
export const isActionErrorCode = (code: string): code is ActionErrorCode => codes.has(code)

/**
 * runAction for workspace settings: the shared workspace helpers throw
 * WorkspaceError(code) and zod errors, which become returned codes here.
 */
export function workspaceAction<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  return runAction(async () => {
    try {
      return await fn()
    } catch (error) {
      if (error instanceof WorkspaceError) throw new ActionFailureError(isActionErrorCode(error.code) ? error.code : 'generic')
      if (error instanceof z.ZodError) throw new ActionFailureError('validationGeneric')
      throw error
    }
  })
}
