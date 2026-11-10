import type { ActionErrorCode, ActionErrorParams, ActionResult } from './action-result'

export class ActionFailureError extends Error {
  constructor(readonly code: ActionErrorCode, readonly params?: ActionErrorParams,
    /** The caller may replay this exact action with `confirmAccess: true`. */
    readonly confirmable?: true) {
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
    if (error instanceof ActionFailureError) return { error: error.code, params: error.params, confirmable: error.confirmable }
    throw error
  }
}
