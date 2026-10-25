import type { ActionErrorCode, ActionErrorParams, ActionResult } from './action-result'
import { QuotaError } from './quota/errors'

export class ActionFailureError extends Error {
  constructor(readonly code: ActionErrorCode, readonly params?: ActionErrorParams) {
    super(code)
    this.name = 'ActionFailureError'
  }
}

/**
 * Converts an expected action failure into a returned code. Anything else is a
 * programming error and keeps propagating, so it still shows up in server logs.
 */
export async function runAction<T>(fn: () => Promise<T | ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await fn() as ActionResult<T>
  } catch (error) {
    if (error instanceof ActionFailureError) return { error: error.code, params: error.params }
    if (error instanceof QuotaError) return { error: 'generic', params: { quota: error.code, retryAfter: error.retryAfter } }
    throw error
  }
}
